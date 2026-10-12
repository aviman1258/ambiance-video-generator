import type { AssetStore } from '../../core/assets.ts';
import type { CostGuard } from '../../core/cost.ts';
import { type Db, now } from '../../core/db.ts';
import type { Logger } from '../../core/log.ts';
import type { VideoGenerator } from '../../providers/types.ts';
import { BadRequestError, type ImageService, NotFoundError } from '../images/service.ts';
import { suggestMotionPrompt } from './motion.ts';

export type AnimationStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type AnimationRow = {
  id: number;
  image_id: number;
  motion_prompt: string;
  provider: string;
  model: string;
  duration_s: number;
  resolution: string;
  loop_mode: string;
  estimated_cost_usd: number;
  operation_id: string | null;
  status: AnimationStatus;
  file_path: string | null;
  starred: number;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type AnimationWithImage = AnimationRow & {
  image_thumb_path: string | null;
  image_preview_path: string | null;
  image_file_path: string;
  scene_prompt: string;
};

const WITH_IMAGE_SQL = `
  SELECT a.*, i.thumb_path AS image_thumb_path, i.preview_path AS image_preview_path,
         i.file_path AS image_file_path, b.scene_prompt
  FROM animations a JOIN images i ON i.id = a.image_id JOIN image_batches b ON b.id = i.batch_id`;

const DURATION_S = 8; // Veo renders 1080p only at 8 s
const RESOLUTION = '1080p';
const MAX_POLL_FAILURES = 5;

/**
 * Turns a chosen image into a short clip whose last frame is the image itself, so it loops.
 * State lives in SQLite: a restart resumes polling any in-flight operation instead of paying again.
 */
export class AnimationService {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly generator: VideoGenerator;
  readonly images: ImageService;
  readonly cost: CostGuard;
  readonly log: Logger;
  readonly pollIntervalMs: number;
  private readonly active = new Map<number, Promise<void>>();
  private stopped = false;

  constructor(deps: {
    db: Db;
    assets: AssetStore;
    generator: VideoGenerator;
    images: ImageService;
    cost: CostGuard;
    log: Logger;
    pollIntervalMs: number;
  }) {
    this.db = deps.db;
    this.assets = deps.assets;
    this.generator = deps.generator;
    this.images = deps.images;
    this.cost = deps.cost;
    this.log = deps.log;
    this.pollIntervalMs = deps.pollIntervalMs;
  }

  suggestMotion(imageId: number): string {
    const image = this.images.getImageRow(imageId);
    return suggestMotionPrompt(this.images.getBatchRow(image.batch_id).scene_prompt);
  }

  estimateCostUsd(): number {
    return this.generator.estimateCostUsd(DURATION_S);
  }

  /**
   * Starts an animation. If the same image + prompt is already in flight, returns that one
   * instead (protects against double clicks paying twice).
   */
  create(input: { imageId: number; motionPrompt?: string }): AnimationRow {
    this.images.getImageRow(input.imageId);
    const motionPrompt = input.motionPrompt?.trim() || this.suggestMotion(input.imageId);
    if (motionPrompt.length > 2000) throw new BadRequestError('Motion prompt is too long (2000 characters max)');

    const existing = this.db
      .prepare("SELECT * FROM animations WHERE image_id = ? AND motion_prompt = ? AND status IN ('pending', 'running')")
      .get(input.imageId, motionPrompt) as AnimationRow | undefined;
    if (existing) return existing;

    const estimate = this.estimateCostUsd();
    this.cost.assertCanSpend(estimate, 'This animation');
    const ts = now();
    const res = this.db
      .prepare(
        `INSERT INTO animations (image_id, motion_prompt, provider, model, duration_s, resolution, loop_mode,
           estimated_cost_usd, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'same-first-last', ?, 'pending', ?, ?)`,
      )
      .run(input.imageId, motionPrompt, this.generator.provider, this.generator.model, DURATION_S, RESOLUTION, estimate, ts, ts);
    const row = this.get(Number(res.lastInsertRowid));
    this.track(row.id, this.submitAndWatch(row));
    return row;
  }

  /** Call on startup: re-attach to operations that were in flight when the server stopped. */
  resumeInFlight(): number {
    const rows = this.db.prepare("SELECT * FROM animations WHERE status IN ('pending', 'running')").all() as AnimationRow[];
    for (const row of rows) {
      if (row.operation_id) {
        this.track(row.id, this.watch(row.id, row.operation_id));
      } else {
        // Crashed between saving the row and submitting; we can't know whether Google received it.
        this.fail(row.id, 'Server stopped before the request was confirmed. Check spend, then retry.');
      }
    }
    return rows.length;
  }

  get(id: number): AnimationRow {
    const row = this.db.prepare('SELECT * FROM animations WHERE id = ?').get(id) as AnimationRow | undefined;
    if (!row) throw new NotFoundError(`Animation ${id} not found`);
    return row;
  }

  listForImage(imageId: number): AnimationRow[] {
    return this.db.prepare('SELECT * FROM animations WHERE image_id = ? ORDER BY id DESC').all(imageId) as AnimationRow[];
  }

  /** Newest first, with the source image's thumbnail for the Animations tab. */
  listRecent(limit = 60): AnimationWithImage[] {
    return this.db
      .prepare(`${WITH_IMAGE_SQL} ORDER BY a.id DESC LIMIT ?`)
      .all(limit) as AnimationWithImage[];
  }

  getWithImage(id: number): AnimationWithImage {
    const row = this.db.prepare(`${WITH_IMAGE_SQL} WHERE a.id = ?`).get(id) as AnimationWithImage | undefined;
    if (!row) throw new NotFoundError(`Animation ${id} not found`);
    return row;
  }

  setStarred(id: number, starred: boolean): AnimationRow {
    this.get(id);
    this.db.prepare('UPDATE animations SET starred = ?, updated_at = ? WHERE id = ?').run(starred ? 1 : 0, now(), id);
    return this.get(id);
  }

  /** Resolves when every in-flight animation has settled (used by tests and shutdown). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active.values()]);
  }

  stop(): void {
    this.stopped = true;
  }

  private track(id: number, work: Promise<void>): void {
    const p = work
      .catch((err: Error) => {
        this.log.error({ animationId: id, err: err.message }, 'animation crashed');
        this.fail(id, err.message);
      })
      .finally(() => this.active.delete(id));
    this.active.set(id, p);
  }

  private async submitAndWatch(row: AnimationRow): Promise<void> {
    const image = this.images.getImageRow(row.image_id);
    const frame = { bytes: await this.assets.read(image.file_path), mimeType: image.mime_type };
    let operationId: string;
    try {
      ({ operationId } = await this.generator.start({
        prompt: row.motion_prompt,
        firstFrame: frame,
        lastFrame: frame,
        durationSeconds: DURATION_S,
        resolution: RESOLUTION,
      }));
    } catch (err) {
      this.fail(row.id, (err as Error).message);
      return;
    }
    this.db
      .prepare("UPDATE animations SET operation_id = ?, status = 'running', updated_at = ? WHERE id = ?")
      .run(operationId, now(), row.id);
    this.log.info({ animationId: row.id, operationId }, 'animation submitted');
    await this.watch(row.id, operationId);
  }

  private async watch(id: number, operationId: string): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      let status;
      try {
        status = await this.generator.check(operationId);
        failures = 0;
      } catch (err) {
        if (++failures >= MAX_POLL_FAILURES) {
          this.fail(id, `Lost track of the operation after ${failures} failed checks: ${(err as Error).message}`);
          return;
        }
        this.log.warn({ animationId: id, err: (err as Error).message }, 'poll failed, will retry');
        await delay(this.pollIntervalMs);
        continue;
      }

      if (status.state === 'running') {
        await delay(this.pollIntervalMs);
        continue;
      }
      if (status.state === 'failed') {
        this.fail(id, status.error);
        return;
      }

      const bytes = await this.generator.download(status.videoRef);
      const stored = await this.assets.put(bytes, 'mp4');
      const row = this.get(id);
      this.db
        .prepare("UPDATE animations SET status = 'succeeded', file_path = ?, error = NULL, updated_at = ? WHERE id = ?")
        .run(stored.relPath, now(), id);
      this.cost.record({
        provider: row.provider,
        operation: 'video.generate',
        usd: row.estimated_cost_usd,
        refType: 'animation',
        refId: id,
      });
      this.log.info({ animationId: id, bytes: stored.bytes }, 'animation finished');
      return;
    }
  }

  private fail(id: number, error: string): void {
    this.db
      .prepare("UPDATE animations SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error.slice(0, 2000), now(), id);
    this.log.warn({ animationId: id, error }, 'animation failed');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
