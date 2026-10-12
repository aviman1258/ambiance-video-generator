import type { AssetStore } from '../../core/assets.ts';
import { extensionFor, removeOrphans } from '../../core/assets.ts';
import type { CostGuard } from '../../core/cost.ts';
import { type Db, now } from '../../core/db.ts';
import { imageInfo } from '../../core/imageInfo.ts';
import type { Logger } from '../../core/log.ts';
import type { ImageData, ImageGenerator, ImageTagger } from '../../providers/types.ts';
import { makeRenditions } from './renditions.ts';
import { buildImagePrompt, buildVariationPrompt, DEFAULT_STYLE_PRESET, STYLE_PRESETS } from './style.ts';
import { keywordTags, normalizeTags } from './tags.ts';
import { sceneProblem } from '../../../web/scene-check.js';

export type BatchStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';

export type ImageRow = {
  id: number;
  batch_id: number;
  file_path: string;
  thumb_path: string | null;
  preview_path: string | null;
  sha256: string;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  saved: number;
  notes: string | null;
  created_at: string;
};

/** An image as the UI sees it: plus its scene, tags and how many finished animations it has. */
export type ImageListItem = ImageRow & { scene_prompt: string; tags: string[]; animation_count: number };

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
  /** "Generate another": link the new generation to the one it came from. */
  parentBatchId?: number;
  /** "More like this": use an existing image as the visual reference. */
  referenceImageId?: number;
};

export type ListImagesInput = { q?: string; limit?: number; offset?: number };

export class NotFoundError extends Error {
  readonly statusCode = 404;
}
export class BadRequestError extends Error {
  readonly statusCode = 400;
}
export class ConflictError extends Error {
  readonly statusCode = 409;
}

const CONCURRENCY = 3;

/**
 * Generates, stores, tags and finds images. A "batch" is one Generate click (one image by
 * default); it's kept internally for provenance and progress but the UI only shows images.
 */
export class ImageService {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly generator: ImageGenerator;
  readonly tagger: ImageTagger;
  readonly cost: CostGuard;
  readonly log: Logger;
  readonly imagesPerBatch: number;
  readonly imageSize: '1K' | '2K' | '4K';

  constructor(deps: {
    db: Db;
    assets: AssetStore;
    generator: ImageGenerator;
    tagger: ImageTagger;
    cost: CostGuard;
    log: Logger;
    imagesPerBatch: number;
    imageSize: '1K' | '2K' | '4K';
  }) {
    this.db = deps.db;
    this.assets = deps.assets;
    this.generator = deps.generator;
    this.tagger = deps.tagger;
    this.cost = deps.cost;
    this.log = deps.log;
    this.imagesPerBatch = deps.imagesPerBatch;
    this.imageSize = deps.imageSize;
  }

  /** Estimated cost of one Generate click. */
  generationCostUsd(): number {
    const usd = this.imagesPerBatch * (this.generator.costPerImageUsd + this.tagger.costPerCallUsd);
    return Math.round(usd * 10_000) / 10_000;
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
    // Typed prompts only; a "more like this" reuses an existing image's prompt as-is.
    const problem = reference ? null : sceneProblem(scenePrompt);
    if (problem) throw new BadRequestError(problem);

    const count = this.imagesPerBatch;
    this.cost.assertCanSpend(this.generationCostUsd(), count === 1 ? 'An image' : `${count} images`);

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
    // Files first, then the row, so a row never points at a missing file.
    const stored = await this.assets.put(image.bytes, extensionFor(mimeType));
    const { thumbPath, previewPath } = await this.storeRenditions(image.bytes);
    const res = this.db
      .prepare(
        `INSERT INTO images (batch_id, file_path, thumb_path, preview_path, sha256, mime_type, bytes, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batch.id,
        stored.relPath,
        thumbPath,
        previewPath,
        stored.sha256,
        mimeType,
        stored.bytes,
        info.width ?? null,
        info.height ?? null,
        now(),
      );
    const imageId = Number(res.lastInsertRowid);
    this.cost.record({
      provider: this.generator.provider,
      operation: 'image.generate',
      usd: this.generator.costPerImageUsd,
      refType: 'image',
      refId: imageId,
    });
    await this.autoTag(imageId, { bytes: image.bytes, mimeType }, batch.scene_prompt);
  }

  private async storeRenditions(original: Buffer): Promise<{ thumbPath: string | null; previewPath: string | null }> {
    try {
      const { thumb, preview } = await makeRenditions(original);
      const [t, p] = await Promise.all([this.assets.put(thumb, 'webp'), this.assets.put(preview, 'webp')]);
      return { thumbPath: t.relPath, previewPath: p.relPath };
    } catch (err) {
      // The page falls back to the original, so a rendition failure shouldn't lose the image.
      this.log.warn({ err: (err as Error).message }, 'could not make thumbnail/preview');
      return { thumbPath: null, previewPath: null };
    }
  }

  /** Vision tags from the tagger; on any failure, free keyword tags from the prompt instead. */
  private async autoTag(imageId: number, image: ImageData, scenePrompt: string): Promise<void> {
    let tags: string[];
    try {
      tags = normalizeTags(await this.tagger.tag({ image, scenePrompt }));
      this.cost.record({
        provider: this.tagger.provider,
        operation: 'image.tag',
        usd: this.tagger.costPerCallUsd,
        refType: 'image',
        refId: imageId,
      });
      if (tags.length === 0) tags = keywordTags(scenePrompt);
    } catch (err) {
      this.log.warn({ imageId, err: (err as Error).message }, 'tagging failed, using prompt keywords');
      tags = keywordTags(scenePrompt);
    }
    this.writeTags(imageId, tags);
  }

  /**
   * On startup: give older images (from before thumbnails/tags existed) a thumbnail, preview and
   * keyword tags. Free: never calls a paid API.
   */
  async backfill(): Promise<{ renditions: number; tagged: number }> {
    const missingRenditions = this.db.prepare('SELECT * FROM images WHERE thumb_path IS NULL').all() as ImageRow[];
    for (const img of missingRenditions) {
      const { thumbPath, previewPath } = await this.storeRenditions(await this.assets.read(img.file_path));
      if (thumbPath) this.db.prepare('UPDATE images SET thumb_path = ?, preview_path = ? WHERE id = ?').run(thumbPath, previewPath, img.id);
    }
    const untagged = this.db
      .prepare(
        `SELECT i.id, b.scene_prompt FROM images i JOIN image_batches b ON b.id = i.batch_id
         WHERE NOT EXISTS (SELECT 1 FROM image_tags t WHERE t.image_id = i.id)`,
      )
      .all() as { id: number; scene_prompt: string }[];
    for (const row of untagged) this.writeTags(row.id, keywordTags(row.scene_prompt));
    return { renditions: missingRenditions.length, tagged: untagged.length };
  }

  /** Batches left "running" by a crash or restart can't be resumed; mark them so the UI doesn't spin forever. */
  markInterrupted(): number {
    const res = this.db
      .prepare("UPDATE image_batches SET status = 'interrupted', error = 'Server stopped before the image finished' WHERE status = 'running'")
      .run();
    return Number(res.changes);
  }

  getBatch(id: number): BatchRow & { images: ImageRow[] } {
    return {
      ...this.getBatchRow(id),
      images: this.db.prepare('SELECT * FROM images WHERE batch_id = ? ORDER BY id').all(id) as ImageRow[],
    };
  }

  /** Newest first. Every search term must match the start of a word in at least one of the image's tags. */
  listImages(input: ListImagesInput = {}): { items: ImageListItem[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    for (const term of searchTerms(input.q)) {
      where.push(
        `EXISTS (SELECT 1 FROM image_tags t WHERE t.image_id = i.id AND (t.tag LIKE ? ESCAPE '\\' OR t.tag LIKE ? ESCAPE '\\'))`,
      );
      const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
      params.push(`${escaped}%`, `% ${escaped}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM images i ${whereSql}`).get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT i.*, b.scene_prompt,
           (SELECT COUNT(*) FROM animations a WHERE a.image_id = i.id AND a.status = 'succeeded') AS animation_count
         FROM images i JOIN image_batches b ON b.id = i.batch_id
         ${whereSql} ORDER BY i.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, input.limit ?? 60, input.offset ?? 0) as (ImageRow & { scene_prompt: string; animation_count: number })[];
    return { items: rows.map((r) => ({ ...r, tags: this.tagsFor(r.id) })), total };
  }

  /** Everything the image page needs. */
  getImageDetail(id: number): ImageListItem & { full_prompt: string; style_preset: string; reference_image_id: number | null } {
    const row = this.db
      .prepare(
        `SELECT i.*, b.scene_prompt, b.full_prompt, b.style_preset, b.reference_image_id,
           (SELECT COUNT(*) FROM animations a WHERE a.image_id = i.id AND a.status = 'succeeded') AS animation_count
         FROM images i JOIN image_batches b ON b.id = i.batch_id WHERE i.id = ?`,
      )
      .get(id) as
      | (ImageRow & { scene_prompt: string; full_prompt: string; style_preset: string; reference_image_id: number | null; animation_count: number })
      | undefined;
    if (!row) throw new NotFoundError(`Image ${id} not found`);
    return { ...row, tags: this.tagsFor(id) };
  }

  /** Most-used tags, for the quick-filter chips. */
  listTags(limit = 40): { tag: string; count: number }[] {
    const rows = this.db
      .prepare('SELECT tag, COUNT(*) AS count FROM image_tags GROUP BY tag ORDER BY count DESC, tag LIMIT ?')
      .all(limit) as { tag: string; count: number }[];
    return rows.map(({ tag, count }) => ({ tag, count }));
  }

  updateImage(id: number, patch: { notes?: string | null; tags?: string[] }): ImageRow {
    this.getImageRow(id);
    if (patch.notes !== undefined) this.db.prepare('UPDATE images SET notes = ? WHERE id = ?').run(patch.notes, id);
    if (patch.tags !== undefined) this.writeTags(id, normalizeTags(patch.tags));
    return this.getImageRow(id);
  }

  /**
   * Deletes an image, its tags and its animations, plus any files nothing else uses. Refused while
   * one of its animations is still being made (Google would keep billing for it either way).
   * Cost-ledger rows stay: they're the spending history.
   */
  async deleteImage(id: number): Promise<void> {
    const image = this.getImageRow(id);
    const busy = this.db
      .prepare("SELECT COUNT(*) AS n FROM animations WHERE image_id = ? AND status IN ('pending', 'running')")
      .get(id) as { n: number };
    if (busy.n > 0) throw new ConflictError('This image is still being animated. Delete it once the animation finishes.');

    const clips = (this.db.prepare('SELECT file_path FROM animations WHERE image_id = ?').all(id) as { file_path: string | null }[]).map(
      (r) => r.file_path,
    );
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM animations WHERE image_id = ?').run(id);
      this.db.prepare('DELETE FROM image_tags WHERE image_id = ?').run(id);
      // "More like this" generations keep their own images; they just lose the link to this one.
      this.db.prepare('UPDATE image_batches SET reference_image_id = NULL WHERE reference_image_id = ?').run(id);
      this.db.prepare('DELETE FROM images WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    await removeOrphans(this.db, this.assets, [image.file_path, image.thumb_path, image.preview_path, ...clips]);
    this.log.info({ imageId: id, animations: clips.length }, 'image deleted');
  }

  tagsFor(imageId: number): string[] {
    return (this.db.prepare('SELECT tag FROM image_tags WHERE image_id = ? ORDER BY rowid').all(imageId) as { tag: string }[]).map(
      (r) => r.tag,
    );
  }

  getImageRow(id: number): ImageRow {
    const row = this.db.prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageRow | undefined;
    if (!row) throw new NotFoundError(`Image ${id} not found`);
    return row;
  }

  getBatchRow(id: number): BatchRow {
    const row = this.db.prepare('SELECT * FROM image_batches WHERE id = ?').get(id) as BatchRow | undefined;
    if (!row) throw new NotFoundError(`Generation ${id} not found`);
    return row;
  }

  /** Replaces an image's tags in one transaction. */
  private writeTags(imageId: number, tags: string[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM image_tags WHERE image_id = ?').run(imageId);
      const insert = this.db.prepare('INSERT OR IGNORE INTO image_tags (image_id, tag) VALUES (?, ?)');
      for (const tag of tags) insert.run(imageId, tag);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

function searchTerms(q: string | undefined): string[] {
  return [...new Set((q ?? '').toLowerCase().split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean))].slice(0, 8);
}
