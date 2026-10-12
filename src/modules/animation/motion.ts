import type { MotionPlan, MotionPlanner, SoundLayerPlan } from '../../providers/types.ts';

// Keyword → in-place motion. Order matters only for how the suggestion reads.
const MOTION_RULES: { match: RegExp; motion: string }[] = [
  { match: /\b(rain\w*|monsoon\w*|drizzl\w*|storm\w*|downpour\w*)\b/i, motion: 'rain streaming down the window glass and falling steadily outside' },
  { match: /\b(chai|tea|coffee|cup|kettle|steam)\b/i, motion: 'thin wisps of steam rising and curling from the cup' },
  { match: /\b(lamp|lantern|candle|diya|diyas|lights?)\b/i, motion: 'warm lamp and candle light flickering softly' },
  { match: /\b(snow|snowfall|winter)\b/i, motion: 'snowflakes drifting slowly down' },
  { match: /\b(river|ganga|ganges|lake|sea|ocean|backwaters?|water|ghats?)\b/i, motion: 'gentle ripples moving across the water' },
  { match: /\b(tree|trees|palm|palms|leaves|garden|plants?|wind|breeze)\b/i, motion: 'leaves and branches swaying slightly in the breeze' },
  { match: /\b(city|street|traffic|taxis?|road)\b/i, motion: 'blurred city lights shimmering in the distance' },
  { match: /\b(fire|fireplace|stove|hearth|bonfire)\b/i, motion: 'flames flickering in the stove' },
  { match: /\b(mist|fog|cloud|clouds|haze)\b/i, motion: 'mist drifting slowly through the scene' },
  { match: /\b(dust|motes|sunbeams?|sunlight|sunlit)\b/i, motion: 'dust motes drifting slowly through the shafts of sunlight' },
  { match: /\b(thunder|lightning)\b/i, motion: 'a faint, distant flash of lightning lighting the clouds' },
  { match: /\b(stars|starry|night sky)\b/i, motion: 'stars twinkling faintly' },
];

const FALLBACK_MOTION = 'light shifting very gently and faint dust motes drifting in the air';

/** Suggests a Veo motion prompt for a scene: only small, in-place, loopable motion. */
export function suggestMotionPrompt(scenePrompt: string): string {
  const motions = MOTION_RULES.filter((r) => r.match.test(scenePrompt)).map((r) => r.motion);
  const list = motions.length ? motions : [FALLBACK_MOTION];
  return [
    'Static, locked-off camera: no camera movement, no zoom, no pan.',
    `The painting stays still except for subtle, continuous ambient motion: ${joinList(list)}.`,
    'No people appear or move. Objects keep their exact shape. Calm, even pacing so the clip loops seamlessly.',
  ].join(' ');
}

// Variations so keyword-based takes aren't identical.
const TAKE_FLAVOURS = [
  'Very calm and slow; the motion is barely there.',
  'A slightly stronger, steady breeze from the left; light shifts softly.',
  'Gentle, uneven gusts from the right; shadows and reflections drift a little.',
  'Almost still at first, then a soft swell of motion that settles again.',
];

const NO_MUSIC = 'continuous natural ambient field recording, high quality stereo, no music, no speech';

// Keyword → ambient sound layer, for the free fallback. Loudest kinds first.
const SOUND_RULES: { match: RegExp; layer: SoundLayerPlan }[] = [
  { match: /\b(rain\w*|monsoon\w*|drizzl\w*|storm\w*|downpour\w*)\b/i, layer: { category: 'rain', tags: ['rain', 'steady', 'window'], level: 'main', description: `Steady monsoon rain falling on a window and rooftop, close and immersive, ${NO_MUSIC}` } },
  { match: /\b(thunder\w*|lightning|storm\w*)\b/i, layer: { category: 'thunder', tags: ['thunder', 'distant', 'rumble'], level: 'low', description: `Occasional distant rolling thunder far away, sparse and soft, ${NO_MUSIC}` } },
  { match: /\b(river|ganga|ganges|stream|backwaters?|pond|lake|ghats?)\b/i, layer: { category: 'water', tags: ['water', 'gentle', 'lapping'], level: 'medium', description: `Gentle water lapping and flowing softly at the edge of a river, ${NO_MUSIC}` } },
  { match: /\b(sea|ocean|beach|waves)\b/i, layer: { category: 'waves', tags: ['waves', 'shore', 'calm'], level: 'main', description: `Calm sea waves washing onto a sandy shore, slow rhythm, ${NO_MUSIC}` } },
  { match: /\b(city|street|traffic|taxis?|road|mumbai|kolkata|delhi)\b/i, layer: { category: 'city', tags: ['city', 'traffic', 'distant'], level: 'low', description: `Distant Indian city traffic hum with the occasional faraway auto-rickshaw horn, muffled as if heard from indoors, ${NO_MUSIC}` } },
  { match: /\b(wind|breeze|gust|palm|palms|trees?|leaves)\b/i, layer: { category: 'wind', tags: ['wind', 'leaves', 'soft'], level: 'medium', description: `Soft wind moving through palm fronds and leaves, gentle gusts, ${NO_MUSIC}` } },
  { match: /\b(night|midnight|crickets?)\b/i, layer: { category: 'insects', tags: ['crickets', 'night', 'calm'], level: 'low', description: `Crickets chirping on a warm Indian night, steady and calm, ${NO_MUSIC}` } },
  { match: /\b(morning|dawn|sunrise|garden|village|rural|afternoon)\b/i, layer: { category: 'birds', tags: ['birds', 'morning', 'distant'], level: 'low', description: `Distant birdsong in an Indian village, sparrows and an occasional koel, ${NO_MUSIC}` } },
  { match: /\b(fire|fireplace|stove|hearth|bonfire)\b/i, layer: { category: 'fire', tags: ['fire', 'crackling', 'warm'], level: 'medium', description: `A small wood fire crackling softly in a stove, ${NO_MUSIC}` } },
  { match: /\b(train|railway|station)\b/i, layer: { category: 'train', tags: ['train', 'rumble', 'tracks'], level: 'medium', description: `The steady rhythmic rumble of a train on tracks heard from inside a carriage, ${NO_MUSIC}` } },
  { match: /\b(cafe|café|chai stall|tea stall|market)\b/i, layer: { category: 'cafe', tags: ['cafe', 'murmur', 'cups'], level: 'low', description: `Soft indistinct murmur of a small café with clinking cups, no clear words, ${NO_MUSIC}` } },
  { match: /\b(temple|bells?)\b/i, layer: { category: 'bells', tags: ['bells', 'temple', 'distant'], level: 'low', description: `A faraway temple bell ringing now and then, gentle and spacious, ${NO_MUSIC}` } },
];

const DEFAULT_SOUND: SoundLayerPlan = { category: 'interior', tags: ['room tone', 'quiet', 'soft'], level: 'main', description: `Quiet room tone with a very soft distant outdoor hum, ${NO_MUSIC}` };

export function keywordSoundLayers(scenePrompt: string): SoundLayerPlan[] {
  const layers = SOUND_RULES.filter((r) => r.match.test(scenePrompt)).map((r) => r.layer);
  const unique = layers.filter((l, i) => layers.findIndex((x) => x.category === l.category) === i).slice(0, 4);
  if (unique.length === 0) return [DEFAULT_SOUND];
  // Make sure something is the main layer.
  if (!unique.some((l) => l.level === 'main')) unique[0] = { ...unique[0]!, level: 'main' };
  return unique;
}

/**
 * Free fallback when the vision planner isn't available (mock mode, or the Gemini call failed):
 * keyword-based prompts from the scene text, one flavour per take, plus keyword sound layers.
 */
export function keywordMotionPlan(scenePrompt: string, takes: number): MotionPlan {
  const base = suggestMotionPrompt(scenePrompt);
  return {
    summary: 'Suggested from the scene description (the image itself wasn’t analysed).',
    takes: Array.from({ length: takes }, (_, i) => `${base} ${TAKE_FLAVOURS[i % TAKE_FLAVOURS.length]}`),
    sounds: keywordSoundLayers(scenePrompt),
  };
}

export class KeywordMotionPlanner implements MotionPlanner {
  readonly provider = 'local';
  readonly model = 'keywords';
  readonly costPerCallUsd = 0;

  async plan(req: { scenePrompt: string; takes: number }): Promise<MotionPlan> {
    return keywordMotionPlan(req.scenePrompt, req.takes);
  }
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join('; ')}; and ${items.at(-1)}`;
}
