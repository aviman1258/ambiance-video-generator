import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageInfo } from '../src/core/imageInfo.ts';
import { findLastImageBlock } from '../src/providers/google/image.ts';
import { MockImageGenerator, MockVideoGenerator } from '../src/providers/mock/index.ts';
import { encodePng } from '../src/providers/mock/png.ts';

const b64 = 'A'.repeat(200);

test('findLastImageBlock handles the documented content-block shape and older inlineData shapes', () => {
  const interactions = {
    id: 'x',
    steps: [
      { type: 'thought', content: [{ type: 'text', text: 'thinking' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'here you go' }, { type: 'image', data: b64, mime_type: 'image/jpeg' }] },
    ],
  };
  assert.deepEqual(findLastImageBlock(interactions), { data: b64, mimeType: 'image/jpeg' });

  const generateContent = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }] } }] };
  assert.deepEqual(findLastImageBlock(generateContent), { data: b64, mimeType: 'image/png' });

  assert.equal(findLastImageBlock({ steps: [{ content: [{ type: 'text', text: 'refused' }] }] }), undefined);
});

test('a free-tier "limit: 0" 429 is not retried and explains how to fix it', async () => {
  const { requestJson } = await import('../src/providers/http.ts');
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{"error":{"message":"Rate limit exceeded (limit: 0 requests per day on Free Tier)"}}', { status: 429 });
  }) as typeof fetch;
  try {
    await assert.rejects(requestJson('https://example.test/x', { method: 'POST', body: {} }), (err: Error & { retryable?: boolean }) => {
      assert.equal(err.retryable, false);
      assert.match(err.message, /Turn on billing/);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('imageInfo reads PNG dimensions', () => {
  assert.deepEqual(imageInfo(encodePng(1920, 1080, () => [0, 0, 0])), { mimeType: 'image/png', width: 1920, height: 1080 });
  assert.equal(imageInfo(Buffer.from('nope')).mimeType, 'application/octet-stream');
});

test('mock providers are free, 16:9 and produce a playable clip', async () => {
  const images = new MockImageGenerator();
  const a = await images.generate({ prompt: 'p', aspectRatio: '16:9', size: '2K' });
  const b = await images.generate({ prompt: 'p', aspectRatio: '16:9', size: '2K' });
  assert.equal(images.costPerImageUsd, 0);
  assert.deepEqual(imageInfo(a.bytes), { mimeType: 'image/png', width: 640, height: 360 });
  assert.ok(!a.bytes.equals(b.bytes), 'each candidate differs');

  const videos = new MockVideoGenerator({ completeAfterMs: 0 });
  const { operationId } = await videos.start();
  const status = await videos.check(operationId);
  assert.equal(status.state, 'succeeded');
  const clip = await videos.download();
  assert.equal(clip.toString('ascii', 4, 8), 'ftyp', 'is an MP4');
});
