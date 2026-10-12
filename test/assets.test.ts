import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AssetStore } from '../src/core/assets.ts';
import { tempDir } from './helpers.ts';

test('saving identical bytes many times at once yields one file and no leftovers', async () => {
  const store = new AssetStore(path.join(tempDir(), 'assets'));
  const bytes = Buffer.alloc(256 * 1024, 7);
  const results = await Promise.all(Array.from({ length: 12 }, () => store.put(bytes, 'mp4')));
  assert.equal(new Set(results.map((r) => r.relPath)).size, 1);
  const dir = path.dirname(results[0]!.absPath);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(results[0]!.absPath)], 'no stray .tmp files');
  assert.ok((await store.read(results[0]!.relPath)).equals(bytes));
});
