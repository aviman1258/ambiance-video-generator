import type { AssetStore } from '../../core/assets.ts';
import type { CostGuard } from '../../core/cost.ts';
import { type Db, now } from '../../core/db.ts';
import type { Logger } from '../../core/log.ts';
import type { SoundGenerator, SoundLayerPlan } from '../../providers/types.ts';

export type SoundRow = {
  id: number;
  category: string;
  tags: string;
  description: string;
  duration_s: number | null;
  provider: string;
  model: string;
  file_path: string;
  license: string;
  cost_usd: number;
  use_count: number;
  created_at: string;
};

// How alike two tag sets must be (same category, Jaccard over tags) to reuse a sound.
const REUSE_THRESHOLD = 0.34;

/**
 * Every generated ambient sound is kept and reused: a layer first looks for a close match in the
 * library (same category, overlapping tags) and only generates when there isn't one, so each kind
 * of sound is paid for once.
 */
export class SoundLibrary {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly generator: SoundGenerator;
  readonly cost: CostGuard;
  readonly log: Logger;
  readonly seconds: number;

  constructor(deps: { db: Db; assets: AssetStore; generator: SoundGenerator; cost: CostGuard; log: Logger; seconds: number }) {
    this.db = deps.db;
    this.assets = deps.assets;
    this.generator = deps.generator;
    this.cost = deps.cost;
    this.log = deps.log;
    this.seconds = deps.seconds;
  }

  findMatch(layer: Pick<SoundLayerPlan, 'category' | 'tags'>): SoundRow | undefined {
    const rows = this.db.prepare('SELECT * FROM sounds WHERE category = ?').all(layer.category) as SoundRow[];
    const want = new Set(layer.tags.map((t) => t.toLowerCase()));
    let best: { row: SoundRow; score: number } | undefined;
    for (const row of rows) {
      const have = new Set(row.tags.split(' ').filter(Boolean));
      const overlap = [...want].filter((t) => have.has(t)).length;
      const union = new Set([...want, ...have]).size || 1;
      const score = overlap / union;
      // Prefer the closer match; on a tie, the less-used sound, for variety.
      if (score >= REUSE_THRESHOLD && (!best || score > best.score || (score === best.score && row.use_count < best.row.use_count))) {
        best = { row, score };
      }
    }
    return best?.row;
  }

  /** How many of these layers would need generating (for the cost estimate before starting). */
  missingCount(layers: SoundLayerPlan[]): number {
    return layers.filter((l) => !this.findMatch(l)).length;
  }

  estimateNewSoundsUsd(layers: SoundLayerPlan[]): number {
    return this.missingCount(layers) * this.generator.costPerSoundUsd;
  }

  /** Returns a library sound for the layer, generating (and paying for) one only if none matches. */
  async ensure(layer: SoundLayerPlan): Promise<SoundRow> {
    const existing = this.findMatch(layer);
    if (existing) {
      this.db.prepare('UPDATE sounds SET use_count = use_count + 1 WHERE id = ?').run(existing.id);
      return existing;
    }
    this.cost.assertCanSpend(this.generator.costPerSoundUsd, 'A new sound');
    const { bytes, ext } = await this.generator.generate({ prompt: layer.description, seconds: this.seconds });
    const stored = await this.assets.put(bytes, ext);
    const res = this.db
      .prepare(
        `INSERT INTO sounds (category, tags, description, duration_s, provider, model, file_path, license, cost_usd, use_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        layer.category,
        layer.tags.map((t) => t.toLowerCase()).join(' '),
        layer.description,
        this.seconds,
        this.generator.provider,
        this.generator.model,
        stored.relPath,
        this.generator.license,
        this.generator.costPerSoundUsd,
        now(),
      );
    const id = Number(res.lastInsertRowid);
    this.cost.record({ provider: this.generator.provider, operation: 'sound.generate', usd: this.generator.costPerSoundUsd, refType: 'sound', refId: id });
    this.log.info({ soundId: id, category: layer.category }, 'sound generated');
    return this.db.prepare('SELECT * FROM sounds WHERE id = ?').get(id) as SoundRow;
  }

  list(): SoundRow[] {
    return this.db.prepare('SELECT * FROM sounds ORDER BY id DESC').all() as SoundRow[];
  }
}
