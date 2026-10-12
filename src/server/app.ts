import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssetStore } from '../core/assets.ts';
import type { Config } from '../core/config.ts';
import type { CostGuard } from '../core/cost.ts';
import type { AnimationRow, AnimationService } from '../modules/animation/service.ts';
import type { ImageRow, ImageService } from '../modules/images/service.ts';
import { STYLE_PRESETS } from '../modules/images/style.ts';

export type AppDeps = {
  config: Pick<Config, 'providers' | 'imageModel' | 'videoModel' | 'imagesPerBatch' | 'logLevel'>;
  assets: AssetStore;
  cost: CostGuard;
  images: ImageService;
  animations: AnimationService;
  logger?: boolean;
};

const Id = z.coerce.number().int().positive();
const IdParams = z.object({ id: Id });

const CreateBatchBody = z.object({
  scenePrompt: z.string().max(2000).optional(),
  stylePreset: z.string().optional(),
  parentBatchId: Id.optional(),
  referenceImageId: Id.optional(),
});
const PatchImageBody = z.object({ saved: z.boolean().optional(), notes: z.string().max(2000).nullable().optional() });
const CreateAnimationBody = z.object({ imageId: Id, motionPrompt: z.string().max(2000).optional() });
const PatchAnimationBody = z.object({ starred: z.boolean() });

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger === false ? false : { level: deps.config.logLevel } });
  const { images, animations, cost, assets, config } = deps;

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: err.message });
  });

  // Generated files, served with range support so <video> can seek and loop.
  await app.register(fastifyStatic, { root: assets.root, prefix: '/assets/', decorateReply: false, maxAge: '30d', immutable: true });
  // The page itself.
  await app.register(fastifyStatic, { root: path.resolve(import.meta.dirname, '../../web'), prefix: '/' });

  const withUrl = (img: ImageRow) => ({ ...img, saved: !!img.saved, url: `/assets/${img.file_path}` });
  const animationView = (a: AnimationRow) => ({ ...a, starred: !!a.starred, url: a.file_path ? `/assets/${a.file_path}` : null });

  app.get('/api/config', async () => ({
    provider: config.providers,
    imageModel: images.generator.model,
    videoModel: animations.generator.model,
    imagesPerBatch: config.imagesPerBatch,
    batchCostUsd: config.imagesPerBatch * images.generator.costPerImageUsd,
    animationCostUsd: animations.estimateCostUsd(),
    stylePresets: Object.values(STYLE_PRESETS).map(({ id, label }) => ({ id, label })),
    spend: cost.summary(),
  }));

  app.get('/api/batches', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    return images.listBatches(limit).map((b) => ({ ...b, images: b.images.map(withUrl) }));
  });

  app.post('/api/batches', async (req, reply) => {
    const body = CreateBatchBody.parse(req.body ?? {});
    const { batch } = images.createBatch(body);
    return reply.code(202).send({ ...batch, images: [] });
  });

  app.get('/api/batches/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const batch = images.getBatch(id);
    return { ...batch, images: batch.images.map(withUrl) };
  });

  app.get('/api/images/saved', async () => images.listSaved().map(withUrl));

  app.get('/api/images/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const image = images.getImageRow(id);
    return { ...withUrl(image), scene_prompt: images.getBatchRow(image.batch_id).scene_prompt };
  });

  app.patch('/api/images/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return withUrl(images.updateImage(id, PatchImageBody.parse(req.body ?? {})));
  });

  app.get('/api/images/:id/motion-suggestion', async (req) => {
    const { id } = IdParams.parse(req.params);
    return { motionPrompt: animations.suggestMotion(id) };
  });

  app.get('/api/animations', async (req) => {
    const { imageId } = z.object({ imageId: Id.optional() }).parse(req.query);
    return (imageId ? animations.listForImage(imageId) : animations.listRecent()).map(animationView);
  });

  app.post('/api/animations', async (req, reply) => {
    const row = animations.create(CreateAnimationBody.parse(req.body ?? {}));
    return reply.code(202).send(animationView(row));
  });

  app.get('/api/animations/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return animationView(animations.get(id));
  });

  app.patch('/api/animations/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return animationView(animations.setStarred(id, PatchAnimationBody.parse(req.body ?? {}).starred));
  });

  app.get('/api/spend', async () => cost.summary());

  return app;
}
