import { requestBytes } from '../http.ts';
import { ProviderError, type SoundGenerator } from '../types.ts';

const TEXT_TO_AUDIO_URL = 'https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio';

/**
 * Stable Audio text-to-audio: multipart form in, audio bytes out (Accept: audio/*).
 * Docs: https://platform.stability.ai/docs/api-reference (Text-to-Audio; up to ~190 s at 44.1 kHz
 * stereo for stable-audio-2.5). Stability's terms assign the outputs to the customer.
 */
export class StableAudioGenerator implements SoundGenerator {
  readonly provider = 'stability';
  readonly model: string;
  readonly costPerSoundUsd: number;
  readonly license = 'Generated with Stability AI Stable Audio via API; Stability’s terms assign outputs to the customer. No attribution required.';
  readonly apiKey: string;

  constructor(opts: { apiKey: string; model: string; costPerSoundUsd: number }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.costPerSoundUsd = opts.costPerSoundUsd;
  }

  async generate(req: { prompt: string; seconds: number }): Promise<{ bytes: Buffer; ext: string }> {
    const form = new FormData();
    form.append('prompt', req.prompt);
    form.append('model', this.model);
    form.append('duration', String(Math.max(1, Math.min(190, Math.round(req.seconds)))));
    form.append('output_format', 'mp3');
    const bytes = await requestBytes(TEXT_TO_AUDIO_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'audio/*' },
      body: form,
      timeoutMs: 240_000,
      retries: 0, // a timeout retry could pay twice
    });
    if (bytes.length < 1000) throw new ProviderError(`Stable Audio returned an unexpectedly small file (${bytes.length} bytes)`);
    return { bytes, ext: 'mp3' };
  }
}
