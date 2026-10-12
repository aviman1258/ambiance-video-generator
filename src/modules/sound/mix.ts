import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../../core/ffmpeg.ts';
import type { SoundLayerPlan } from '../../providers/types.ts';

export const LEVEL_DB: Record<SoundLayerPlan['level'], number> = { main: 0, medium: -7, low: -14 };

/**
 * Bakes ambient layers into a silent looping video so the sound loops with it.
 *
 * Each layer takes a random stretch of its (longer) sound, D + F seconds long, and folds the last F
 * seconds back over the first F with an equal-power crossfade, so the audio's end flows straight
 * into its start: no click or gap where the video loops. Layers are summed at their levels, then
 * loudness-normalised and limited.
 */
export async function mixLoop(opts: {
  videoPath: string;
  durationS: number;
  layers: { path: string; durationS: number | null; gainDb: number }[];
}): Promise<Buffer> {
  const D = opts.durationS;
  const F = Math.min(2, D / 4);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ambiance-mix-'));
  try {
    const out = path.join(dir, 'mixed.mp4');
    const inputs: string[] = ['-i', opts.videoPath];
    const chains: string[] = [];
    opts.layers.forEach((layer, i) => {
      const k = i + 1;
      // Start somewhere random in the sound so different animations get different stretches of it.
      const room = (layer.durationS ?? 0) - (D + F) - 1;
      const offset = room > 0 ? (Math.random() * room).toFixed(2) : '0';
      inputs.push('-stream_loop', '-1', '-ss', offset, '-i', layer.path);
      chains.push(
        `[${k}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=0:${D + F},asetpts=PTS-STARTPTS,volume=${layer.gainDb}dB,asplit=3[h${k}][m${k}][t${k}]`,
        `[h${k}]atrim=0:${F},asetpts=PTS-STARTPTS,afade=t=in:d=${F}:curve=qsin[hi${k}]`,
        `[t${k}]atrim=${D}:${D + F},asetpts=PTS-STARTPTS,afade=t=out:d=${F}:curve=qsin[to${k}]`,
        `[hi${k}][to${k}]amix=inputs=2:normalize=0:duration=first[x${k}]`,
        `[m${k}]atrim=${F}:${D},asetpts=PTS-STARTPTS[mid${k}]`,
        `[x${k}][mid${k}]concat=n=2:v=0:a=1[L${k}]`,
      );
    });
    const labels = opts.layers.map((_, i) => `[L${i + 1}]`).join('');
    const sum = opts.layers.length === 1 ? `${labels}anull[sum]` : `${labels}amix=inputs=${opts.layers.length}:normalize=0[sum]`;
    chains.push(sum, `[sum]loudnorm=I=-18:TP=-2:LRA=11,alimiter=limit=0.85,aresample=44100[aout]`);

    await runFfmpeg([
      ...inputs,
      '-filter_complex', chains.join(';'),
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-t', String(D), '-movflags', '+faststart', out,
    ]);
    return await fs.promises.readFile(out);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
