import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.ts';

export type StoredAsset = { relPath: string; absPath: string; sha256: string; bytes: number };

/** Content-addressed file store: identical bytes are written once, at ab/abcdef….ext */
export class AssetStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  async put(bytes: Buffer, ext: string): Promise<StoredAsset> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const relPath = `${sha256.slice(0, 2)}/${sha256}.${ext.replace(/^\./, '')}`;
    const absPath = this.abs(relPath);
    if (!fs.existsSync(absPath)) {
      await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
      const tmp = `${absPath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, bytes);
      await fs.promises.rename(tmp, absPath);
    }
    return { relPath, absPath, sha256, bytes: bytes.length };
  }

  /** Deletes a stored file. Callers check first that no row still points at it (see assetInUse). */
  async remove(relPath: string): Promise<void> {
    await fs.promises.rm(this.abs(relPath), { force: true });
  }

  read(relPath: string): Promise<Buffer> {
    return fs.promises.readFile(this.abs(relPath));
  }

  abs(relPath: string): string {
    return path.join(this.root, ...relPath.split('/'));
  }
}

/** Files are content-addressed, so two rows can share one file; only delete it when nothing uses it. */
export function assetInUse(db: Db, relPath: string): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM images WHERE file_path = ?1 OR thumb_path = ?1 OR preview_path = ?1)
           OR EXISTS (SELECT 1 FROM animations WHERE file_path = ?1)
           OR EXISTS (SELECT 1 FROM animation_clips WHERE file_path = ?1) AS used`,
    )
    .get(relPath) as { used: number };
  return row.used === 1;
}

/** Removes each file that no row references any more. */
export async function removeOrphans(db: Db, assets: AssetStore, relPaths: (string | null)[]): Promise<void> {
  for (const relPath of new Set(relPaths)) {
    if (relPath && !assetInUse(db, relPath)) await assets.remove(relPath);
  }
}

export function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'video/mp4':
      return 'mp4';
    default:
      return 'bin';
  }
}
