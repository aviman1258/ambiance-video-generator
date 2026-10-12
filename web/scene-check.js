// Does the text read like a scene description? Shared by the page (to grey out Generate) and the
// server (to refuse junk), so it's plain JavaScript both can import. A heuristic, not a dictionary:
// it catches empty input, keyboard mashing and symbol soup, not every possible nonsense sentence.

const COMMON_WORDS = new Set(
  `a an the in on at of with and by near under over from into through during behind beside above below
   inside outside by its their our my is are was were has have little small big old new quiet cozy cosy
   warm cold soft dark bright light night evening morning afternoon dawn dusk sunset sunrise midnight noon
   day summer winter spring autumn monsoon rain rainy snow snowy mist misty fog foggy storm sunny cloudy
   wind window room house home apartment flat street city town village river lake sea beach mountain
   mountains hill hills garden forest tree trees temple cafe shop market train station rooftop balcony
   courtyard library bookshop kitchen bedroom desk table lamp candle tea chai coffee cup boat road lane
   sky stars moon sun lights view scene`.split(/\s+/),
);

const VOWEL = /[aeiouy]/;

/** Returns why the text isn't usable as a scene, or null when it looks fine. */
export function sceneProblem(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length < 8) return 'Describe the scene in a few words.';

  const nonSpace = trimmed.replace(/\s/g, '');
  const letters = nonSpace.match(/[\p{L}\p{M}]/gu)?.length ?? 0; // \p{M}: Indic vowel signs
  if (letters / nonSpace.length < 0.7) return 'Use words to describe the scene.';

  const words = trimmed.toLowerCase().match(/[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)?/gu) ?? [];
  const plausible = words.filter((w) => {
    if (/[^\x00-\x7f]/.test(w)) return true; // non-Latin scripts and accents: don't second-guess
    if (w.length === 1) return w === 'a' || w === 'i';
    return VOWEL.test(w) && !/[^aeiouy']{5,}/.test(w) && !/(.)\1\1/.test(w);
  });
  if (plausible.length < 2 || plausible.length / words.length < 0.7) return 'That doesn’t look like a scene description yet.';
  if (words.some((w) => !COMMON_WORDS.has(w) && isKeyboardRun(w))) return 'That looks like random typing. Describe the scene in words.';
  return null;
}

const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** "asdf", "qwer", "hjkl", "fdsa": every neighbouring letter pair sits side by side on one keyboard row. */
function isKeyboardRun(word) {
  if (word.length < 3) return false;
  for (let i = 1; i < word.length; i++) {
    const adjacent = KEY_ROWS.some((row) => {
      const a = row.indexOf(word[i - 1]);
      const b = row.indexOf(word[i]);
      return a >= 0 && b >= 0 && Math.abs(a - b) === 1;
    });
    if (!adjacent) return false;
  }
  return true;
}
