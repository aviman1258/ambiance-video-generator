import type { AssetStore } from '../../core/assets.ts';
import { extensionFor } from '../../core/assets.ts';
import type { CostGuard } from '../../core/cost.ts';
import { type Db, now } from '../../core/db.ts';
import { imageInfo } from '../../core/imageInfo.ts';
import type { Logger } from '../../core/log.ts';
import type { ImageData, ImageGenerator } from '../../providers/types.ts';
import { buildImagePrompt, buildVariationPrompt, DEFAULT_STYLE_PRESET, STYLE_PRESETS } from './style.ts';

export type BatchStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';

export type ImageRow = {
  id: number;
  batch_id: number;
  file_path: string;
  sha256: string;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  saved: number;
  notes: string | null;
  created_at: string;
};

export type BatchRow = {
  id: number;
  scene_prompt: string;
  full_prompt: string;
  style_preset: string;
  parent_batch_id: number | null;
  reference_image_id: number | null;
  provider: string;
  model: string;
  requested_count: number;
  status: BatchStatus;
  error: string | null;
  created_at: string;
};

export type CreateBatchInput = {
  scenePrompt?: string;
  stylePreset?: string;
  /** "Regenerate" / "edit prompt": link the new batch to the one it came from. */
  parentBatchId?: number;
  /** "More like this": use an existing image as the visual reference. */
  referenceImageId?: number;
};

export class NotFoundError extends Error {
  readonly statusCode = 404;
}
export class BadRequestError extends Error {
  readonly statusCode = 400;
}

const CONCURRENCY = 3;

export class ImageService {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly generator: ImageGenerator;
  readonly cost: CostGuard;
  readonly log: Logger;
  readonly imagesPerBatch: number;
  readonly imageSize: '1K' | '2K' | '4K';

  constructor(deps: {
    db: Db;
    assets: AssetStore;
    generator: ImageGenerator;
    cost: CostGuard;
    log: Logger;
    imagesPerBatch: number;
    imageSize: '1K' | '2K' | '4K';
  }) {
    this.db = deps.db;
    this.assets = deps.assets;
    this.generator = deps.generator;
    this.cost = deps.cost;
    this.log = deps.log;
    this.imagesPerBatch = deps.imagesPerBatch;
    this.imageSize = deps.imageSize;
  }

  /** Validates, records the batch and returns it immediately; images arrive in the background. */
  createBatch(input: CreateBatchInput): { batch: BatchRow; done: Promise<void> } {
    const stylePreset = input.stylePreset ?? DEFAULT_STYLE_PRESET;
    if (!STYLE_PRESETS[stylePreset]) throw new BadRequestError(`Unknown style preset: ${stylePreset}`);
    if (input.parentBatchId !== undefined) this.getBatchRow(input.parentBatchId);

    let reference: ImageRow | undefined;
    let scenePrompt = input.scenePrompt?.trim() ?? '';
    if (input.referenceImageId !== undefined) {
      reference = this.getImageRow(input.referenceImageId);
      if (!scenePrompt) scenePrompt = this.getBatchRow(reference.batch_id).scene_prompt;
    }
    if (!scenePrompt) throw new BadRequestError('Describe the scene first');
    if (scenePrompt.length > 2000) throw new BadRequestError('Scene prompt is too long (2000 characters max)');

    const count = this.imagesPerBatch;
    this.cost.assertCanSpend(count * this.generator.costPerImageUsd, `${count} images`);

    const fullPrompt = reference ? buildVariationPrompt(scenePrompt, stylePreset) : buildImagePrompt(scenePrompt, stylePreset);
    const result = this.db
      .prepare(
        `INSERT INTO image_batches (scene_prompt, full_prompt, style_preset, parent_batch_id, reference_image_id,
           provider, model, requested_count, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        scenePrompt,
        fullPrompt,
        stylePreset,
        input.parentBatchId ?? null,
        reference?.id ?? null,
        this.generator.provider,
        this.generator.model,
        count,
        now(),
      );
    const batch = this.getBatchRow(Number(result.lastInsertRowid));
    const done = this.runBatch(batch, reference).catch((err: Error) => {
      this.log.error({ batchId: batch.id, err: err.message }, 'image batch crashed');
      this.db.prepare("UPDATE image_batches SET status = 'failed', error = ? WHERE id = ?").run(err.message, batch.id);
    });
    return { batch, done };
  }

  private async runBatch(batch: BatchRow, reference: ImageRow | undefined): Promise<void> {
    const referenceImages: ImageData[] = reference
      ? [{ bytes: await this.assets.read(reference.file_path), mimeType: reference.mime_type }]
      : [];
    const errors: string[] = [];
    let succeeded = 0;
    let next = 0;

    const worker = async () => {
      while (next < batch.requested_count) {
        next++;
        try {
          const image = await this.generator.generate({
            prompt: batch.full_prompt,
            referenceImages,
            aspectRatio: '16:9',
            size: this.imageSize,
          });
          await this.storeImage(batch, image);
          succeeded++;
        } catch (err) {
          errors.push((err as Error).message);
          this.log.warn({ batchId: batch.id, err: (err as Error).message }, 'image generation failed');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.requested_count) }, worker));

    const status: BatchStatus = succeeded === batch.requested_count ? 'succeeded' : succeeded > 0 ? 'partial' : 'failed';
    this.db
      .prepare('UPDATE image_batches SET status = ?, error = ? WHERE id = ?')
      .run(status, errors.length ? [...new Set(errors)].join('\n').slice(0, 2000) : null, batch.id);
    this.log.info({ batchId: batch.id, status, succeeded, failed: errors.length }, 'image batch finished');
  }

  private async storeImage(batch: BatchRow, image: ImageData): Promise<void> {
    const info = imageInfo(image.bytes);
    const mimeType = info.mimeType !== 'application/octet-stream' ? info.mimeType : image.mimeType;
    // File first, then the row, so a row never points at a missing file.
    const stored = await this.assets.put(image.bytes, extensionFor(mimeType));
    const res = this.db
      .prepare(
        `INSERT INTO images (batch_id, file_path, sha256, mime_type, bytes, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(batch.id, stored.relPath, stored.sha256, mimeType, stored.bytes, info.width ?? null, info.height ?? null, now());
    this.cost.record({
      provider: this.generator.provider,
      operation: 'image.generate',
      usd: this.generator.costPerImageUsd,
      refType: 'image',
      refId: Number(res.lastInsertRowid),
    });
  }

  /** Batches left "running" by a crash or restart can't be resumed; mark them so the UI doesn't spin forever. */
  markInterrupted(): number {
    const res = this.db
      .prepare("UPDATE image_batches SET status = 'interrupted', error = 'Server stopped before the batch finished' WHERE status = 'running'")
      .run();
    return Number(res.changes);
  }

  getBatch(id: number): BatchRow & { images: ImageRow[] } {
    return { ...this.getBatchRow(id), images: this.imagesForBatch(id) };
  }

  listBatches(limit = 20): (BatchRow & { images: ImageRow[] })[] {
    const rows = this.db.prepare('SELECT * FROM image_batches ORDER BY id DESC LIMIT ?').all(limit) as BatchRow[];
    return rows.map((b) => ({ ...b, images: this.imagesForBatch(b.id) }));
  }

  listSaved(): (ImageRow & { scene_prompt: string })[] {
    return this.db
      .prepare(
        `SELECT i.*, b.scene_prompt FROM images i JOIN image_batches b ON b.id = i.batch_id
         WHERE i.saved = 1 ORDER BY i.id DESC`,
      )
      .all() as (ImageRow & { scene_prompt: string })[];
  }

  updateImage(id: number, patch: { saved?: boolean; notes?: string | null }): ImageRow {
    this.getImageRow(id);
    if (patch.saved !== undefined) this.db.prepare('UPDATE images SET saved = ? WHERE id = ?').run(patch.saved ? 1 : 0, id);
    if (patch.notes !== undefined) this.db.prepare('UPDATE images SET notes = ? WHERE id = ?').run(patch.notes, id);
    return this.getImageRow(id);
  }

  getImageRow(id: number): ImageRow {
    const row = this.db.prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageRow | undefined;
    if (!row) throw new NotFoundError(`Image ${id} not found`);
    return row;
  }

  getBatchRow(id: number): BatchRow {
    const row = this.db.prepare('SELECT * FROM image_batches WHERE id = ?').get(id) as BatchRow | undefined;
    if (!row) throw new NotFoundError(`Batch ${id} not found`);
    return row;
  }

  private imagesForBatch(batchId: number): ImageRow[] {
    return this.db.prepare('SELECT * FROM images WHERE batch_id = ? ORDER BY id').all(batchId) as ImageRow[];
  }
}
