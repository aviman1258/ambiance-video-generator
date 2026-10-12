import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { makeServices } from './helpers.ts';

async function setup() {
  const services = makeServices();
  const app = await buildApp({
    config: { providers: 'mock', imageModel: 'fake-image', videoModel: 'fake-video', imagesPerBatch: 1, logLevel: 'error' },
    ...services,
    logger: false,
  });
  return { app, services };
}

async function generate(app: Awaited<ReturnType<typeof setup>>['app'], scenePrompt: string) {
  const created = await app.inject({ method: 'POST', url: '/api/generations', payload: { scenePrompt } });
  assert.equal(created.statusCode, 202);
  for (let i = 0; i < 100; i++) {
    const gen = (await app.inject(`/api/generations/${created.json().id}`)).json();
    if (gen.status !== 'running') return gen;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('generation never finished');
}

test('config reports costs and the spend summary', async () => {
  const { app } = await setup();
  const body = (await app.inject('/api/config')).json();
  assert.equal(body.generationCostUsd, 0.051);
  assert.equal(Number(body.animationCostUsd.toFixed(2)), 0.96);
  assert.deepEqual(body.spend, { spentUsd: 0, inFlightUsd: 0, capUsd: 10 });
  assert.equal(body.stylePresets[0].id, 'anime-painterly');
});

test('generate → list → search by tag → edit tags → save', async () => {
  const { app } = await setup();
  assert.equal((await app.inject({ method: 'POST', url: '/api/generations', payload: { scenePrompt: '' } })).statusCode, 400);

  const gen = await generate(app, 'Darjeeling tea estate in mist');
  assert.equal(gen.status, 'succeeded');
  assert.equal(gen.images.length, 1);
  const id = gen.images[0].id;

  const list = (await app.inject('/api/images')).json();
  assert.equal(list.total, 1);
  const item = list.items[0];
  assert.match(item.thumbUrl, /\.webp$/);
  assert.match(item.previewUrl, /\.webp$/);
  assert.match(item.url, /\.png$/);
  assert.deepEqual(item.tags, ['kolkata', 'rain', 'night', 'warm light']);
  assert.equal((await app.inject(item.thumbUrl)).headers['content-type'], 'image/webp');

  assert.equal((await app.inject('/api/images?q=rain')).json().total, 1);
  assert.equal((await app.inject('/api/images?q=snow')).json().total, 0);
  assert.deepEqual((await app.inject('/api/tags')).json().map((t: { tag: string }) => t.tag).sort(), ['kolkata', 'night', 'rain', 'warm light']);

  const edited = await app.inject({ method: 'PATCH', url: `/api/images/${id}`, payload: { tags: ['Tea Estate', 'mist'], saved: true } });
  assert.deepEqual(edited.json().tags, ['tea estate', 'mist']);
  assert.equal(edited.json().saved, true);
  assert.equal((await app.inject('/api/images?saved=1&q=tea')).json().total, 1);

  const detail = (await app.inject(`/api/images/${id}`)).json();
  assert.equal(detail.scene_prompt, 'Darjeeling tea estate in mist');
  assert.match(detail.full_prompt, /hand-painted anime/i);
  assert.equal((await app.inject('/api/images/999')).statusCode, 404);
});

test('animate an image over HTTP and stream the clip with range requests', async () => {
  const { app, services } = await setup();
  const gen = await generate(app, 'Darjeeling tea estate in mist');
  const img = gen.images[0];

  const suggestion = (await app.inject(`/api/images/${img.id}/motion-suggestion`)).json();
  assert.match(suggestion.motionPrompt, /mist drifting/);

  const anim = await app.inject({ method: 'POST', url: '/api/animations', payload: { imageId: img.id } });
  assert.equal(anim.statusCode, 202);
  await services.animations.idle();
  const done = (await app.inject(`/api/animations/${anim.json().id}`)).json();
  assert.equal(done.status, 'succeeded');
  assert.equal((await app.inject('/api/images')).json().items[0].animation_count, 1);
  assert.match(done.imageThumbUrl, /\.webp$/, 'animation carries its image thumbnail for the Animations tab');
  const list = (await app.inject('/api/animations')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].scene_prompt, 'Darjeeling tea estate in mist');
  assert.match(list[0].imageThumbUrl, /\.webp$/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/generations', payload: { scenePrompt: 'asdf qwer' } })).statusCode, 400);

  const clip = await app.inject({ url: done.url, headers: { range: 'bytes=0-3' } });
  assert.equal(clip.statusCode, 206, 'range requests work so <video> can loop and seek');
  assert.equal((await app.inject('/api/animations/999')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/animations', payload: { imageId: 'abc' } })).statusCode, 400);
});

test('the page is served at /', async () => {
  const { app } = await setup();
  const res = await app.inject('/');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Ambiance Studio/);
});
