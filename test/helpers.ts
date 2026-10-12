import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssetStore } from '../src/core/assets.ts';
import { CostGuard } from '../src/core/cost.ts';
import { type Db, openDb } from '../src/core/db.ts';
import { silentLogger } from '../src/core/log.ts';
import { AnimationService } from '../src/modules/animation/service.ts';
import { ImageService } from '../src/modules/images/service.ts';
import { encodePng } from '../src/providers/mock/png.ts';
import type { ImageData, ImageGenerator, ImageRequest, VideoGenerator, VideoRequest, VideoStatus } from '../src/providers/types.ts';

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

/** Scriptable video generator: check() walks through the given statuses in order. */
export class FakeVideoGenerator implements VideoGenerator {
  readonly provider = 'fake';
  readonly model = 'fake-video';
  starts: VideoRequest[] = [];
  script: VideoStatus[] = [{ state: 'running' }, { state: 'succeeded', videoRef: 'ref-1' }];
  startError: Error | undefined;
  private checks = 0;

  estimateCostUsd(durationSeconds: number): number {
    return durationSeconds * 0.12;
  }
  async start(req: VideoRequest): Promise<{ operationId: string }> {
    if (this.startError) throw this.startError;
    this.starts.push(req);
    return { operationId: `operations/op-${this.starts.length}` };
  }
  async check(): Promise<VideoStatus> {
    const status = this.script[Math.min(this.checks, this.script.length - 1)]!;
    this.checks++;
    return status;
  }
  async download(): Promise<Buffer> {
    return Buffer.from('fake mp4 bytes');
  }
}

export function makeServices(opts: { dir?: string; cap?: number; imageGen?: ImageGenerator; videoGen?: VideoGenerator } = {}) {
  const dir = opts.dir ?? tempDir();
  const db: Db = openDb(dir);
  const assets = new AssetStore(path.join(dir, 'assets'));
  const cost = new CostGuard(db, opts.cap ?? 10);
  const imageGen = opts.imageGen ?? new FakeImageGenerator();
  const videoGen = opts.videoGen ?? new FakeVideoGenerator();
  const images = new ImageService({ db, assets, generator: imageGen, cost, log: silentLogger, imagesPerBatch: 6, imageSize: '2K' });
  const animations = new AnimationService({ db, assets, generator: videoGen, images, cost, log: silentLogger, pollIntervalMs: 5 });
  return { dir, db, assets, cost, images, animations, imageGen, videoGen };
}
