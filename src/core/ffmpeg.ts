import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

/** FFMPEG_PATH if set, else the binary bundled by ffmpeg-static (works on Render), else "ffmpeg" on PATH. */
export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string | null) || 'ffmpeg';
}

/** Runs ffmpeg; rejects with the tail of its log on failure. Output goes to files, never memory. */
export function runFfmpeg(args: string[], timeoutMs = 300_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ffmpeg (${ffmpegPath()}): ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().slice(-1000)}`));
    });
  });
}

/**
 * Joins clips end to end into one silent MP4 (Veo's own audio is dropped). Tries a lossless
 * stream copy first, since Veo's takes share codec, size and frame rate; falls back to re-encoding
 * if they don't line up.
 */
export async function joinClipsSilently(inputs: string[]): Promise<Buffer> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ambiance-join-'));
  try {
    const out = path.join(dir, 'joined.mp4');
    if (inputs.length === 1) {
      await runFfmpeg(['-i', inputs[0]!, '-an', '-c:v', 'copy', '-movflags', '+faststart', out]);
    } else {
      const list = path.join(dir, 'list.txt');
      await fs.promises.writeFile(list, inputs.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
      try {
        await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-an', '-c:v', 'copy', '-movflags', '+faststart', out]);
      } catch {
        const filter = inputs.map((_, i) => `[${i}:v]`).join('') + `concat=n=${inputs.length}:v=1:a=0[v]`;
        await runFfmpeg([
          ...inputs.flatMap((f) => ['-i', f]),
          '-filter_complex', filter, '-map', '[v]',
          '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
        ]);
      }
    }
    return await fs.promises.readFile(out);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
