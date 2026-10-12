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
    APP_PASSWORD: z.string().min(12, 'APP_PASSWORD must be at least 12 characters').optional(),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters').optional(),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  })
  .refine((env) => env.PROVIDERS !== 'google' || !!env.GEMINI_API_KEY, {
    message: 'GEMINI_API_KEY is required when PROVIDERS=google',
    path: ['GEMINI_API_KEY'],
  })
  .refine((env) => isLoopback(env.HOST) || (!!env.APP_PASSWORD && !!env.SESSION_SECRET), {
    message: 'APP_PASSWORD and SESSION_SECRET are required when HOST is not localhost (the page would be open to anyone)',
    path: ['APP_PASSWORD'],
  })
  .refine((env) => !env.APP_PASSWORD || !!env.SESSION_SECRET, {
    message: 'SESSION_SECRET is required when APP_PASSWORD is set',
    path: ['SESSION_SECRET'],
  });

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

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
  /** When set, the whole app sits behind a password login. */
  auth: { password: string; secret: string } | undefined;
  /** Number of proxy hops to trust for the client IP / protocol (Render: 1). */
  trustProxy: number;
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
    auth: e.APP_PASSWORD && e.SESSION_SECRET ? { password: e.APP_PASSWORD, secret: e.SESSION_SECRET } : undefined,
    trustProxy: e.TRUST_PROXY,
  };
}
