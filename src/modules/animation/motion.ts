// Keyword → in-place motion. Order matters only for how the suggestion reads.
const MOTION_RULES: { match: RegExp; motion: string }[] = [
  { match: /\b(rain|monsoon|drizzle|storm|downpour)\b/i, motion: 'rain streaming down the window glass and falling steadily outside' },
  { match: /\b(chai|tea|coffee|cup|kettle|steam)\b/i, motion: 'thin wisps of steam rising and curling from the cup' },
  { match: /\b(lamp|lantern|candle|diya|diyas|lights?)\b/i, motion: 'warm lamp and candle light flickering softly' },
  { match: /\b(snow|snowfall|winter)\b/i, motion: 'snowflakes drifting slowly down' },
  { match: /\b(river|ganga|ganges|lake|sea|ocean|backwaters?|water|ghats?)\b/i, motion: 'gentle ripples moving across the water' },
  { match: /\b(tree|trees|palm|palms|leaves|garden|plants?)\b/i, motion: 'leaves and palm fronds swaying slightly in the breeze' },
  { match: /\b(city|street|traffic|taxis?|road)\b/i, motion: 'blurred city lights shimmering in the distance' },
  { match: /\b(fire|fireplace|stove|hearth|bonfire)\b/i, motion: 'flames flickering in the stove' },
  { match: /\b(mist|fog|cloud|clouds|haze)\b/i, motion: 'mist drifting slowly through the scene' },
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

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join('; ')}; and ${items.at(-1)}`;
}
