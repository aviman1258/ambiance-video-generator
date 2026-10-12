import { type AssetStore, removeOrphans } from '../../core/assets.ts';
import type { CostGuard } from '../../core/cost.ts';
import { type Db, now } from '../../core/db.ts';
import { joinClipsSilently } from '../../core/ffmpeg.ts';
import type { Logger } from '../../core/log.ts';
import { type ImageData, type MotionPlan, type MotionPlanner, ProviderError, type VideoGenerator } from '../../providers/types.ts';
import { BadRequestError, ConflictError, type ImageService, NotFoundError } from '../images/service.ts';
import { videoFrame } from '../images/renditions.ts';
import { keywordMotionPlan } from './motion.ts';

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
  operation_id: string | null; // only on older single-take animations
  status: AnimationStatus;
  file_path: string | null;
  starred: number;
  error: string | null;
  clip_count: number;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type ClipRow = {
  id: number;
  animation_id: number;
  idx: number;
  motion_prompt: string;
  estimated_cost_usd: number;
  operation_id: string | null;
  status: AnimationStatus;
  file_path: string | null;
  error: string | null;
  updated_at: string;
};

export type AnimationWithImage = AnimationRow & {
  image_thumb_path: string | null;
  image_preview_path: string | null;
  image_file_path: string;
  scene_prompt: string;
  clips_done: number;
};

export type PlanResult = MotionPlan & { source: 'vision' | 'keywords'; warning?: string };

const WITH_IMAGE_SQL = `
  SELECT a.*, i.thumb_path AS image_thumb_path, i.preview_path AS image_preview_path,
         i.file_path AS image_file_path, b.scene_prompt,
         (SELECT COUNT(*) FROM animation_clips c WHERE c.animation_id = a.id AND c.status = 'succeeded') AS clips_done
  FROM animations a JOIN images i ON i.id = a.image_id JOIN image_batches b ON b.id = i.batch_id`;

const CLIP_SECONDS = 8; // Veo renders 1080p only at 8 s
const RESOLUTION = '1080p';
const MAX_POLL_FAILURES = 5;
const MAX_SUBMIT_ATTEMPTS = 6; // for 429s: Google refused (and didn't bill) the request, so retrying is safe
const MAX_TAKES = 4;

/**
 * Turns an image into a loop made of several Veo "takes". Every take starts and ends on the image
 * itself, so the joins are seamless; the takes differ in motion so an hour of looping feels less
 * repetitive. Veo's audio is dropped when the takes are joined. State lives in SQLite: a restart
 * resumes polling in-flight takes instead of paying for them again.
 */
export class AnimationService {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly generator: VideoGenerator;
  readonly planner: MotionPlanner;
  readonly images: ImageService;
  readonly cost: CostGuard;
  readonly log: Logger;
  readonly pollIntervalMs: number;
  readonly takes: number;
  private readonly active = new Map<number, Promise<void>>();
  private stopped = false;

  constructor(deps: {
    db: Db;
    assets: AssetStore;
    generator: VideoGenerator;
    planner: MotionPlanner;
    images: ImageService;
    cost: CostGuard;
    log: Logger;
    pollIntervalMs: number;
    takes: number;
  }) {
    this.db = deps.db;
    this.assets = deps.assets;
    this.generator = deps.generator;
    this.planner = deps.planner;
    this.images = deps.images;
    this.cost = deps.cost;
    this.log = deps.log;
    this.pollIntervalMs = deps.pollIntervalMs;
    this.takes = deps.takes;
  }

  /** Cost of one whole animation (all takes). */
  estimateCostUsd(): number {
    return Math.round(this.takes * this.generator.estimateCostUsd(CLIP_SECONDS) * 10_000) / 10_000;
  }

  /**
   * The motion prompts for an image: Gemini's plan from looking at the picture, cached on the image.
   * If the planner fails, falls back to keyword prompts from the scene text (not cached, so the next
   * open tries Gemini again).
   */
  async planMotion(imageId: number, opts: { refresh?: boolean } = {}): Promise<PlanResult> {
    const image = this.images.getImageRow(imageId);
    const scenePrompt = this.images.getBatchRow(image.batch_id).scene_prompt;
    if (!opts.refresh) {
      const cached = this.cachedPlan(imageId);
      if (cached) return cached;
    }
    if (this.planner.provider === 'local') return { ...keywordMotionPlan(scenePrompt, this.takes), source: 'keywords' };

    try {
      const frame = await videoFrame(await this.assets.read(image.file_path));
      const plan = await this.planner.plan({ image: frame, scenePrompt, takes: this.takes });
      this.cost.record({ provider: this.planner.provider, operation: 'motion.plan', usd: this.planner.costPerCallUsd, refType: 'image', refId: imageId });
      const result: PlanResult = { ...plan, source: 'vision' };
      this.db.prepare('UPDATE images SET motion_plan = ? WHERE id = ?').run(JSON.stringify(result), imageId);
      return result;
    } catch (err) {
      this.log.warn({ imageId, err: (err as Error).message }, 'motion planning failed, using keywords');
      return { ...keywordMotionPlan(scenePrompt, this.takes), source: 'keywords', warning: `Gemini couldn't plan the motion: ${(err as Error).message}` };
    }
  }

  private cachedPlan(imageId: number): PlanResult | undefined {
    const row = this.db.prepare('SELECT motion_plan FROM images WHERE id = ?').get(imageId) as { motion_plan: string | null } | undefined;
    if (!row?.motion_plan) return undefined;
    try {
      const plan = JSON.parse(row.motion_plan) as PlanResult;
      return Array.isArray(plan.takes) && plan.takes.length === this.takes ? plan : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Starts an animation: one Veo take per prompt (default: the image's cached plan, else keyword
   * prompts). The same image + prompts already in flight returns that animation instead, so a double
   * tap can't pay twice.
   */
  create(input: { imageId: number; motionPrompts?: string[] }): AnimationRow {
    const image = this.images.getImageRow(input.imageId);
    let prompts = (input.motionPrompts ?? []).map((p) => p.trim()).filter(Boolean);
    if (prompts.length === 0) {
      prompts = this.cachedPlan(input.imageId)?.takes ?? keywordMotionPlan(this.images.getBatchRow(image.batch_id).scene_prompt, this.takes).takes;
    }
    if (prompts.length > MAX_TAKES) throw new BadRequestError(`At most ${MAX_TAKES} takes per animation`);
    if (prompts.some((p) => p.length > 2000)) throw new BadRequestError('A motion prompt is too long (2000 characters max)');
    const joined = prompts.join('\n\n');

    const existing = this.db
      .prepare("SELECT * FROM animations WHERE image_id = ? AND motion_prompt = ? AND status IN ('pending', 'running')")
      .get(input.imageId, joined) as AnimationRow | undefined;
    if (existing) return existing;

    const clipCost = this.generator.estimateCostUsd(CLIP_SECONDS);
    const estimate = Math.round(prompts.length * clipCost * 10_000) / 10_000;
    this.cost.assertCanSpend(estimate, 'This animation');
    const ts = now();
    this.db.exec('BEGIN');
    let id: number;
    try {
      const res = this.db
        .prepare(
          `INSERT INTO animations (image_id, motion_prompt, provider, model, duration_s, resolution, loop_mode,
             estimated_cost_usd, status, clip_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'same-first-last', ?, 'pending', ?, ?, ?)`,
        )
        .run(input.imageId, joined, this.generator.provider, this.generator.model, prompts.length * CLIP_SECONDS, RESOLUTION, estimate, prompts.length, ts, ts);
      id = Number(res.lastInsertRowid);
      const insertClip = this.db.prepare(
        `INSERT INTO animation_clips (animation_id, idx, motion_prompt, estimated_cost_usd, status, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      );
      prompts.forEach((prompt, idx) => insertClip.run(id, idx, prompt, clipCost, ts));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.track(id, this.run(id));
    return this.get(id);
  }

  /** Call on startup: re-attach to takes that were in flight when the server stopped. */
  resumeInFlight(): number {
    const rows = this.db.prepare("SELECT * FROM animations WHERE status IN ('pending', 'running')").all() as AnimationRow[];
    for (const row of rows) {
      const clips = this.clipsFor(row.id);
      if (clips.length === 0) {
        // Older single-take animation.
        if (row.operation_id) this.track(row.id, this.watchLegacy(row.id, row.operation_id));
        else this.fail(row.id, 'Server stopped before the request was confirmed. Check spend, then retry.');
        continue;
      }
      for (const clip of clips) {
        // Stopped between saving and submitting: we can't know if Google got it, so don't risk paying twice.
        if (clip.status === 'pending') this.failClip(clip.id, 'Server stopped before this take was submitted.');
      }
      this.track(row.id, this.watchAllThenJoin(row.id));
    }
    return rows.length;
  }

  get(id: number): AnimationRow {
    const row = this.db.prepare('SELECT * FROM animations WHERE id = ?').get(id) as AnimationRow | undefined;
    if (!row) throw new NotFoundError(`Animation ${id} not found`);
    return row;
  }

  clipsFor(animationId: number): ClipRow[] {
    return this.db.prepare('SELECT * FROM animation_clips WHERE animation_id = ? ORDER BY idx').all(animationId) as ClipRow[];
  }

  listForImage(imageId: number): AnimationRow[] {
    return this.db.prepare('SELECT * FROM animations WHERE image_id = ? ORDER BY id DESC').all(imageId) as AnimationRow[];
  }

  /** Newest first, with the source image's thumbnail, for the Animations tab. Failed ones are left out. */
  listRecent(limit = 60): AnimationWithImage[] {
    return this.db
      .prepare(`${WITH_IMAGE_SQL} WHERE a.status != 'failed' ORDER BY a.id DESC LIMIT ?`)
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

  /** Deletes a finished (or failed) animation, its takes and their files. In-progress ones can't be deleted. */
  async delete(id: number): Promise<void> {
    const row = this.get(id);
    if (row.status === 'pending' || row.status === 'running') {
      throw new ConflictError('This animation is still being made. Delete it once it finishes.');
    }
    const clipFiles = this.clipsFor(id).map((c) => c.file_path);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM animation_clips WHERE animation_id = ?').run(id);
      this.db.prepare('DELETE FROM animations WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    await removeOrphans(this.db, this.assets, [row.file_path, ...clipFiles]);
    this.log.info({ animationId: id }, 'animation deleted');
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

  private async run(id: number): Promise<void> {
    const row = this.get(id);
    const image = this.images.getImageRow(row.image_id);
    const frame = await videoFrame(await this.assets.read(image.file_path));
    this.db.prepare("UPDATE animations SET status = 'running', updated_at = ? WHERE id = ?").run(now(), id);
    // Submit one after another so a rate limit on take 2 doesn't waste take 1.
    for (const clip of this.clipsFor(id)) {
      if (this.stopped) return;
      if (clip.status === 'pending') await this.submitClip(clip, frame);
    }
    await this.watchAllThenJoin(id);
  }

  private async submitClip(clip: ClipRow, frame: ImageData): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const { operationId } = await this.generator.start({
          prompt: clip.motion_prompt,
          firstFrame: frame,
          lastFrame: frame,
          durationSeconds: CLIP_SECONDS,
          resolution: RESOLUTION,
        });
        this.db
          .prepare("UPDATE animation_clips SET operation_id = ?, status = 'running', updated_at = ? WHERE id = ?")
          .run(operationId, now(), clip.id);
        this.log.info({ animationId: clip.animation_id, take: clip.idx + 1, operationId }, 'take submitted');
        return;
      } catch (err) {
        const rateLimited = err instanceof ProviderError && err.status === 429 && err.retryable;
        if (rateLimited && attempt < MAX_SUBMIT_ATTEMPTS) {
          this.log.warn({ animationId: clip.animation_id, take: clip.idx + 1, attempt }, 'rate limited, waiting');
          await delay(this.pollIntervalMs * 2 * attempt);
          continue;
        }
        this.failClip(clip.id, (err as Error).message);
        return;
      }
    }
  }

  private async watchAllThenJoin(id: number): Promise<void> {
    await Promise.all(this.clipsFor(id).filter((c) => c.status === 'running' && c.operation_id).map((c) => this.watchClip(c)));
    if (!this.stopped) await this.join(id);
  }

  private async watchClip(clip: ClipRow): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      let status;
      try {
        status = await this.generator.check(clip.operation_id!);
        failures = 0;
      } catch (err) {
        if (++failures >= MAX_POLL_FAILURES) {
          this.failClip(clip.id, `Lost track of this take after ${failures} failed checks: ${(err as Error).message}`);
          return;
        }
        await delay(this.pollIntervalMs);
        continue;
      }
      if (status.state === 'running') {
        await delay(this.pollIntervalMs);
        continue;
      }
      if (status.state === 'failed') {
        this.failClip(clip.id, status.error);
        return;
      }
      const stored = await this.assets.put(await this.generator.download(status.videoRef), 'mp4');
      this.db
        .prepare("UPDATE animation_clips SET status = 'succeeded', file_path = ?, error = NULL, updated_at = ? WHERE id = ?")
        .run(stored.relPath, now(), clip.id);
      this.cost.record({ provider: this.generator.provider, operation: 'video.generate', usd: clip.estimated_cost_usd, refType: 'animation_clip', refId: clip.id });
      this.log.info({ animationId: clip.animation_id, take: clip.idx + 1 }, 'take finished');
      return;
    }
  }

  /** Joins every successful take, in order, into one silent loop. Partial success still gives a (shorter) loop. */
  private async join(id: number): Promise<void> {
    const clips = this.clipsFor(id);
    const good = clips.filter((c) => c.status === 'succeeded' && c.file_path);
    const bad = clips.filter((c) => c.status === 'failed');
    if (good.length === 0) {
      this.fail(id, bad[0]?.error ?? 'No takes finished');
      return;
    }
    const bytes = await joinClipsSilently(good.map((c) => this.assets.abs(c.file_path!)));
    const stored = await this.assets.put(bytes, 'mp4');
    const note = bad.length ? `${bad.length} of ${clips.length} takes failed, so this loop is shorter: ${bad[0]!.error}` : null;
    this.db
      .prepare("UPDATE animations SET status = 'succeeded', file_path = ?, duration_s = ?, note = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(stored.relPath, good.length * CLIP_SECONDS, note, now(), id);
    this.log.info({ animationId: id, takes: good.length, failed: bad.length }, 'animation joined');
  }

  /** Older single-take animations started before takes existed. */
  private async watchLegacy(id: number, operationId: string): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      let status;
      try {
        status = await this.generator.check(operationId);
        failures = 0;
      } catch (err) {
        if (++failures >= MAX_POLL_FAILURES) return this.fail(id, `Lost track of the operation: ${(err as Error).message}`);
        await delay(this.pollIntervalMs);
        continue;
      }
      if (status.state === 'running') {
        await delay(this.pollIntervalMs);
        continue;
      }
      if (status.state === 'failed') return this.fail(id, status.error);
      const stored = await this.assets.put(await this.generator.download(status.videoRef), 'mp4');
      const row = this.get(id);
      this.db.prepare("UPDATE animations SET status = 'succeeded', file_path = ?, error = NULL, updated_at = ? WHERE id = ?").run(stored.relPath, now(), id);
      this.cost.record({ provider: row.provider, operation: 'video.generate', usd: row.estimated_cost_usd, refType: 'animation', refId: id });
      return;
    }
  }

  private failClip(clipId: number, error: string): void {
    this.db.prepare("UPDATE animation_clips SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 2000), now(), clipId);
    this.log.warn({ clipId, error }, 'take failed');
  }

  private fail(id: number, error: string): void {
    this.db.prepare("UPDATE animations SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 2000), now(), id);
    this.log.warn({ animationId: id, error }, 'animation failed');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
