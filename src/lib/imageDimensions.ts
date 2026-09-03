// src/lib/imageDimensions.ts
//
// Reads pixel dimensions directly from JPEG/PNG bytes — no image library
// dependency, just the two header formats the AI grading upload path ever
// sees (mobile and web both hardcode JPEG output; PNG is supported here
// defensively, since two real production reports turned up as PNG from an
// unidentified source — see AI-grading-perception-fix notes, 2026-09).
// Used server-side for the minimum-resolution input floor on
// /grading/ai-analyze — nothing this small should reach Gemini at all.

export interface ImageDimensions {
  width: number;
  height: number;
}

function jpegDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not a JPEG (SOI marker)
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) break; // EOI
    const len = buf.readUInt16BE(i + 2);
    // SOF0-SOF15 except the DHT/DAC/DNL markers, which share the range but aren't frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return { width, height };
    }
    i += 2 + len;
  }
  return null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // IHDR is always the first chunk, immediately after the signature:
  // 4 bytes length, 4 bytes "IHDR", 4 bytes width, 4 bytes height.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

/** Returns null for anything that isn't a JPEG or PNG this parser recognizes — callers treat that as "can't verify size," not as a specific dimension. */
export function readImageDimensions(base64: string): ImageDimensions | null {
  try {
    const buf = Buffer.from(base64, "base64");
    return jpegDimensions(buf) ?? pngDimensions(buf);
  } catch {
    return null;
  }
}
