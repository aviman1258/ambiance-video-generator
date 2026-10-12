import type { ImageTagger } from '../../providers/types.ts';

export const MAX_TAGS = 15;
const MAX_TAG_LENGTH = 32;

/** Lowercase, trim, drop "#", collapse spaces, dedupe, cap the count. Invalid tags are dropped. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.toLowerCase().replace(/^#+/, '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (tag.length < 2 || tag.length > MAX_TAG_LENGTH || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

const STOPWORDS = new Set(
  (
    'a an and the of in on at by with without for from to into onto over under near by the this that these those ' +
    'is are was were be being been it its as or but very some few many much more most small big large little tall ' +
    'just only also there here outside inside through across behind below above while who whose which what'
  ).split(' '),
);

/**
 * Free fallback: tags from the scene prompt's own words. Used by mock mode, and whenever the
 * vision tagger fails, so an image is never left untagged.
 */
export function keywordTags(scenePrompt: string): string[] {
  const words = scenePrompt
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return normalizeTags(words).slice(0, 10);
}

export class KeywordTagger implements ImageTagger {
  readonly provider = 'local';
  readonly model = 'keywords';
  readonly costPerCallUsd = 0;

  async tag(req: { scenePrompt: string }): Promise<string[]> {
    return keywordTags(req.scenePrompt);
  }
}
