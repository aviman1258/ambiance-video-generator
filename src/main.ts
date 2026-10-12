import path from 'node:path';
import { AssetStore } from './core/assets.ts';
import { loadConfig } from './core/config.ts';
import { CostGuard } from './core/cost.ts';
import { openDb } from './core/db.ts';
import { AnimationService } from './modules/animation/service.ts';
import { ImageService } from './modules/images/service.ts';
import { createProviders } from './providers/index.ts';
import { buildApp } from './server/app.ts';

const config = loadConfig();
const db = openDb(config.dataDir);
const assets = new AssetStore(path.join(config.dataDir, 'assets'));
const cost = new CostGuard(db, config.spendCapUsd);
const providers = createProviders(config);

// Services log through Fastify's logger, so build them with a temporary reference and wire it after.
let app: Awaited<ReturnType<typeof buildApp>>;
const log = {
  info: (o: object, m?: string) => app.log.info(o, m),
  warn: (o: object, m?: string) => app.log.warn(o, m),
  error: (o: object, m?: string) => app.log.error(o, m),
};

const images = new ImageService({
  db,
  assets,
  generator: providers.images,
  cost,
  log,
  imagesPerBatch: config.imagesPerBatch,
  imageSize: config.imageSize,
});
const animations = new AnimationService({
  db,
  assets,
  generator: providers.videos,
  images,
  cost,
  log,
  pollIntervalMs: config.providers === 'mock' ? 1000 : config.videoPollIntervalMs,
});

app = await buildApp({ config, assets, cost, images, animations });

const interrupted = images.markInterrupted();
const resumed = animations.resumeInFlight();
app.log.info({ provider: config.providers, interruptedBatches: interrupted, resumedAnimations: resumed }, 'startup recovery done');

await app.listen({ port: config.port, host: config.host });
app.log.info(`Open http://${config.host}:${config.port} (${config.providers === 'mock' ? 'MOCK providers, free' : 'GOOGLE providers, paid'})`);

const shutdown = async () => {
  animations.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
