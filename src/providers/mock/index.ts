import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ImageData, ImageGenerator, ImageRequest, VideoGenerator, VideoStatus } from '../types.ts';
import { encodePng } from './png.ts';

/**
 * Free stand-in for the image API: a 16:9 "dusk scene" placeholder whose colours vary per call,
 * so a batch of 6 looks like 6 different candidates.
 */
export class MockImageGenerator implements ImageGenerator {
  readonly provider = 'mock';
  readonly model = 'mock-image';
  readonly costPerImageUsd = 0;
  private calls = 0;

  async generate(req: ImageRequest): Promise<ImageData> {
    const seed = hash(`${req.prompt}#${this.calls++}#${req.referenceImages?.length ?? 0}`);
    const hue = seed % 360;
    const [w, h] = [640, 360];
    const bytes = encodePng(w, h, (x, y) => {
      const sky = y / h;
      const window = x > w * 0.55 && x < w * 0.9 && y > h * 0.15 && y < h * 0.7;
      const rain = window && (x * 7 + y * 3 + seed) % 23 === 0;
      const lamp = Math.hypot(x - w * 0.25, y - h * 0.45) < 30;
      if (lamp) return [255, 210, 140];
      if (rain) return [200, 210, 230];
      const [r, g, b] = hsl(hue + (window ? 40 : 0), window ? 0.45 : 0.35, window ? 0.35 - sky * 0.15 : 0.18 + sky * 0.12);
      return [r, g, b];
    });
    return { bytes, mimeType: 'image/png' };
  }
}

/** Free stand-in for Veo: "finishes" after a short delay and returns a small placeholder clip. */
export class MockVideoGenerator implements VideoGenerator {
  readonly provider = 'mock';
  readonly model = 'mock-video';
  readonly completeAfterMs: number;
  private started = new Map<string, number>();

  constructor(opts: { completeAfterMs?: number } = {}) {
    this.completeAfterMs = opts.completeAfterMs ?? 3000;
  }

  estimateCostUsd(): number {
    return 0;
  }

  async start(): Promise<{ operationId: string }> {
    const operationId = `mock-op-${randomUUID()}`;
    this.started.set(operationId, Date.now());
    return { operationId };
  }

  async check(operationId: string): Promise<VideoStatus> {
    const startedAt = this.started.get(operationId);
    // Unknown id = started before a restart; treat it as done.
    if (startedAt !== undefined && Date.now() - startedAt < this.completeAfterMs) return { state: 'running' };
    return { state: 'succeeded', videoRef: 'mock-clip' };
  }

  async download(): Promise<Buffer> {
    return fs.promises.readFile(new URL('./mock-clip.mp4', import.meta.url));
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function hsl(hDeg: number, s: number, l: number): [number, number, number] {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255)) as [number, number, number];
}
