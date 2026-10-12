import sharp from 'sharp';

export const THUMB_WIDTH = 480;
export const PREVIEW_WIDTH = 1600;

/** WebP renditions: a small thumbnail for grids and a phone-friendly preview for the image page. */
export async function makeRenditions(original: Buffer): Promise<{ thumb: Buffer; preview: Buffer }> {
  const [thumb, preview] = await Promise.all([
    sharp(original).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer(),
    sharp(original).resize({ width: PREVIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
  ]);
  return { thumb, preview };
}
