/**
 * Generates apps/desktop/build/icon.png (1024×1024) programmatically:
 * a dark rounded square with a terminal-style ">_" glyph in accent blue.
 * Run: node scripts/generate-icon.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const RADIUS = 230;

// --- geometry ----------------------------------------------------------------

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

function inRoundRect(x, y, w, h, r, px, py) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  return dist2(px, py, cx, cy) <= r * r;
}

function dist2(x1, y1, x2, y2) {
  return (x1 - x2) ** 2 + (y1 - y2) ** 2;
}

/** Squared distance from point to segment. */
function segDist2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return dist2(px, py, x1 + t * dx, y1 + t * dy);
}

// Chevron ">" : two strokes meeting at the tip.
const CHEVRON = [
  [368, 282, 662, 512], // upper stroke -> tip
  [662, 512, 368, 742], // tip -> lower stroke
];
const CHEVRON_STROKE = 118;

// Underscore cursor bar.
const UNDERSCORE = { x: 664, y: 700, w: 196, h: 84, r: 42 };

const BG_TOP = [11, 14, 20]; // #0B0E14
const BG_BOTTOM = [21, 27, 38]; // #151B26
const ACCENT_TOP = [96, 165, 250]; // #60A5FA
const ACCENT_BOTTOM = [37, 99, 235]; // #2563EB
const INK = [230, 234, 242]; // #E6EAF2

function render() {
  const data = Buffer.alloc(SIZE * SIZE * 4);
  for (let py = 0; py < SIZE; py += 1) {
    for (let px = 0; px < SIZE; px += 1) {
      const i = (py * SIZE + px) * 4;
      const t = py / (SIZE - 1);
      let r = lerp(BG_TOP[0], BG_BOTTOM[0], t);
      let g = lerp(BG_TOP[1], BG_BOTTOM[1], t);
      let b = lerp(BG_TOP[2], BG_BOTTOM[2], t);
      let a = 255;

      if (!inRoundRect(0, 0, SIZE, SIZE, RADIUS, px, py)) {
        a = 0; // transparent corners
      } else {
        // Chevron
        const half = CHEVRON_STROKE / 2;
        const onChevron = CHEVRON.some(([x1, y1, x2, y2]) => segDist2(px, py, x1, y1, x2, y2) <= half * half);
        if (onChevron) {
          const at = py / (SIZE - 1);
          r = lerp(ACCENT_TOP[0], ACCENT_BOTTOM[0], at);
          g = lerp(ACCENT_TOP[1], ACCENT_BOTTOM[1], at);
          b = lerp(ACCENT_TOP[2], ACCENT_BOTTOM[2], at);
        }
        // Underscore
        if (inRoundRect(UNDERSCORE.x, UNDERSCORE.y, UNDERSCORE.w, UNDERSCORE.h, UNDERSCORE.r, px, py)) {
          [r, g, b] = INK;
        }
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

// --- minimal PNG encoder (RGBA8, filter 0) ------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "icon.png");
fs.writeFileSync(outPath, encodePng(render(), SIZE));
console.log(`icon written: ${outPath}`);
