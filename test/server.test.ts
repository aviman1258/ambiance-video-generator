import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { makeServices } from './helpers.ts';

async function setup() {
  const services = makeServices();
  const app = await buildApp({
    config: { providers: 'mock', imageModel: 'fake-image', videoModel: 'fake-video', imagesPerBatch: 6, logLevel: 'error' },
    ...services,
    logger: false,
  });
  return { app, services };
}

test('config reports costs and the spend summary', async () => {
  const { app } = await setup();
  const res = await app.inject('/api/config');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(Number(body.batchCostUsd.toFixed(2)), 0.3);
  assert.equal(Number(body.animationCostUsd.toFixed(2)), 0.96);
  assert.deepEqual(body.spend, { spentUsd: 0, inFlightUsd: 0, capUsd: 10 });
  assert.equal(body.stylePresets[0].id, 'anime-painterly');
});

test('full flow over HTTP: batch → save → animate → serve the clip', async () => {
  const { app, services } = await setup();

  assert.equal((await app.inject({ method: 'POST', url: '/api/batches', payload: { scenePrompt: '' } })).statusCode, 400);

  const created = await app.inject({ method: 'POST', url: '/api/batches', payload: { scenePrompt: 'Darjeeling tea estate in mist' } });
  assert.equal(created.statusCode, 202);
  const batchId = created.json().id;

  let batch;
  for (let i = 0; i < 50; i++) {
    batch = (await app.inject(`/api/batches/${batchId}`)).json();
    if (batch.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(batch.status, 'succeeded');
  assert.equal(batch.images.length, 6);

  const img = batch.images[0];
  const file = await app.inject(img.url);
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers['content-type'], 'image/png');

  const saved = await app.inject({ method: 'PATCH', url: `/api/images/${img.id}`, payload: { saved: true } });
  assert.equal(saved.json().saved, true);
  assert.equal((await app.inject('/api/images/saved')).json().length, 1);

  const suggestion = (await app.inject(`/api/images/${img.id}/motion-suggestion`)).json();
  assert.match(suggestion.motionPrompt, /mist drifting/);

  const anim = await app.inject({ method: 'POST', url: '/api/animations', payload: { imageId: img.id } });
  assert.equal(anim.statusCode, 202);
  await services.animations.idle();
  const done = (await app.inject(`/api/animations/${anim.json().id}`)).json();
  assert.equal(done.status, 'succeeded');

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
