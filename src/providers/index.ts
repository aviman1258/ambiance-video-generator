import type { Config } from '../core/config.ts';
import { KeywordTagger } from '../modules/images/tags.ts';
import { GeminiImageGenerator } from './google/image.ts';
import { GeminiTagger } from './google/tagger.ts';
import { VeoVideoGenerator } from './google/veo.ts';
import { MockImageGenerator, MockVideoGenerator } from './mock/index.ts';
import type { ImageGenerator, ImageTagger, VideoGenerator } from './types.ts';

export function createProviders(config: Config): { images: ImageGenerator; tagger: ImageTagger; videos: VideoGenerator } {
  if (config.providers === 'google') {
    const apiKey = config.geminiApiKey!;
    return {
      images: new GeminiImageGenerator({ apiKey, model: config.imageModel, costPerImageUsd: config.imageCostUsd }),
      tagger: new GeminiTagger({ apiKey, model: config.tagModel, costPerCallUsd: config.tagCostUsd }),
      videos: new VeoVideoGenerator({ apiKey, model: config.videoModel, costPerSecondUsd: config.videoCostPerSecondUsd }),
    };
  }
  return { images: new MockImageGenerator(), tagger: new KeywordTagger(), videos: new MockVideoGenerator() };
}
