import { imageInfo } from '../../core/imageInfo.ts';
import { requestJson } from '../http.ts';
import { type ImageData, type ImageGenerator, type ImageRequest, ProviderError } from '../types.ts';

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/**
 * Gemini image generation via the Interactions endpoint.
 * Docs: https://ai.google.dev/gemini-api/docs/image-generation (checked 2026-10-12).
 * One call returns one image, so a batch of 6 is 6 calls.
 */
export class GeminiImageGenerator implements ImageGenerator {
  readonly provider = 'google';
  readonly model: string;
  readonly costPerImageUsd: number;
  readonly apiKey: string;

  constructor(opts: { apiKey: string; model: string; costPerImageUsd: number }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.costPerImageUsd = opts.costPerImageUsd;
  }

  async generate(req: ImageRequest): Promise<ImageData> {
    const refs = req.referenceImages ?? [];
    const input =
      refs.length === 0
        ? req.prompt
        : [
            { type: 'text', text: req.prompt },
            ...refs.map((r) => ({ type: 'image', mime_type: r.mimeType, data: r.bytes.toString('base64') })),
          ];

    const json = await requestJson(INTERACTIONS_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey },
      body: {
        model: this.model,
        input,
        response_format: { type: 'image', aspect_ratio: req.aspectRatio, image_size: req.size },
      },
      timeoutMs: 180_000,
    });

    const block = findLastImageBlock(json);
    if (!block) {
      throw new ProviderError(`No image in Gemini response: ${JSON.stringify(json).slice(0, 600)}`);
    }
    const bytes = Buffer.from(block.data, 'base64');
    const sniffed = imageInfo(bytes).mimeType;
    return { bytes, mimeType: sniffed !== 'application/octet-stream' ? sniffed : (block.mimeType ?? 'image/png') };
  }
}

/**
 * The docs show image output as content blocks shaped like { type: "image", data: <base64> }
 * nested inside steps/outputs, without pinning down the raw REST envelope. Rather than
 * hardcode one path, walk the JSON and take the last image block found.
 */
export function findLastImageBlock(json: unknown): { data: string; mimeType?: string } | undefined {
  let found: { data: string; mimeType?: string } | undefined;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.type === 'image' && typeof obj.data === 'string' && obj.data.length > 100) {
      const mime = obj.mime_type ?? obj.mimeType;
      found = { data: obj.data, ...(typeof mime === 'string' ? { mimeType: mime } : {}) };
    }
    const inline = (obj.inlineData ?? obj.inline_data) as Record<string, unknown> | undefined;
    if (inline && typeof inline.data === 'string') {
      const mime = inline.mimeType ?? inline.mime_type;
      found = { data: inline.data, ...(typeof mime === 'string' ? { mimeType: mime } : {}) };
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(json);
  return found;
}
