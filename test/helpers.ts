import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssetStore } from '../src/core/assets.ts';
import { CostGuard } from '../src/core/cost.ts';
import { type Db, openDb } from '../src/core/db.ts';
import { silentLogger } from '../src/core/log.ts';
import { KeywordMotionPlanner } from '../src/modules/animation/motion.ts';
import { AnimationService } from '../src/modules/animation/service.ts';
import { ImageService } from '../src/modules/images/service.ts';
import { encodePng } from '../src/providers/mock/png.ts';
import type { ImageData, ImageGenerator, ImageRequest, ImageTagger, MotionPlan, MotionPlanner, VideoGenerator, VideoRequest, VideoStatus } from '../src/providers/types.ts';

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ambiance-test-'));
}

/** Paid-looking image generator: each call costs $0.05 and can be told to fail. */
export class FakeImageGenerator implements ImageGenerator {
  readonly provider = 'fake';
  readonly model = 'fake-image';
  readonly costPerImageUsd = 0.05;
  calls: ImageRequest[] = [];
  failOnCalls = new Set<number>();

  async generate(req: ImageRequest): Promise<ImageData> {
    const n = this.calls.push(req);
    if (this.failOnCalls.has(n)) throw new Error(`fake failure on call ${n}`);
    return { bytes: encodePng(32, 18, () => [n * 20, 40, 80]), mimeType: 'image/png' };
  }
}

/** Vision-tagger stand-in: returns fixed tags (messy on purpose, to exercise normalizing) or fails. */
export class FakeTagger implements ImageTagger {
  readonly provider = 'fake';
  readonly model = 'fake-tagger';
  readonly costPerCallUsd = 0.001;
  tags = ['Kolkata', '#Rain', 'night', 'rain', 'warm light'];
  fail = false;
  calls = 0;

  async tag(): Promise<string[]> {
    this.calls++;
    if (this.fail) throw new Error('tagger down');
    return this.tags;
  }
}

/**
 * Video generator stand-in. Each operation reports "running" once, then succeeds with a real tiny
 * MP4 (so ffmpeg can join takes) unless it's listed in `failOps` (1-based start order).
 */
export class FakeVideoGenerator implements VideoGenerator {
  readonly provider = 'fake';
  readonly model = 'fake-video';
  starts: VideoRequest[] = [];
  failOps = new Map<number, string>();
  /** Errors thrown by the next start() calls, in order (then starts succeed). */
  startErrors: Error[] = [];
  private checks = new Map<string, number>();

  estimateCostUsd(durationSeconds: number): number {
    return durationSeconds * 0.12;
  }
  async start(req: VideoRequest): Promise<{ operationId: string }> {
    const err = this.startErrors.shift();
    if (err) throw err;
    this.starts.push(req);
    return { operationId: `operations/op-${this.starts.length}` };
  }
  async check(operationId: string): Promise<VideoStatus> {
    const n = (this.checks.get(operationId) ?? 0) + 1;
    this.checks.set(operationId, n);
    if (n === 1) return { state: 'running' };
    const index = Number(operationId.split('-').pop());
    const failure = this.failOps.get(index);
    return failure ? { state: 'failed', error: failure } : { state: 'succeeded', videoRef: operationId };
  }
  async download(): Promise<Buffer> {
    return fs.promises.readFile(new URL('../src/providers/mock/mock-clip.mp4', import.meta.url));
  }
}

/** Vision-planner stand-in: returns distinct takes, or fails. */
export class FakePlanner implements MotionPlanner {
  readonly provider = 'fake';
  readonly model = 'fake-planner';
  readonly costPerCallUsd = 0.002;
  calls = 0;
  fail = false;

  async plan(req: { takes: number }): Promise<MotionPlan> {
    this.calls++;
    if (this.fail) throw new Error('planner down');
    return {
      summary: 'Palm fronds sway and the pond ripples.',
      takes: Array.from({ length: req.takes }, (_, i) => `Static camera. Take ${i + 1}: palm fronds sway, the pond ripples gently. Buildings stay still.`),
    };
  }
}

export function makeServices(
  opts: {
    dir?: string;
    cap?: number;
    imageGen?: ImageGenerator;
    tagger?: ImageTagger;
    planner?: MotionPlanner;
    videoGen?: VideoGenerator;
    perBatch?: number;
    takes?: number;
  } = {},
) {
  const dir = opts.dir ?? tempDir();
  const db: Db = openDb(dir);
  const assets = new AssetStore(path.join(dir, 'assets'));
  const cost = new CostGuard(db, opts.cap ?? 10);
  const imageGen = opts.imageGen ?? new FakeImageGenerator();
  const tagger = opts.tagger ?? new FakeTagger();
  const planner = opts.planner ?? new KeywordMotionPlanner();
  const videoGen = opts.videoGen ?? new FakeVideoGenerator();
  const images = new ImageService({
    db,
    assets,
    generator: imageGen,
    tagger,
    cost,
    log: silentLogger,
    imagesPerBatch: opts.perBatch ?? 1,
    imageSize: '2K',
  });
  const animations = new AnimationService({
    db,
    assets,
    generator: videoGen,
    planner,
    images,
    cost,
    log: silentLogger,
    pollIntervalMs: 5,
    takes: opts.takes ?? 3,
  });
  return { dir, db, assets, cost, images, animations, imageGen, tagger, planner, videoGen };
}
