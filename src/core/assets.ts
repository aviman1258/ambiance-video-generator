import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

  read(relPath: string): Promise<Buffer> {
    return fs.promises.readFile(this.abs(relPath));
  }

  abs(relPath: string): string {
    return path.join(this.root, ...relPath.split('/'));
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
