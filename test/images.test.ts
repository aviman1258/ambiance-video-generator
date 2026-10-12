import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { SpendCapError } from '../src/core/cost.ts';
import { BadRequestError, NotFoundError } from '../src/modules/images/service.ts';
import { buildImagePrompt, buildVariationPrompt } from '../src/modules/images/style.ts';
import { FakeImageGenerator, makeServices } from './helpers.ts';

test('buildImagePrompt adds the style, India rules and no-text constraint to the scene', () => {
  const prompt = buildImagePrompt('  Monsoon evening in Mumbai  ');
  assert.match(prompt, /^Scene: Monsoon evening in Mumbai\n/);
  assert.match(prompt, /hand-painted anime/i);
  assert.match(prompt, /setting is in India/);
  assert.match(prompt, /no text/i);
  assert.doesNotMatch(prompt, /ghibli/i, 'studio name stays out of the prompt');
  assert.throws(() => buildImagePrompt('x', 'nope'), /Unknown style preset/);
  assert.match(buildVariationPrompt('x'), /variation of the attached reference image/);
});

test('a batch generates 6 images, stores files and records cost per image', async () => {
  const { images, cost, assets } = makeServices();
  const { batch, done } = images.createBatch({ scenePrompt: 'Chai stall in the rain' });
  assert.equal(batch.status, 'running');
  await done;

  const result = images.getBatch(batch.id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.images.length, 6);
  for (const img of result.images) {
    assert.ok(fs.existsSync(assets.abs(img.file_path)));
    assert.equal(img.mime_type, 'image/png');
    assert.equal(img.width, 32);
    assert.equal(img.height, 18);
  }
  assert.equal(cost.spentUsd(), 0.3);
});

test('partial failures leave a partial batch with the error, and only successes are charged', async () => {
  const gen = new FakeImageGenerator();
  gen.failOnCalls = new Set([2, 5]);
  const { images, cost } = makeServices({ imageGen: gen });
  const { batch, done } = images.createBatch({ scenePrompt: 'Varanasi ghats at dawn' });
  await done;
  const result = images.getBatch(batch.id);
  assert.equal(result.status, 'partial');
  assert.equal(result.images.length, 4);
  assert.match(result.error ?? '', /fake failure/);
  assert.equal(cost.spentUsd(), 0.2);
});

test('the spend cap blocks a batch before any call is made', () => {
  const gen = new FakeImageGenerator();
  const { images } = makeServices({ imageGen: gen, cap: 0.25 });
  assert.throws(() => images.createBatch({ scenePrompt: 'Kerala houseboat' }), SpendCapError);
  assert.equal(gen.calls.length, 0);
});

test('more like this reuses the reference image and its scene; regenerate links the parent', async () => {
  const gen = new FakeImageGenerator();
  const { images } = makeServices({ imageGen: gen });
  const first = images.createBatch({ scenePrompt: 'Himalayan cottage in snow' });
  await first.done;
  const ref = images.getBatch(first.batch.id).images[0]!;

  const variation = images.createBatch({ referenceImageId: ref.id });
  await variation.done;
  assert.equal(variation.batch.scene_prompt, 'Himalayan cottage in snow');
  assert.equal(variation.batch.reference_image_id, ref.id);
  assert.equal(gen.calls.at(-1)!.referenceImages?.length, 1);

  const regen = images.createBatch({ scenePrompt: 'Himalayan cottage in snow', parentBatchId: first.batch.id });
  await regen.done;
  assert.equal(regen.batch.parent_batch_id, first.batch.id);
});

test('saving, listing saved and validation errors', async () => {
  const { images } = makeServices();
  assert.throws(() => images.createBatch({ scenePrompt: '   ' }), BadRequestError);
  assert.throws(() => images.createBatch({ referenceImageId: 999 }), NotFoundError);

  const { batch, done } = images.createBatch({ scenePrompt: 'Rajasthani haveli at night' });
  await done;
  const [img] = images.getBatch(batch.id).images;
  images.updateImage(img!.id, { saved: true, notes: 'lovely lanterns' });
  const saved = images.listSaved();
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.scene_prompt, 'Rajasthani haveli at night');
  assert.equal(saved[0]!.notes, 'lovely lanterns');
  images.updateImage(img!.id, { saved: false });
  assert.equal(images.listSaved().length, 0);
});

test('batches still running at startup are marked interrupted', () => {
  const { images, db } = makeServices();
  db.prepare(
    `INSERT INTO image_batches (scene_prompt, full_prompt, style_preset, provider, model, requested_count, status, created_at)
     VALUES ('x', 'x', 'anime-painterly', 'fake', 'fake', 6, 'running', 'now')`,
  ).run();
  assert.equal(images.markInterrupted(), 1);
  assert.equal(images.listBatches()[0]!.status, 'interrupted');
});
