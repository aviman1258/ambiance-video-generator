export type ImageData = { bytes: Buffer; mimeType: string };

export type ImageRequest = {
  prompt: string;
  /** Optional images the model should use as a visual reference ("more like this"). */
  referenceImages?: ImageData[];
  aspectRatio: '16:9';
  size: '1K' | '2K' | '4K';
};

export interface ImageGenerator {
  readonly provider: string;
  readonly model: string;
  /** Cost of one generate() call in USD (0 for mocks). */
  readonly costPerImageUsd: number;
  generate(req: ImageRequest): Promise<ImageData>;
}

/** Looks at a generated image and returns short search tags for it. */
export interface ImageTagger {
  readonly provider: string;
  readonly model: string;
  readonly costPerCallUsd: number;
  tag(req: { image: ImageData; scenePrompt: string }): Promise<string[]>;
}

export const SOUND_CATEGORIES = [
  'rain', 'wind', 'thunder', 'water', 'waves', 'birds', 'insects', 'city', 'traffic',
  'crowd', 'cafe', 'train', 'fire', 'interior', 'bells', 'nature',
] as const;
export type SoundCategory = (typeof SOUND_CATEGORIES)[number];

/** One ambient layer for a scene, loudest first. `description` is the text-to-audio prompt. */
export type SoundLayerPlan = {
  category: SoundCategory;
  tags: string[];
  level: 'main' | 'medium' | 'low';
  description: string;
};

/**
 * A plan for animating one image: a short description, one complete Veo prompt per take, and the
 * ambient sound layers the scene would really have.
 */
export type MotionPlan = { summary: string; takes: string[]; sounds?: SoundLayerPlan[] };

/** Makes an ambient sound from a text description. */
export interface SoundGenerator {
  readonly provider: string;
  readonly model: string;
  readonly costPerSoundUsd: number;
  /** Plain-language licence note stored with every sound it makes. */
  readonly license: string;
  generate(req: { prompt: string; seconds: number }): Promise<{ bytes: Buffer; ext: string }>;
}

/** Looks at an image and writes Veo motion prompts that suit it. */
export interface MotionPlanner {
  readonly provider: string;
  readonly model: string;
  readonly costPerCallUsd: number;
  plan(req: { image: ImageData; scenePrompt: string; takes: number }): Promise<MotionPlan>;
}

export type VideoRequest = {
  prompt: string;
  firstFrame: ImageData;
  /** Pass the same image as firstFrame to get a clip that loops back to its start. */
  lastFrame?: ImageData;
  durationSeconds: 4 | 6 | 8;
  resolution: '720p' | '1080p';
};

export type VideoStatus =
  | { state: 'running' }
  | { state: 'succeeded'; videoRef: string }
  | { state: 'failed'; error: string };

/** Video generation is asynchronous: start() returns an operation id that check() polls. */
export interface VideoGenerator {
  readonly provider: string;
  readonly model: string;
  estimateCostUsd(durationSeconds: number): number;
  start(req: VideoRequest): Promise<{ operationId: string }>;
  check(operationId: string): Promise<VideoStatus>;
  download(videoRef: string): Promise<Buffer>;
}

/** Thrown for provider errors; retryable ones (429/5xx/network) may be retried by the caller. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, opts: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
  }
}
