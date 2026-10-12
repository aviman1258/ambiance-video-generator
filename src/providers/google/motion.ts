import { z } from 'zod';
import { requestJson } from '../http.ts';
import { type ImageData, type MotionPlan, type MotionPlanner, ProviderError, SOUND_CATEGORIES, type SoundLayerPlan } from '../types.ts';
import { findOutputText } from './tagger.ts';

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

function instructions(takes: number): string {
  return `You direct subtle ambient animation for long, calm YouTube ambiance videos (study, sleep, relax).
The attached illustration will be animated with Google Veo image-to-video. Each clip is 8 seconds,
its FIRST and LAST frame are both exactly this image, and ${takes} different clips ("takes") will be
played back to back on a loop for an hour. So:

- Study the image closely. Name what is actually in it and could plausibly move on its own: water,
  leaves, grass, palm fronds, cloth hanging on a line, smoke or steam, clouds, mist, rain, flames,
  flickering lamps, light and shadow, reflections. Only animate things that are really there.
- Name what must stay perfectly still: buildings, furniture, vehicles, tools, the ground, any people
  or animals (they must not move, appear or leave).
- The camera is locked off: no pan, tilt, zoom, dolly or parallax.
- Motion is gentle, continuous and natural, calm enough to watch for an hour. Nothing enters or
  leaves the frame. No new objects, no text, no sudden events, no flashes unless lightning is
  clearly part of the scene.
- The clip must be able to settle back to the exact starting image at the end.
- Make the ${takes} takes genuinely different but consistent with each other, so the loop doesn't feel
  repetitive: vary which elements lead, the strength and direction of the breeze, the drift of light
  or clouds, the rhythm of ripples. Same scene, same mood, same time of day.

Also design the ambient SOUND of this place, as if recording it in real life, at this time of day
and in this weather and season (the scenes are in India). List 2 to 4 layers that would genuinely be
heard, loudest first: e.g. rain on a window or tin roof, wind through palms, distant city traffic and
the odd auto-rickshaw horn, crickets at night, koel or sparrows in the morning, river water, a crackling
stove, a passing train, a faraway temple bell. Nothing that isn't plausible for the image. No music,
no clear speech.

Return JSON with:
- "summary": one short sentence for the user, naming the main things that will move.
- "takes": exactly ${takes} complete, self-contained Veo prompts (each 60-120 words), each starting
  with the camera instruction and ending with what stays still.
- "sounds": 2 to 4 objects, loudest first, each with:
  - "category": one of ${SOUND_CATEGORIES.join(', ')}
  - "tags": 3 to 6 short lowercase words describing it (e.g. ["monsoon", "heavy", "tin roof"])
  - "level": "main" for the dominant layer, "medium", or "low" for distant background
  - "description": a text-to-audio prompt (25-50 words) for a continuous, natural ambient field
    recording of just that layer, ending with "no music, no speech".`;
}

const PlanJson = z.object({ summary: z.string().min(1), takes: z.array(z.string().min(20)).min(1), sounds: z.unknown().optional() });

/**
 * Writes the motion prompts by looking at the image, with schema-constrained JSON via the
 * Interactions endpoint (same call shape as the tagger).
 */
export class GeminiMotionPlanner implements MotionPlanner {
  readonly provider = 'google';
  readonly model: string;
  readonly costPerCallUsd: number;
  readonly apiKey: string;

  constructor(opts: { apiKey: string; model: string; costPerCallUsd: number }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.costPerCallUsd = opts.costPerCallUsd;
  }

  async plan(req: { image: ImageData; scenePrompt: string; takes: number }): Promise<MotionPlan> {
    const json = await requestJson(INTERACTIONS_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey },
      body: {
        model: this.model,
        input: [
          { type: 'text', text: `${instructions(req.takes)}\n\nThe image was generated from this description: ${req.scenePrompt}` },
          { type: 'image', mime_type: req.image.mimeType, data: req.image.bytes.toString('base64') },
        ],
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              takes: { type: 'array', items: { type: 'string' } },
              sounds: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: { type: 'string', enum: [...SOUND_CATEGORIES] },
                    tags: { type: 'array', items: { type: 'string' } },
                    level: { type: 'string', enum: ['main', 'medium', 'low'] },
                    description: { type: 'string' },
                  },
                  required: ['category', 'tags', 'level', 'description'],
                },
              },
            },
            required: ['summary', 'takes', 'sounds'],
          },
        },
      },
      timeoutMs: 90_000,
      retries: 1,
    });
    const text = findOutputText(json);
    if (!text) throw new ProviderError(`No text in motion-planner response: ${JSON.stringify(json).slice(0, 400)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      throw new ProviderError(`Motion planner returned non-JSON: ${text.slice(0, 300)}`);
    }
    const plan = PlanJson.safeParse(parsed);
    if (!plan.success) throw new ProviderError(`Motion planner returned unexpected JSON: ${text.slice(0, 300)}`);
    const takes = plan.data.takes.map((t) => t.trim()).slice(0, req.takes);
    // If the model returned fewer takes than asked, repeat its best ones rather than fail.
    while (takes.length < req.takes) takes.push(takes[takes.length % plan.data.takes.length]!);
    return { summary: plan.data.summary.trim(), takes, sounds: cleanSounds(plan.data.sounds) };
  }
}

/** Keeps only well-formed layers (at most 4), so one odd entry can't break the mix. */
export function cleanSounds(raw: unknown): SoundLayerPlan[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const layers: SoundLayerPlan[] = [];
  for (const item of raw) {
    const s = SoundJson.safeParse(item);
    if (!s.success) continue;
    const category = (SOUND_CATEGORIES as readonly string[]).includes(s.data.category) ? (s.data.category as SoundLayerPlan['category']) : 'nature';
    const description = /no music/i.test(s.data.description) ? s.data.description.trim() : `${s.data.description.trim()}, no music, no speech`;
    layers.push({ category, tags: s.data.tags.map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 6), level: s.data.level, description });
    if (layers.length === 4) break;
  }
  return layers.length ? layers : undefined;
}

const SoundJson = z.object({
  category: z.string(),
  tags: z.array(z.string()).default([]),
  level: z.enum(['main', 'medium', 'low']).catch('medium'),
  description: z.string().min(10).max(600),
});
