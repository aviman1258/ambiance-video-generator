export type StylePreset = { id: string; label: string; artDirection: string };

/**
 * The look is described in plain words rather than by naming a studio: providers sometimes
 * refuse studio names, and the descriptive version is steadier across models.
 */
export const STYLE_PRESETS: Record<string, StylePreset> = {
  'anime-painterly': {
    id: 'anime-painterly',
    label: 'Hand-painted anime (Ghibli-like)',
    artDirection:
      'Hand-painted anime background art in the tradition of classic Japanese animated films: soft gouache and ' +
      'watercolor textures, visible brushwork, lush environmental detail, warm natural light with gentle ' +
      'atmospheric perspective, rich but harmonious colors, a cozy and nostalgic mood. Wide cinematic 16:9 ' +
      'composition with clear depth (foreground, midground, background) that is calm enough to look at for hours, ' +
      'with areas where subtle motion can happen (rain, steam, flickering light, drifting mist).',
  },
};

export const DEFAULT_STYLE_PRESET = 'anime-painterly';

// Channel-wide rules applied to every image, whatever the scene (see docs/ARCHITECTURE.md §1b).
const THEME_RULES =
  'The setting is in India: depict architecture, objects, clothing and everyday details authentically and ' +
  'respectfully, avoiding stereotypes. Religious places and objects may appear as atmosphere, never as decoration ' +
  'or in careless contexts.';

const CONSTRAINTS =
  'Absolutely no text, letters, numbers, signage, logos, captions or watermarks anywhere in the image. ' +
  'No people or animals in the foreground; at most tiny, distant, indistinct figures. ' +
  'No recognizable copyrighted characters or brands. A still, stable, eye-level view.';

export function buildImagePrompt(scenePrompt: string, presetId: string = DEFAULT_STYLE_PRESET): string {
  const preset = STYLE_PRESETS[presetId];
  if (!preset) throw new Error(`Unknown style preset: ${presetId}`);
  return [`Scene: ${scenePrompt.trim()}`, `Art direction: ${preset.artDirection}`, THEME_RULES, CONSTRAINTS].join('\n\n');
}

export function buildVariationPrompt(scenePrompt: string, presetId: string = DEFAULT_STYLE_PRESET): string {
  return [
    'Create a new variation of the attached reference image. Keep its setting, composition, palette and mood, ' +
      'but vary the details, lighting nuances and arrangement so it is clearly a different painting.',
    buildImagePrompt(scenePrompt, presetId),
  ].join('\n\n');
}
