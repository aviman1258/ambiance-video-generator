import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { mp4DurationSeconds, mp4HasAudio } from '../src/core/mp4.ts';
import { keywordSoundLayers } from '../src/modules/animation/motion.ts';
import { cleanSounds } from '../src/providers/google/motion.ts';
import { FakeSoundGenerator, makeServices } from './helpers.ts';

async function withImage(services: ReturnType<typeof makeServices>, scene: string) {
  const { batch, done } = services.images.createBatch({ scenePrompt: scene });
  await done;
  return services.images.getBatch(batch.id).images[0]!;
}

test('keyword sound layers fit the scene: a rainy city night gets rain, city and crickets', () => {
  const layers = keywordSoundLayers('Rainy night in a Mumbai apartment, wind outside, city lights');
  assert.deepEqual(layers.map((l) => l.category), ['rain', 'city', 'wind', 'insects']);
  assert.equal(layers[0]!.level, 'main');
  for (const l of layers) assert.match(l.description, /no music, no speech/);
  assert.deepEqual(keywordSoundLayers('an empty room').map((l) => l.category), ['interior']);
});

test('planner sound output is cleaned: bad entries dropped, unknown categories mapped, "no music" enforced, max 4', () => {
  const cleaned = cleanSounds([
    { category: 'rain', tags: ['Heavy', 'Tin Roof'], level: 'main', description: 'Heavy monsoon rain on a tin roof, continuous' },
    { category: 'spaceship', tags: ['hum'], level: 'low', description: 'A low distant hum of something, no music, no speech' },
    { category: 'wind', level: 'medium' }, // no description: dropped
    { category: 'city', tags: [], level: 'loud', description: 'Distant traffic hum with auto-rickshaw horns' },
    { category: 'birds', tags: [], level: 'low', description: 'Sparrows chirping in the distance now and then' },
    { category: 'insects', tags: [], level: 'low', description: 'Crickets on a warm night, steady and calm' },
  ])!;
  assert.equal(cleaned.length, 4);
  assert.deepEqual(cleaned[0]!.tags, ['heavy', 'tin roof']);
  assert.match(cleaned[0]!.description, /no music, no speech$/);
  assert.equal(cleaned[1]!.category, 'nature');
  assert.equal(cleaned[2]!.level, 'medium', 'invalid level falls back');
  assert.equal(cleanSounds('nope'), undefined);
});

test('the library generates a sound once and reuses it for a similar layer', async () => {
  const gen = new FakeSoundGenerator();
  const services = makeServices({ soundGen: gen });
  const lib = services.sounds!;
  const a = await lib.ensure({ category: 'rain', tags: ['rain', 'heavy', 'window'], level: 'main', description: 'Heavy rain on a window, no music, no speech' });
  const b = await lib.ensure({ category: 'rain', tags: ['rain', 'heavy', 'roof'], level: 'main', description: 'Heavy rain on a roof, no music, no speech' });
  assert.equal(a.id, b.id, 'close enough to reuse');
  const c = await lib.ensure({ category: 'rain', tags: ['drizzle', 'light', 'leaves'], level: 'low', description: 'Light drizzle on leaves, no music, no speech' });
  assert.notEqual(c.id, a.id, 'different enough to generate');
  const d = await lib.ensure({ category: 'wind', tags: ['rain', 'heavy', 'window'], level: 'low', description: 'Wind, no music, no speech' });
  assert.notEqual(d.id, a.id, 'never reused across categories');
  assert.equal(gen.prompts.length, 3);
  assert.equal(services.cost.spentUsd(), 0.6);
  assert.equal(lib.list().find((s) => s.id === a.id)!.use_count, 2);
  assert.ok(fs.existsSync(services.assets.abs(a.file_path)));
});

test('an animation comes out with ambient sound mixed in, same length as the silent loop; later scenes reuse the sounds', async () => {
  const gen = new FakeSoundGenerator();
  const services = makeServices({ soundGen: gen });
  const image = await withImage(services, 'Rainy night in a Mumbai apartment, wind outside');
  const row = services.animations.create({ imageId: image.id });
  assert.equal(row.sound_status, 'pending');
  await services.animations.idle();

  const done = services.animations.get(row.id);
  assert.equal(done.status, 'succeeded', done.error ?? '');
  assert.equal(done.sound_status, 'succeeded', done.sound_error ?? '');
  const silent = await fs.promises.readFile(services.assets.abs(done.file_path!));
  const mixed = await fs.promises.readFile(services.assets.abs(done.mixed_path!));
  assert.equal(mp4HasAudio(silent), false);
  assert.equal(mp4HasAudio(mixed), true);
  assert.ok(Math.abs(mp4DurationSeconds(mixed)! - mp4DurationSeconds(silent)!) < 0.15);
  const layers = JSON.parse(done.sound_layers!) as { category: string; sound_id?: number }[];
  assert.deepEqual(layers.map((l) => l.category), ['rain', 'city', 'wind', 'insects']);
  assert.ok(layers.every((l) => typeof l.sound_id === 'number'));
  assert.equal(gen.prompts.length, 4);

  const other = await withImage(services, 'Rainy night on a Kolkata street, wind and traffic');
  services.animations.create({ imageId: other.id });
  await services.animations.idle();
  assert.equal(gen.prompts.length, 4, 'every layer found in the library');
});

test('if sound fails, the silent loop is still delivered and the reason is kept', async () => {
  const gen = new FakeSoundGenerator();
  gen.fail = true;
  const services = makeServices({ soundGen: gen });
  const image = await withImage(services, 'Rainy night in a Mumbai apartment');
  const row = services.animations.create({ imageId: image.id });
  await services.animations.idle();
  const done = services.animations.get(row.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.sound_status, 'failed');
  assert.match(done.sound_error ?? '', /out of credits/);
  assert.equal(done.mixed_path, null);
  assert.ok(done.file_path);
});

test('sound can be added to a finished animation that has none, and redone', async () => {
  const gen = new FakeSoundGenerator();
  gen.fail = true;
  const services = makeServices({ soundGen: gen });
  const image = await withImage(services, 'Village pond in the afternoon with palm trees');
  const row = services.animations.create({ imageId: image.id });
  await services.animations.idle();
  assert.equal(services.animations.get(row.id).sound_status, 'failed');

  gen.fail = false;
  await services.animations.addSoundTo(row.id);
  await services.animations.idle();
  const withSound = services.animations.get(row.id);
  assert.equal(withSound.sound_status, 'succeeded');
  assert.ok(withSound.mixed_path);

  await services.animations.addSoundTo(row.id); // redo: reuses library sounds
  await services.animations.idle();
  assert.equal(services.animations.get(row.id).sound_status, 'succeeded');
  await assert.rejects(services.animations.addSoundTo(999), /not found/);
});

test('Stable Audio is called with a multipart form and a bearer key, asking for audio back', async () => {
  const { StableAudioGenerator } = await import('../src/providers/stability/audio.ts');
  let sent: { url: string; init: RequestInit } | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return new Response(Buffer.alloc(4000, 1), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }) as typeof fetch;
  try {
    const gen = new StableAudioGenerator({ apiKey: 'sk-test', model: 'stable-audio-2.5', costPerSoundUsd: 0.2 });
    const out = await gen.generate({ prompt: 'rain on a window, no music, no speech', seconds: 120 });
    assert.equal(out.ext, 'mp3');
    assert.equal(sent!.url, 'https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio');
    const headers = sent!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer sk-test');
    assert.equal(headers.accept, 'audio/*');
    assert.equal(headers['content-type'], undefined, 'fetch sets the multipart boundary itself');
    const form = sent!.init.body as FormData;
    assert.equal(form.get('model'), 'stable-audio-2.5');
    assert.equal(form.get('duration'), '120');
    assert.equal(form.get('output_format'), 'mp3');
    assert.match(String(form.get('prompt')), /rain on a window/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the API serves the version with sound and can add sound on request', async () => {
  const { buildApp } = await import('../src/server/app.ts');
  const services = makeServices({ soundGen: new FakeSoundGenerator() });
  const app = await buildApp({
    config: { providers: 'mock', imageModel: 'm', videoModel: 'v', imagesPerBatch: 1, logLevel: 'error' },
    ...services,
    logger: false,
  });
  assert.equal((await app.inject('/api/config')).json().soundEnabled, true);
  const image = await withImage(services, 'Rainy night in a Mumbai apartment');
  const anim = (await app.inject({ method: 'POST', url: '/api/animations', payload: { imageId: image.id } })).json();
  await services.animations.idle();
  const detail = (await app.inject(`/api/animations/${anim.id}`)).json();
  assert.equal(detail.hasSound, true);
  assert.notEqual(detail.url, detail.silentUrl);
  assert.equal(detail.soundLayers[0].category, 'rain');
  assert.equal((await app.inject(detail.url)).statusCode, 200);
  assert.deepEqual((await app.inject('/api/sounds')).json().map((s: { category: string }) => s.category).sort(), ['city', 'insects', 'rain']);
  assert.equal((await app.inject({ method: 'POST', url: `/api/animations/${anim.id}/sound` })).statusCode, 202);
  await services.animations.idle();
});
