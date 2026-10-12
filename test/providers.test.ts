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

test('findOutputText reads output_text or the last text block of a response', async () => {
  const { findOutputText } = await import('../src/providers/google/tagger.ts');
  assert.equal(findOutputText({ output_text: '{"tags":["a"]}' }), '{"tags":["a"]}');
  assert.equal(
    findOutputText({ steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"tags":["rain"]}' }] }] }),
    '{"tags":["rain"]}',
  );
  assert.equal(findOutputText({ steps: [] }), undefined);
});

test('Veo start sends both frames as bytesBase64Encoded inside instances[0] (not inlineData)', async () => {
  const { VeoVideoGenerator } = await import('../src/providers/google/veo.ts');
  let sent: { url: string; body: any; headers: Record<string, string> } | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    return new Response(JSON.stringify({ name: 'models/veo/operations/abc' }), { status: 200 });
  }) as typeof fetch;
  try {
    const veo = new VeoVideoGenerator({ apiKey: 'k', model: 'veo-3.1-fast-generate-preview', costPerSecondUsd: 0.12 });
    const frame = { bytes: Buffer.from('jpegbytes'), mimeType: 'image/jpeg' };
    const { operationId } = await veo.start({ prompt: 'rain', firstFrame: frame, lastFrame: frame, durationSeconds: 8, resolution: '1080p' });
    assert.equal(operationId, 'models/veo/operations/abc');
    assert.match(sent!.url, /models\/veo-3\.1-fast-generate-preview:predictLongRunning$/);
    assert.equal(sent!.headers['x-goog-api-key'], 'k');
    const instance = sent!.body.instances[0];
    const expected = { bytesBase64Encoded: Buffer.from('jpegbytes').toString('base64'), mimeType: 'image/jpeg' };
    assert.deepEqual(instance.image, expected);
    assert.deepEqual(instance.lastFrame, expected);
    assert.equal(JSON.stringify(sent!.body).includes('inlineData'), false);
    assert.deepEqual(sent!.body.parameters, { aspectRatio: '16:9', resolution: '1080p', durationSeconds: 8, personGeneration: 'allow_adult' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Google JSON errors become a short readable message', async () => {
  const { requestJson } = await import('../src/providers/http.ts');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: 400, message: "`inlineData` isn't supported by this model.", status: 'INVALID_ARGUMENT' } }), {
      status: 400,
    })) as typeof fetch;
  try {
    await assert.rejects(
      requestJson('https://generativelanguage.googleapis.com/v1beta/models/veo:predictLongRunning', { method: 'POST', body: {} }),
      { message: "Google rejected predictLongRunning (HTTP 400): `inlineData` isn't supported by this model." },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the Veo frame is exactly 1920x1080 JPEG even from a not-quite-16:9 image', async () => {
  const { videoFrame } = await import('../src/modules/images/renditions.ts');
  const frame = await videoFrame(encodePng(688, 384, () => [120, 80, 40])); // 2752x1536 scaled down: same ratio
  assert.equal(frame.mimeType, 'image/jpeg');
  assert.deepEqual(imageInfo(frame.bytes), { mimeType: 'image/jpeg', width: 1920, height: 1080 });
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
