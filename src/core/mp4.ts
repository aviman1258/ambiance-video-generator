/** Reads an MP4's duration (seconds) from its movie header, without ffprobe. */
export function mp4DurationSeconds(bytes: Buffer): number | undefined {
  const i = bytes.indexOf('mvhd');
  if (i < 4) return undefined;
  const version = bytes[i + 4];
  const timescale = version === 1 ? bytes.readUInt32BE(i + 24) : bytes.readUInt32BE(i + 16);
  const duration = version === 1 ? Number(bytes.readBigUInt64BE(i + 28)) : bytes.readUInt32BE(i + 20);
  return timescale > 0 ? duration / timescale : undefined;
}

/** True if the MP4 has an audio track (a "soun" handler). */
export function mp4HasAudio(bytes: Buffer): boolean {
  return bytes.includes('soun');
}
