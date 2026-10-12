import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import sharp from 'sharp';
import { SpendCapError } from '../src/core/cost.ts';
import { BadRequestError, NotFoundError } from '../src/modules/images/service.ts';
import { buildImagePrompt, buildVariationPrompt } from '../src/modules/images/style.ts';
import { keywordTags, normalizeTags } from '../src/modules/images/tags.ts';
import { FakeImageGenerator, FakeTagger, makeServices } from './helpers.ts';

async function generateOne(services: ReturnType<typeof makeServices>, scenePrompt: string) {
  const { batch, done } = services.images.createBatch({ scenePrompt });
  await done;
  return services.images.getBatch(batch.id).images[0]!;
}

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

test('tags are normalized and keyword fallback skips filler words', () => {
  assert.deepEqual(normalizeTags(['#Rain', 'rain', '  Warm   Light ', 'x', 'a'.repeat(40), 'chai!']), ['rain', 'warm light', 'chai']);
  assert.deepEqual(keywordTags('Summer afternoon in rural Kolkata. Wind in the trees.'), ['summer', 'afternoon', 'rural', 'kolkata', 'wind', 'trees']);
});

test('one Generate makes one image with a thumbnail, a preview and auto tags, and charges image + tagging', async () => {
  const services = makeServices();
  const image = await generateOne(services, 'Chai stall in the rain');
  const detail = services.images.getImageDetail(image.id);

  assert.equal(services.images.getBatch(image.batch_id).images.length, 1);
  assert.ok(fs.existsSync(services.assets.abs(detail.file_path)));
  assert.ok(detail.thumb_path && detail.preview_path);
  const thumb = await sharp(services.assets.abs(detail.thumb_path)).metadata();
  assert.equal(thumb.format, 'webp');
  assert.deepEqual(detail.tags, ['kolkata', 'rain', 'night', 'warm light']);
  assert.equal(services.cost.spentUsd(), 0.051);
});

test('if the tagger fails, the image still gets keyword tags from the prompt and tagging is not charged', async () => {
  const tagger = new FakeTagger();
  tagger.fail = true;
  const services = makeServices({ tagger });
  const image = await generateOne(services, 'Varanasi ghats at dawn with floating diyas');
  assert.deepEqual(services.images.tagsFor(image.id), ['varanasi', 'ghats', 'dawn', 'floating', 'diyas']);
  assert.equal(services.cost.spentUsd(), 0.05);
});

test('search matches the start of any word in a tag, and every term must match', async () => {
  const tagger = new FakeTagger();
  const services = makeServices({ tagger });
  tagger.tags = ['kolkata', 'monsoon rain', 'night'];
  const a = await generateOne(services, 'Kolkata alley at night');
  tagger.tags = ['mumbai', 'rain', 'evening'];
  const b = await generateOne(services, 'Mumbai evening rain');
  tagger.tags = ['shimla', 'snow'];
  await generateOne(services, 'Shimla cottage in snow');

  const ids = (q: string) => services.images.listImages({ q }).items.map((i) => i.id);
  assert.deepEqual(ids('rain'), [b.id, a.id], 'newest first; "rain" matches "monsoon rain"');
  assert.deepEqual(ids('rai kolk'), [a.id]);
  assert.deepEqual(ids('#Night'), [a.id]);
  assert.deepEqual(ids('ain'), [], 'no mid-word matches');
  assert.deepEqual(ids('100%'), [], 'LIKE wildcards are escaped');
  assert.equal(services.images.listImages().total, 3);
  assert.deepEqual(services.images.listTags()[0], { tag: 'evening', count: 1 });
});

test('tags can be replaced by hand; pagination works', async () => {
  const services = makeServices();
  const first = await generateOne(services, 'Rajasthani haveli at night');
  await generateOne(services, 'Kerala houseboat');
  services.images.updateImage(first.id, { tags: ['Haveli', 'lanterns', 'haveli'] });
  assert.deepEqual(services.images.tagsFor(first.id), ['haveli', 'lanterns']);
  assert.equal(services.images.listImages({ limit: 1, offset: 1 }).items[0]!.id, first.id);
});

test('deleting an image removes its tags, animations and files, but keeps files other rows still use', async () => {
  const services = makeServices();
  const keep = await generateOne(services, 'Rajasthani haveli at night');
  const doomed = await generateOne(services, 'Kerala houseboat in the rain');
  const variation = services.images.createBatch({ referenceImageId: doomed.id });
  await variation.done;
  const anim = services.animations.create({ imageId: doomed.id, motionPrompts: ['rain on water'] });
  await services.animations.idle();
  const clip = services.animations.get(anim.id).file_path!;
  const doomedDetail = services.images.getImageDetail(doomed.id);
  const spent = services.cost.spentUsd();

  await services.images.deleteImage(doomed.id);

  assert.throws(() => services.images.getImageRow(doomed.id), NotFoundError);
  assert.throws(() => services.animations.get(anim.id), NotFoundError);
  assert.deepEqual(services.images.tagsFor(doomed.id), []);
  for (const rel of [doomedDetail.file_path, doomedDetail.thumb_path!, doomedDetail.preview_path!, clip]) {
    assert.equal(fs.existsSync(services.assets.abs(rel)), false, `${rel} removed`);
  }
  const keptDetail = services.images.getImageDetail(keep.id);
  assert.ok(fs.existsSync(services.assets.abs(keptDetail.file_path)));
  assert.equal(services.images.getBatchRow(variation.batch.id).reference_image_id, null, 'variation survives, link cleared');
  assert.equal(services.cost.spentUsd(), spent, 'spending history is kept');
});

test('an image that is still being animated cannot be deleted', async () => {
  const services = makeServices();
  const image = await generateOne(services, 'Goa beach shack at sunset');
  services.animations.create({ imageId: image.id, motionPrompts: ['waves'] });
  await assert.rejects(services.images.deleteImage(image.id), /still being animated/);
  await services.animations.idle();
  await services.images.deleteImage(image.id);
});

test('the spend cap blocks a generation before any call is made', () => {
  const gen = new FakeImageGenerator();
  const { images } = makeServices({ imageGen: gen, cap: 0.04 });
  assert.throws(() => images.createBatch({ scenePrompt: 'Kerala houseboat' }), SpendCapError);
  assert.equal(gen.calls.length, 0);
});

test('more like this reuses the reference image and its scene; generate another links the parent', async () => {
  const gen = new FakeImageGenerator();
  const services = makeServices({ imageGen: gen });
  const ref = await generateOne(services, 'Himalayan cottage in snow');

  const variation = services.images.createBatch({ referenceImageId: ref.id });
  await variation.done;
  assert.equal(variation.batch.scene_prompt, 'Himalayan cottage in snow');
  assert.equal(services.images.getImageDetail(services.images.getBatch(variation.batch.id).images[0]!.id).reference_image_id, ref.id);
  assert.equal(gen.calls.at(-1)!.referenceImages?.length, 1);

  const again = services.images.createBatch({ scenePrompt: 'Himalayan cottage in snow', parentBatchId: ref.batch_id });
  await again.done;
  assert.equal(again.batch.parent_batch_id, ref.batch_id);
});

test('failures and validation errors', async () => {
  const gen = new FakeImageGenerator();
  gen.failOnCalls = new Set([1]);
  const services = makeServices({ imageGen: gen });
  assert.throws(() => services.images.createBatch({ scenePrompt: '   ' }), BadRequestError);
  assert.throws(() => services.images.createBatch({ referenceImageId: 999 }), NotFoundError);
  const { batch, done } = services.images.createBatch({ scenePrompt: 'Darjeeling tea garden' });
  await done;
  const result = services.images.getBatch(batch.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /fake failure/);
  assert.equal(services.cost.spentUsd(), 0);
});

test('startup: running generations are marked interrupted; old images get renditions and keyword tags for free', async () => {
  const services = makeServices();
  const image = await generateOne(services, 'Goa beach shack at sunset');
  services.db.prepare('UPDATE images SET thumb_path = NULL, preview_path = NULL WHERE id = ?').run(image.id);
  services.db.prepare('DELETE FROM image_tags WHERE image_id = ?').run(image.id);
  services.db
    .prepare(
      `INSERT INTO image_batches (scene_prompt, full_prompt, style_preset, provider, model, requested_count, status, created_at)
       VALUES ('x', 'x', 'anime-painterly', 'fake', 'fake', 1, 'running', 'now')`,
    )
    .run();
  const tagCallsBefore = (services.tagger as FakeTagger).calls;

  assert.equal(services.images.markInterrupted(), 1);
  assert.deepEqual(await services.images.backfill(), { renditions: 1, tagged: 1 });
  const detail = services.images.getImageDetail(image.id);
  assert.ok(detail.thumb_path);
  assert.deepEqual(detail.tags, ['goa', 'beach', 'shack', 'sunset']);
  assert.equal((services.tagger as FakeTagger).calls, tagCallsBefore, 'backfill never calls the paid tagger');
});
