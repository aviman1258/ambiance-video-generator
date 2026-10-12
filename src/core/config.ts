import path from 'node:path';
import { z } from 'zod';

const EnvSchema = z
  .object({
    PROVIDERS: z.enum(['mock', 'google']).default('mock'),
    GEMINI_API_KEY: z.string().optional(),
    SPEND_CAP_USD: z.coerce.number().nonnegative().default(10),
    PORT: z.coerce.number().int().positive().default(4317),
    HOST: z.string().default('127.0.0.1'),
    DATA_DIR: z.string().default('./data'),
    IMAGES_PER_BATCH: z.coerce.number().int().min(1).max(12).default(6),
    IMAGE_MODEL: z.string().default('gemini-nano-banana-2.1'),
    IMAGE_SIZE: z.enum(['1K', '2K', '4K']).default('2K'),
    IMAGE_COST_USD: z.coerce.number().nonnegative().default(0.0504),
    VIDEO_MODEL: z.string().default('veo-3.1-fast-generate-preview'),
    VIDEO_COST_PER_SECOND_USD: z.coerce.number().nonnegative().default(0.12),
    VIDEO_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(10_000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .refine((env) => env.PROVIDERS !== 'google' || !!env.GEMINI_API_KEY, {
    message: 'GEMINI_API_KEY is required when PROVIDERS=google',
    path: ['GEMINI_API_KEY'],
  });

export type Config = {
  providers: 'mock' | 'google';
  geminiApiKey: string | undefined;
  spendCapUsd: number;
  port: number;
  host: string;
  dataDir: string;
  imagesPerBatch: number;
  imageModel: string;
  imageSize: '1K' | '2K' | '4K';
  imageCostUsd: number;
  videoModel: string;
  videoCostPerSecondUsd: number;
  videoPollIntervalMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (e.g. "GEMINI_API_KEY=" in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    providers: e.PROVIDERS,
    geminiApiKey: e.GEMINI_API_KEY,
    spendCapUsd: e.SPEND_CAP_USD,
    port: e.PORT,
    host: e.HOST,
    dataDir: path.resolve(e.DATA_DIR),
    imagesPerBatch: e.IMAGES_PER_BATCH,
    imageModel: e.IMAGE_MODEL,
    imageSize: e.IMAGE_SIZE,
    imageCostUsd: e.IMAGE_COST_USD,
    videoModel: e.VIDEO_MODEL,
    videoCostPerSecondUsd: e.VIDEO_COST_PER_SECOND_USD,
    videoPollIntervalMs: e.VIDEO_POLL_INTERVAL_MS,
    logLevel: e.LOG_LEVEL,
  };
}
