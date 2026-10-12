/** Sniffs the format and pixel size of PNG / JPEG / WebP bytes without decoding them. */
export function imageInfo(bytes: Buffer): { mimeType: string; width?: number; height?: number } {
  // PNG: 8-byte signature, then the IHDR chunk with width/height as big-endian uint32.
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // JPEG: walk the segments until a start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1]!;
      const len = bytes.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { mimeType: 'image/jpeg', height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return { mimeType: 'image/jpeg' };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp' };
  }
  return { mimeType: 'application/octet-stream' };
}
