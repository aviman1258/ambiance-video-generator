import sharp from 'sharp';

export const THUMB_WIDTH = 480;
export const PREVIEW_WIDTH = 1600;

/**
 * The frame sent to Veo: exactly 1920×1080 (its 1080p output size), cropped to 16:9 from the
 * centre. Generated images are close to 16:9 but not exact (e.g. 2752×1536), and a JPEG keeps the
 * request small.
 */
export async function videoFrame(original: Buffer): Promise<{ bytes: Buffer; mimeType: string }> {
  const bytes = await sharp(original).resize(1920, 1080, { fit: 'cover', position: 'centre' }).jpeg({ quality: 92 }).toBuffer();
  return { bytes, mimeType: 'image/jpeg' };
}

/** WebP renditions: a small thumbnail for grids and a phone-friendly preview for the image page. */
export async function makeRenditions(original: Buffer): Promise<{ thumb: Buffer; preview: Buffer }> {
  const [thumb, preview] = await Promise.all([
    sharp(original).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer(),
    sharp(original).resize({ width: PREVIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
  ]);
  return { thumb, preview };
}
