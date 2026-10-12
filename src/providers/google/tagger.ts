import { z } from 'zod';
import { requestJson } from '../http.ts';
import { type ImageData, type ImageTagger, ProviderError } from '../types.ts';

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const INSTRUCTIONS =
  'You tag illustrated ambiance background images for a searchable personal library. Look at the attached image ' +
  '(the scene description it was generated from is included for context, but tag only what is actually visible). ' +
  'Return 6 to 12 short lowercase tags of one or two words each, covering where relevant: city or region, setting ' +
  '(e.g. bedroom, cafe, street, rooftop, riverbank), time of day, season, weather, lighting, key objects, mood and ' +
  'dominant colors. Do not include generic tags such as "image", "art", "illustration", "anime" or "painting".';

const TagsJson = z.object({ tags: z.array(z.string()).min(1) });

/**
 * Vision tagging with a cheap Gemini text model via the Interactions endpoint, asking for
 * schema-constrained JSON. Docs: https://ai.google.dev/gemini-api/docs/structured-output (checked 2026-10-12).
 */
export class GeminiTagger implements ImageTagger {
  readonly provider = 'google';
  readonly model: string;
  readonly costPerCallUsd: number;
  readonly apiKey: string;

  constructor(opts: { apiKey: string; model: string; costPerCallUsd: number }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.costPerCallUsd = opts.costPerCallUsd;
  }

  async tag(req: { image: ImageData; scenePrompt: string }): Promise<string[]> {
    const json = await requestJson(INTERACTIONS_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey },
      body: {
        model: this.model,
        input: [
          { type: 'text', text: `${INSTRUCTIONS}\n\nScene description: ${req.scenePrompt}` },
          { type: 'image', mime_type: req.image.mimeType, data: req.image.bytes.toString('base64') },
        ],
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: {
            type: 'object',
            properties: { tags: { type: 'array', items: { type: 'string' } } },
            required: ['tags'],
          },
        },
      },
      timeoutMs: 60_000,
      retries: 1,
    });
    const text = findOutputText(json);
    if (!text) throw new ProviderError(`No text in tagger response: ${JSON.stringify(json).slice(0, 400)}`);
    const parsed = TagsJson.safeParse(safeJson(text));
    if (!parsed.success) throw new ProviderError(`Tagger returned unexpected JSON: ${text.slice(0, 300)}`);
    return parsed.data.tags;
  }
}

/** Prefers a top-level output_text; otherwise the last { type: "text", text } block anywhere in the response. */
export function findOutputText(json: unknown): string | undefined {
  if (json && typeof json === 'object' && typeof (json as Record<string, unknown>).output_text === 'string') {
    return (json as Record<string, string>).output_text;
  }
  let found: string | undefined;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.type === 'text' && typeof obj.text === 'string') found = obj.text;
    for (const value of Object.values(obj)) visit(value);
  };
  visit(json);
  return found;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return undefined;
  }
}
