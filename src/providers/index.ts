import type { Config } from '../core/config.ts';
import { KeywordMotionPlanner } from '../modules/animation/motion.ts';
import { KeywordTagger } from '../modules/images/tags.ts';
import { GeminiImageGenerator } from './google/image.ts';
import { GeminiMotionPlanner } from './google/motion.ts';
import { GeminiTagger } from './google/tagger.ts';
import { VeoVideoGenerator } from './google/veo.ts';
import { MockImageGenerator, MockVideoGenerator } from './mock/index.ts';
import type { ImageGenerator, ImageTagger, MotionPlanner, VideoGenerator } from './types.ts';

export function createProviders(config: Config): {
  images: ImageGenerator;
  tagger: ImageTagger;
  planner: MotionPlanner;
  videos: VideoGenerator;
} {
  if (config.providers === 'google') {
    const apiKey = config.geminiApiKey!;
    return {
      images: new GeminiImageGenerator({ apiKey, model: config.imageModel, costPerImageUsd: config.imageCostUsd }),
      tagger: new GeminiTagger({ apiKey, model: config.tagModel, costPerCallUsd: config.tagCostUsd }),
      planner: new GeminiMotionPlanner({ apiKey, model: config.motionModel, costPerCallUsd: config.motionCostUsd }),
      videos: new VeoVideoGenerator({ apiKey, model: config.videoModel, costPerSecondUsd: config.videoCostPerSecondUsd }),
    };
  }
  return { images: new MockImageGenerator(), tagger: new KeywordTagger(), planner: new KeywordMotionPlanner(), videos: new MockVideoGenerator() };
}
