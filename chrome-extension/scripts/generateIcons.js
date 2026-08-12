/**
 * Draws the toolbar icons into public/icons/ as PNGs.
 *
 * Hand-rolled rather than pulled from a design tool so the icons are
 * reproducible from source: `just icons` regenerates every size.
 *
 * The mark is a gauge — a ring that is a little over two thirds full — on a
 * rounded square in Claude's coral. It reads at 16px because it is two shapes
 * and nothing else.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const ICON_SIZES = [16, 32, 48, 128];

const BACKGROUND_COLOR = [217, 119, 87]; // #D97757
const FOREGROUND_COLOR = [255, 255, 255];

/** Samples per axis; 4 means 16 samples per pixel, which is plenty for these shapes. */
const SUPERSAMPLE_FACTOR = 4;

const GAUGE_FILLED_FRACTION = 0.7;
const GAUGE_SWEEP_RADIANS = 1.5 * Math.PI;
const GAUGE_START_RADIANS = 0.75 * Math.PI;

function isInsideRoundedSquare(x, y, size, cornerRadius) {
  const nearestX = Math.min(Math.max(x, cornerRadius), size - cornerRadius);
  const nearestY = Math.min(Math.max(y, cornerRadius), size - cornerRadius);
  const isInCornerBox = x < cornerRadius || x > size - cornerRadius;
  const isInCornerBand = y < cornerRadius || y > size - cornerRadius;

  if (!isInCornerBox || !isInCornerBand) return x >= 0 && x <= size && y >= 0 && y <= size;

  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= cornerRadius * cornerRadius;
}

/**
 * Angle around the gauge as a 0..1 fraction of its sweep, measured clockwise
 * from the bottom-left end of the arc. Returns null for angles in the gap.
 */
function gaugeFraction(dx, dy) {
  // Screen y grows downward; negate so the maths is in normal orientation.
  let angle = Math.atan2(-dy, dx);
  // Rotate so the arc's start sits at 0.
  let fromStart = GAUGE_START_RADIANS - angle;
  while (fromStart < 0) fromStart += 2 * Math.PI;
  while (fromStart >= 2 * Math.PI) fromStart -= 2 * Math.PI;

  return fromStart > GAUGE_SWEEP_RADIANS ? null : fromStart / GAUGE_SWEEP_RADIANS;
}

/** Returns [r, g, b, a] for one sample point, or null for transparent. */
function sampleIcon(x, y, size) {
  if (!isInsideRoundedSquare(x, y, size, size * 0.22)) return null;

  const center = size / 2;
  const dx = x - center;
  const dy = y - center;
  const distance = Math.sqrt(dx * dx + dy * dy);

  const outerRadius = size * 0.34;
  const innerRadius = size * 0.21;

  if (distance <= outerRadius && distance >= innerRadius) {
    const fraction = gaugeFraction(dx, dy);
    if (fraction !== null) {
      // Filled part of the gauge is solid; the remaining track is faint.
      const alpha = fraction <= GAUGE_FILLED_FRACTION ? 255 : 90;
      return [...FOREGROUND_COLOR, alpha];
    }
  }

  return [...BACKGROUND_COLOR, 255];
}

function renderIconPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / SUPERSAMPLE_FACTOR;

  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      let totals = [0, 0, 0, 0];
      let sampleCount = 0;

      for (let subY = 0; subY < SUPERSAMPLE_FACTOR; subY += 1) {
        for (let subX = 0; subX < SUPERSAMPLE_FACTOR; subX += 1) {
          const sample = sampleIcon(
            pixelX + (subX + 0.5) * step,
            pixelY + (subY + 0.5) * step,
            size,
          );
          sampleCount += 1;
          if (sample === null) continue;

          // Premultiply so partially transparent edges blend correctly.
          const alpha = sample[3] / 255;
          totals = [
            totals[0] + sample[0] * alpha,
            totals[1] + sample[1] * alpha,
            totals[2] + sample[2] * alpha,
            totals[3] + sample[3],
          ];
        }
      }

      const averageAlpha = totals[3] / sampleCount;
      const alphaWeight = totals[3] / 255;
      const offset = (pixelY * size + pixelX) * 4;

      pixels[offset] = alphaWeight === 0 ? 0 : Math.round(totals[0] / alphaWeight);
      pixels[offset + 1] = alphaWeight === 0 ? 0 : Math.round(totals[1] / alphaWeight);
      pixels[offset + 2] = alphaWeight === 0 ? 0 : Math.round(totals[2] / alphaWeight);
      pixels[offset + 3] = Math.round(averageAlpha);
    }
  }

  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));

  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type (0 = none).
  const rowLength = size * 4;
  const raw = Buffer.alloc((rowLength + 1) * size);
  for (let row = 0; row < size; row += 1) {
    raw[row * (rowLength + 1)] = 0;
    pixels.copy(raw, row * (rowLength + 1) + 1, row * rowLength, (row + 1) * rowLength);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

for (const size of ICON_SIZES) {
  const path = join(OUTPUT_DIRECTORY, `icon-${size}.png`);
  writeFileSync(path, encodePng(renderIconPixels(size), size));
  console.log(`wrote ${path}`);
}
