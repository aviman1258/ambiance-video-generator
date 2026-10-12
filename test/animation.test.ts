import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { SpendCapError } from '../src/core/cost.ts';
import { imageInfo } from '../src/core/imageInfo.ts';
import { keywordMotionPlan, suggestMotionPrompt } from '../src/modules/animation/motion.ts';
import { ProviderError } from '../src/providers/types.ts';
import { FakePlanner, FakeVideoGenerator, makeServices } from './helpers.ts';

async function withImage(services: ReturnType<typeof makeServices>, scene = 'Monsoon evening, Mumbai apartment, chai on the desk') {
  const { batch, done } = services.images.createBatch({ scenePrompt: scene });
  await done;
  return services.images.getBatch(batch.id).images[0]!;
}

/** MP4 duration from the movie header, so tests can check the join without ffprobe. */
function mp4Seconds(bytes: Buffer): number {
  const i = bytes.indexOf('mvhd');
  const version = bytes[i + 4];
  const timescale = version === 1 ? bytes.readUInt32BE(i + 24) : bytes.readUInt32BE(i + 16);
  const duration = version === 1 ? Number(bytes.readBigUInt64BE(i + 28)) : bytes.readUInt32BE(i + 20);
  return duration / timescale;
}

test('keyword fallback: in-place motion from scene words, one distinct take each', () => {
  const s = suggestMotionPrompt('Monsoon evening in a Mumbai apartment, warm lamp, a steaming cup of chai');
  assert.match(s, /rain streaming down the window/);
  assert.match(s, /steam rising/);
  assert.match(s, /no camera movement/i);
  const kolkata = suggestMotionPrompt('Summer afternoon in rural Kolkata. Wind in the trees. Sunny with dust motes in the sunlight.');
  assert.match(kolkata, /swaying slightly in the breeze/);
  assert.match(kolkata, /shafts of sunlight/);
  const plan = keywordMotionPlan('rain on a window', 3);
  assert.equal(plan.takes.length, 3);
  assert.equal(new Set(plan.takes).size, 3, 'takes differ');
});

test('an animation is 3 takes, each looping on a 1920x1080 frame of the image, joined into one silent 3x-long clip', async () => {
  const services = makeServices();
  const image = await withImage(services);
  const before = services.cost.spentUsd();

  const row = services.animations.create({ imageId: image.id });
  assert.equal(row.clip_count, 3);
  assert.equal(row.duration_s, 24);
  await services.animations.idle();

  const done = services.animations.get(row.id);
  assert.equal(done.status, 'succeeded', done.error ?? '');
  assert.equal(done.note, null);
  const clips = services.animations.clipsFor(row.id);
  assert.deepEqual(clips.map((c) => c.status), ['succeeded', 'succeeded', 'succeeded']);

  const gen = services.videoGen as FakeVideoGenerator;
  assert.equal(gen.starts.length, 3);
  for (const req of gen.starts) {
    assert.ok(req.lastFrame && req.lastFrame.bytes.equals(req.firstFrame.bytes), 'last frame = first frame');
    assert.deepEqual(imageInfo(req.firstFrame.bytes), { mimeType: 'image/jpeg', width: 1920, height: 1080 });
    assert.equal(req.durationSeconds, 8);
  }
  assert.equal(new Set(gen.starts.map((s) => s.prompt)).size, 3, 'each take has its own prompt');

  const joined = await fs.promises.readFile(services.assets.abs(done.file_path!));
  const oneTake = await fs.promises.readFile(services.assets.abs(clips[0]!.file_path!));
  assert.ok(Math.abs(mp4Seconds(joined) - 3 * mp4Seconds(oneTake)) < 0.2, `joined ${mp4Seconds(joined)}s vs take ${mp4Seconds(oneTake)}s`);
  assert.equal(joined.indexOf('soun'), -1, 'no audio track');
  assert.equal(Number((services.cost.spentUsd() - before).toFixed(2)), 2.88, 'each take charged once');
});

test('Gemini plans the takes from the image, is cached, and falls back to keywords if it fails', async () => {
  const planner = new FakePlanner();
  const services = makeServices({ planner });
  const image = await withImage(services);

  const plan = await services.animations.planMotion(image.id);
  assert.equal(plan.source, 'vision');
  assert.equal(plan.takes.length, 3);
  assert.match(plan.summary, /Palm fronds/);
  await services.animations.planMotion(image.id);
  assert.equal(planner.calls, 1, 'second open uses the cache');
  await services.animations.planMotion(image.id, { refresh: true });
  assert.equal(planner.calls, 2);

  // Starting without prompts uses the cached plan.
  const row = services.animations.create({ imageId: image.id });
  assert.deepEqual(services.animations.clipsFor(row.id).map((c) => c.motion_prompt), plan.takes);
  await services.animations.idle();

  const other = await withImage(services, 'Shimla cottage in the snow');
  planner.fail = true;
  const fallback = await services.animations.planMotion(other.id);
  assert.equal(fallback.source, 'keywords');
  assert.match(fallback.warning ?? '', /planner down/);
  assert.match(fallback.takes[0]!, /snowflakes/);
  planner.fail = false;
  assert.equal((await services.animations.planMotion(other.id)).source, 'vision', 'a failure is not cached');
});

test('if one take fails, the others still make a (shorter) loop with a note', async () => {
  const gen = new FakeVideoGenerator();
  gen.failOps.set(2, 'Blocked by Veo safety filter: reason');
  const services = makeServices({ videoGen: gen });
  const image = await withImage(services);
  const spent = services.cost.spentUsd();
  const row = services.animations.create({ imageId: image.id });
  await services.animations.idle();

  const done = services.animations.get(row.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.duration_s, 16);
  assert.match(done.note ?? '', /1 of 3 takes failed.*safety filter/);
  assert.equal(Number((services.cost.spentUsd() - spent).toFixed(2)), 1.92, 'the failed take is not charged');
});

test('if every take fails, the animation fails with the reason and costs nothing', async () => {
  const gen = new FakeVideoGenerator();
  for (const n of [1, 2, 3]) gen.failOps.set(n, 'Blocked by Veo safety filter');
  const services = makeServices({ videoGen: gen });
  const image = await withImage(services);
  const spent = services.cost.spentUsd();
  const row = services.animations.create({ imageId: image.id });
  await services.animations.idle();
  assert.equal(services.animations.get(row.id).status, 'failed');
  assert.match(services.animations.get(row.id).error ?? '', /safety filter/);
  assert.equal(services.cost.spentUsd(), spent);
});

test('a rate-limited submit is retried; a hard error fails just that take', async () => {
  const rateLimited = () => new ProviderError('HTTP 429', { status: 429, retryable: true });
  const gen = new FakeVideoGenerator();
  gen.startErrors = [rateLimited(), rateLimited()]; // take 1 is refused twice, then accepted
  const services = makeServices({ videoGen: gen });
  const image = await withImage(services);
  const row = services.animations.create({ imageId: image.id });
  await services.animations.idle();
  assert.deepEqual(services.animations.clipsFor(row.id).map((c) => c.status), ['succeeded', 'succeeded', 'succeeded']);

  const gen2 = new FakeVideoGenerator();
  gen2.startErrors = [new ProviderError('HTTP 400: bad', { status: 400 })]; // not retried
  const s2 = makeServices({ videoGen: gen2 });
  const img2 = await withImage(s2);
  const row2 = s2.animations.create({ imageId: img2.id });
  await s2.animations.idle();
  assert.deepEqual(s2.animations.clipsFor(row2.id).map((c) => c.status), ['failed', 'succeeded', 'succeeded']);
  assert.equal(s2.animations.get(row2.id).duration_s, 16);
});

test('a double tap returns the in-flight animation; in-flight takes count against the cap', async () => {
  const services = makeServices({ cap: 0.051 + 2.88 + 0.5 });
  const image = await withImage(services);
  const a = services.animations.create({ imageId: image.id, motionPrompts: ['one', 'two', 'three'] });
  const b = services.animations.create({ imageId: image.id, motionPrompts: ['one', 'two', 'three'] });
  assert.equal(a.id, b.id);
  assert.equal(services.cost.inFlightUsd(), 2.88);
  assert.throws(() => services.animations.create({ imageId: image.id, motionPrompts: ['other'] }), SpendCapError);
  await services.animations.idle();
  assert.equal((services.videoGen as FakeVideoGenerator).starts.length, 3);
  assert.throws(() => services.animations.create({ imageId: image.id, motionPrompts: ['1', '2', '3', '4', '5'] }), /At most 4/);
});

test('after a restart, running takes resume polling, unsubmitted ones are skipped, then the rest are joined', async () => {
  const first = makeServices();
  const image = await withImage(first);
  const ts = new Date().toISOString();
  const animId = Number(
    first.db
      .prepare(
        `INSERT INTO animations (image_id, motion_prompt, provider, model, duration_s, resolution, loop_mode,
           estimated_cost_usd, status, clip_count, created_at, updated_at)
         VALUES (?, 'a\n\nb', 'fake', 'fake-video', 16, '1080p', 'same-first-last', 1.92, 'running', 2, ?, ?)`,
      )
      .run(image.id, ts, ts).lastInsertRowid,
  );
  const clip = first.db.prepare(
    `INSERT INTO animation_clips (animation_id, idx, motion_prompt, estimated_cost_usd, operation_id, status, updated_at)
     VALUES (?, ?, ?, 0.96, ?, ?, ?)`,
  );
  clip.run(animId, 0, 'a', 'operations/op-9', 'running', ts);
  clip.run(animId, 1, 'b', null, 'pending', ts);
  // An older single-take animation that was in flight too.
  const legacyId = Number(
    first.db
      .prepare(
        `INSERT INTO animations (image_id, motion_prompt, provider, model, duration_s, resolution, loop_mode,
           estimated_cost_usd, operation_id, status, created_at, updated_at)
         VALUES (?, 'old', 'fake', 'fake-video', 8, '1080p', 'same-first-last', 0.96, 'operations/op-7', 'running', ?, ?)`,
      )
      .run(image.id, ts, ts).lastInsertRowid,
  );
  first.db.close();

  const second = makeServices({ dir: first.dir });
  assert.equal(second.animations.resumeInFlight(), 2);
  await second.animations.idle();
  const resumed = second.animations.get(animId);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.duration_s, 8);
  assert.match(resumed.note ?? '', /1 of 2 takes failed/);
  assert.equal(second.animations.get(legacyId).status, 'succeeded');
  assert.equal((second.videoGen as FakeVideoGenerator).starts.length, 0, 'resume never re-submits');
});

test('deleting an animation removes its takes and files', async () => {
  const services = makeServices();
  const image = await withImage(services);
  const row = services.animations.create({ imageId: image.id });
  await services.animations.idle();
  const files = [services.animations.get(row.id).file_path!, ...services.animations.clipsFor(row.id).map((c) => c.file_path!)];
  await services.animations.delete(row.id);
  assert.deepEqual(services.animations.clipsFor(row.id), []);
  // Takes share identical bytes in tests (same fixture), so every one of these paths is gone now.
  for (const f of files) assert.equal(fs.existsSync(services.assets.abs(f)), false, f);
});
