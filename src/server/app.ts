import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssetStore } from '../core/assets.ts';
import type { Config } from '../core/config.ts';
import type { CostGuard } from '../core/cost.ts';
import type { AnimationRow, AnimationService, AnimationWithImage } from '../modules/animation/service.ts';
import type { ImageRow, ImageService } from '../modules/images/service.ts';
import { STYLE_PRESETS } from '../modules/images/style.ts';
import { registerAuth } from './auth.ts';

export type AppDeps = {
  config: Pick<Config, 'providers' | 'imageModel' | 'videoModel' | 'imagesPerBatch' | 'logLevel'> &
    Partial<Pick<Config, 'auth' | 'trustProxy'>>;
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
const PatchImageBody = z.object({
  notes: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
});
const ListImagesQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).default(0),
});
const CreateAnimationBody = z.object({
  imageId: Id,
  motionPrompts: z.array(z.string().max(2000)).max(4).optional(),
  motionPrompt: z.string().max(2000).optional(), // older clients: a single take
});
const PatchAnimationBody = z.object({ starred: z.boolean() });

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger === false ? false : { level: deps.config.logLevel },
    // Trust the nearest N proxy hops (Render's load balancer) for the client IP and https.
    trustProxy: (_address: string, hop: number) => hop < (deps.config.trustProxy ?? 0),
  });
  const { images, animations, cost, assets, config } = deps;

  app.get('/api/health', async () => ({ ok: true }));
  if (config.auth) registerAuth(app, config.auth);

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

  const withUrl = <T extends ImageRow>(img: T) => ({
    ...img,
    url: `/assets/${img.file_path}`,
    thumbUrl: `/assets/${img.thumb_path ?? img.file_path}`,
    previewUrl: `/assets/${img.preview_path ?? img.file_path}`,
  });
  const animationView = (a: AnimationRow & Partial<AnimationWithImage>) => ({
    ...a,
    starred: !!a.starred,
    url: a.file_path ? `/assets/${a.file_path}` : null,
    ...(a.image_file_path
      ? {
          imageThumbUrl: `/assets/${a.image_thumb_path ?? a.image_file_path}`,
          imagePreviewUrl: `/assets/${a.image_preview_path ?? a.image_file_path}`,
        }
      : {}),
  });

  app.get('/api/config', async () => ({
    provider: config.providers,
    authEnabled: !!config.auth,
    imageModel: images.generator.model,
    videoModel: animations.generator.model,
    imagesPerBatch: config.imagesPerBatch,
    generationCostUsd: images.generationCostUsd(),
    animationCostUsd: animations.estimateCostUsd(),
    animationTakes: animations.takes,
    stylePresets: Object.values(STYLE_PRESETS).map(({ id, label }) => ({ id, label })),
    spend: cost.summary(),
  }));

  // A generation = one Generate click. Start it, then poll until it's no longer "running".
  app.post('/api/generations', async (req, reply) => {
    const body = CreateBatchBody.parse(req.body ?? {});
    const { batch } = images.createBatch(body);
    return reply.code(202).send({ ...batch, images: [] });
  });

  app.get('/api/generations/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const batch = images.getBatch(id);
    return { ...batch, images: batch.images.map(withUrl) };
  });

  app.get('/api/images', async (req) => {
    const query = ListImagesQuery.parse(req.query);
    const { items, total } = images.listImages({ q: query.q, limit: query.limit, offset: query.offset });
    return { items: items.map(withUrl), total };
  });

  app.get('/api/tags', async () => images.listTags());

  app.get('/api/images/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return withUrl(images.getImageDetail(id));
  });

  app.patch('/api/images/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    images.updateImage(id, PatchImageBody.parse(req.body ?? {}));
    return withUrl(images.getImageDetail(id));
  });

  app.delete('/api/images/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await images.deleteImage(id);
    return reply.code(204).send();
  });

  // Gemini looks at the image and plans one Veo prompt per take (cached; ?refresh=1 plans again).
  app.get('/api/images/:id/motion-plan', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { refresh } = z.object({ refresh: z.enum(['1', 'true']).optional() }).parse(req.query);
    return animations.planMotion(id, { refresh: !!refresh });
  });

  app.get('/api/animations', async (req) => {
    const { imageId } = z.object({ imageId: Id.optional() }).parse(req.query);
    return (imageId ? animations.listForImage(imageId) : animations.listRecent()).map(animationView);
  });

  app.post('/api/animations', async (req, reply) => {
    const body = CreateAnimationBody.parse(req.body ?? {});
    const row = animations.create({
      imageId: body.imageId,
      motionPrompts: body.motionPrompts ?? (body.motionPrompt ? [body.motionPrompt] : undefined),
    });
    return reply.code(202).send(animationView(row));
  });

  app.get('/api/animations/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return {
      ...animationView(animations.getWithImage(id)),
      takes: animations.clipsFor(id).map(({ idx, motion_prompt, status, error }) => ({ idx, motion_prompt, status, error })),
    };
  });

  app.patch('/api/animations/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    animations.setStarred(id, PatchAnimationBody.parse(req.body ?? {}).starred);
    return animationView(animations.getWithImage(id));
  });

  app.delete('/api/animations/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await animations.delete(id);
    return reply.code(204).send();
  });

  app.get('/api/spend', async () => cost.summary());

  return app;
}
