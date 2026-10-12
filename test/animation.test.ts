import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { SpendCapError } from '../src/core/cost.ts';
import { suggestMotionPrompt } from '../src/modules/animation/motion.ts';
import { FakeVideoGenerator, makeServices } from './helpers.ts';

async function withImage(services: ReturnType<typeof makeServices>, scene = 'Monsoon evening, Mumbai apartment, chai on the desk') {
  const { batch, done } = services.images.createBatch({ scenePrompt: scene });
  await done;
  return services.images.getBatch(batch.id).images[0]!;
}

test('motion suggestion picks in-place motion from scene keywords and forbids camera moves', () => {
  const s = suggestMotionPrompt('Monsoon evening in a Mumbai apartment, warm lamp, a steaming cup of chai');
  assert.match(s, /rain streaming down the window/);
  assert.match(s, /steam rising/);
  assert.match(s, /lamp .* flickering/);
  assert.match(s, /no camera movement/i);
  assert.match(suggestMotionPrompt('an empty room'), /dust motes/);
});

test('an animation uses the image as first and last frame, then stores the clip and charges once', async () => {
  const services = makeServices();
  const image = await withImage(services);
  const before = services.cost.spentUsd();

  const row = services.animations.create({ imageId: image.id });
  assert.equal(row.status, 'pending');
  assert.equal(row.loop_mode, 'same-first-last');
  assert.match(row.motion_prompt, /rain streaming/);
  await services.animations.idle();

  const done = services.animations.get(row.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.operation_id, 'operations/op-1');
  assert.ok(done.file_path && fs.existsSync(services.assets.abs(done.file_path)));

  const gen = services.videoGen as FakeVideoGenerator;
  const req = gen.starts[0]!;
  assert.equal(req.durationSeconds, 8);
  assert.equal(req.resolution, '1080p');
  assert.ok(req.lastFrame && req.lastFrame.bytes.equals(req.firstFrame.bytes), 'last frame = first frame for looping');
  assert.equal(Number((services.cost.spentUsd() - before).toFixed(2)), 0.96);
});

test('a double click returns the in-flight animation instead of paying twice', async () => {
  const services = makeServices();
  const image = await withImage(services);
  const a = services.animations.create({ imageId: image.id, motionPrompt: 'rain on glass' });
  const b = services.animations.create({ imageId: image.id, motionPrompt: 'rain on glass' });
  assert.equal(a.id, b.id);
  await services.animations.idle();
  assert.equal((services.videoGen as FakeVideoGenerator).starts.length, 1);
});

test('in-flight estimates count against the cap', async () => {
  const services = makeServices({ cap: 0.3 + 0.96 + 0.5 });
  const image = await withImage(services); // $0.30 spent
  services.animations.create({ imageId: image.id, motionPrompt: 'one' }); // $0.96 in flight
  assert.throws(() => services.animations.create({ imageId: image.id, motionPrompt: 'two' }), SpendCapError);
  await services.animations.idle();
});

test('provider failure and safety blocks are recorded as failed, with no charge', async () => {
  const gen = new FakeVideoGenerator();
  gen.script = [{ state: 'failed', error: 'Blocked by Veo safety filter: reason' }];
  const services = makeServices({ videoGen: gen });
  const image = await withImage(services);
  const spent = services.cost.spentUsd();
  const row = services.animations.create({ imageId: image.id });
  await services.animations.idle();
  const failed = services.animations.get(row.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /safety filter/);
  assert.equal(services.cost.spentUsd(), spent);

  const gen2 = new FakeVideoGenerator();
  gen2.startError = new Error('HTTP 400: bad image');
  const s2 = makeServices({ videoGen: gen2 });
  const img2 = await withImage(s2);
  const r2 = s2.animations.create({ imageId: img2.id });
  await s2.animations.idle();
  assert.equal(s2.animations.get(r2.id).status, 'failed');
});

test('after a restart, running operations resume polling; unsubmitted ones fail safely', async () => {
  const first = makeServices();
  const image = await withImage(first);
  const ts = new Date().toISOString();
  const insert = first.db.prepare(
    `INSERT INTO animations (image_id, motion_prompt, provider, model, duration_s, resolution, loop_mode,
       estimated_cost_usd, operation_id, status, created_at, updated_at)
     VALUES (?, ?, 'fake', 'fake-video', 8, '1080p', 'same-first-last', 0.96, ?, ?, ?, ?)`,
  );
  const running = Number(insert.run(image.id, 'resume me', 'operations/op-9', 'running', ts, ts).lastInsertRowid);
  const pending = Number(insert.run(image.id, 'never sent', null, 'pending', ts, ts).lastInsertRowid);
  first.db.close();

  const second = makeServices({ dir: first.dir });
  assert.equal(second.animations.resumeInFlight(), 2);
  await second.animations.idle();
  assert.equal(second.animations.get(running).status, 'succeeded');
  assert.equal(second.animations.get(pending).status, 'failed');
  assert.equal((second.videoGen as FakeVideoGenerator).starts.length, 0, 'resume never re-submits');
});
