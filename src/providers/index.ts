import type { Config } from '../core/config.ts';
import { GeminiImageGenerator } from './google/image.ts';
import { VeoVideoGenerator } from './google/veo.ts';
import { MockImageGenerator, MockVideoGenerator } from './mock/index.ts';
import type { ImageGenerator, VideoGenerator } from './types.ts';

export function createProviders(config: Config): { images: ImageGenerator; videos: VideoGenerator } {
  if (config.providers === 'google') {
    const apiKey = config.geminiApiKey!;
    return {
      images: new GeminiImageGenerator({ apiKey, model: config.imageModel, costPerImageUsd: config.imageCostUsd }),
      videos: new VeoVideoGenerator({ apiKey, model: config.videoModel, costPerSecondUsd: config.videoCostPerSecondUsd }),
    };
  }
  return { images: new MockImageGenerator(), videos: new MockVideoGenerator() };
}
