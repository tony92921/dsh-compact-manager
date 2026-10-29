/** Grayscale and palette PNG encoders (pi-moke encodePngGray). */

import { deflateSync } from "node:zlib";

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n) {
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

function pngChunk(type, data) {
  const tag = Buffer.from(type, "ascii");
  const body = new Uint8Array(tag.length + data.length);
  body.set(tag, 0);
  body.set(data, tag.length);
  const out = new Uint8Array(8 + data.length + 4);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc32(body)), 8 + data.length);
  return out;
}

/**
 * Palette PNG (colour type 3): one byte per pixel indexing `palette` ([[r,g,b], ...]).
 * Same byte-per-pixel payload as the grayscale encoder, so a coloured frame costs no
 * more to ship than a gray one.
 */
export function encodePngPalette(pixels, w, h, palette) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[(w + 1) * y] = 0;
    raw.set(pixels.subarray(y * w, y * w + w), (w + 1) * y + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach((rgb, i) => {
    plte[i * 3] = rgb[0];
    plte[i * 3 + 1] = rgb[1];
    plte[i * 3 + 2] = rgb[2];
  });
  const sig = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  return Buffer.concat([
    Buffer.from(sig),
    Buffer.from(pngChunk("IHDR", ihdr)),
    Buffer.from(pngChunk("PLTE", plte)),
    Buffer.from(pngChunk("IDAT", deflateSync(raw))),
    Buffer.from(pngChunk("IEND", new Uint8Array()))
  ]);
}

export function encodePngGray(pixels, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[(w + 1) * y] = 0;
    raw.set(pixels.subarray(y * w, y * w + w), (w + 1) * y + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const sig = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  return Buffer.concat([
    Buffer.from(sig),
    Buffer.from(pngChunk("IHDR", ihdr)),
    Buffer.from(pngChunk("IDAT", deflateSync(raw))),
    Buffer.from(pngChunk("IEND", new Uint8Array()))
  ]);
}
