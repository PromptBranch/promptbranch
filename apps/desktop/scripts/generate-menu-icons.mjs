/**
 * Generates the monochrome template icons for the native app-menu items
 * (About / Check for Updates / Settings) — 16px + @2x 32px PNGs into
 * build/menu-icons/. Runs as part of the `icons` script; electron-builder
 * ships the folder via extraResources and src/main/menu-icons.ts loads it.
 *
 * Icons are generated, not committed art (like build-icons.mjs): each glyph
 * is a signed-distance field over the 24-unit lucide-style grid, scanline
 * rasterized with 1px coverage antialiasing. Black + alpha only — macOS
 * template-tints them to match the menu bar; Windows/Linux ignore them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------- SDF primitives
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const annulus = (cx, cy, r1, r2) => (x, y) => {
  const d = Math.hypot(x - cx, y - cy);
  return Math.abs(d - (r1 + r2) / 2) - (r2 - r1) / 2;
};
const box = (cx, cy, hw, hh, r = 0) => (x, y) => {
  const dx = Math.abs(x - cx) - hw + r;
  const dy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};
const seg = (x1, y1, x2, y2, r) => (x, y) => {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(x - (x1 + t * vx), y - (y1 + t * vy)) - r;
};
const union = (...fs) => (x, y) => Math.min(...fs.map((f) => f(x, y)));
const subtract = (f, ...holes) => (x, y) => Math.max(f(x, y), ...holes.map((h) => -h(x, y)));
const rotate = (f, cx, cy, a) => (x, y) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - cx;
  const dy = y - cy;
  return f(cx + dx * c + dy * s, cy - dx * s + dy * c);
};
const rad = (deg) => (deg * Math.PI) / 180;
/** Annulus segment between two angles (screen space, deg, clockwise-positive); ends are rounded caps. */
const arc = (cx, cy, r1, r2, a0deg, a1deg) => (x, y) => {
  const ann = annulus(cx, cy, r1, r2)(x, y);
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a0 = rad(a0deg);
  const span = norm(rad(a1deg) - a0);
  if (norm(Math.atan2(y - cy, x - cx) - a0) <= span) return ann;
  const rm = (r1 + r2) / 2;
  const hw = (r2 - r1) / 2;
  const ends = [a0, a0 + span].map((a) => Math.hypot(x - (cx + rm * Math.cos(a)), y - (cy + rm * Math.sin(a))));
  return Math.min(...ends) - hw;
};

// -------------------------------------------------------------------- glyphs
const gearTeeth = [];
for (let k = 0; k < 8; k++) gearTeeth.push(rotate(box(12, 5.6, 1.5, 2.9, 0.9), 12, 12, (k * Math.PI) / 4));

const ICONS = {
  // lucide "info": ring, dot, stem
  about: union(annulus(12, 12, 8.8, 10), circle(12, 8.3, 1.15), seg(12, 11.8, 12, 16.1, 1.15)),
  // lucide-style "refresh-cw": two arcs chasing each other around the circle,
  // each ending in a rounded chevron pointing along the rotation
  "check-updates": union(
    arc(12, 12, 8, 10, -30, 120),
    arc(12, 12, 8, 10, 150, 300),
    seg(21, 3, 21, 8, 1),
    seg(21, 8, 16, 8, 1),
    seg(3, 21, 3, 16, 1),
    seg(3, 16, 8, 16, 1),
  ),
  // lucide-style "settings" gear: ring + 8 teeth − center hole
  settings: subtract(union(annulus(12, 12, 6.9, 8.5), ...gearTeeth), circle(12, 12, 3.4)),
};

// --------------------------------------------------------------- PNG writing
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); // filter 0
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Rasterize a glyph (24-unit space) to a size×size black-alpha template PNG. */
function renderGlyph(glyph, size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 24 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = glyph((x + 0.5) * scale, (y + 0.5) * scale);
      const coverage = Math.min(1, Math.max(0, 0.5 - d / scale));
      const i = (y * size + x) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = Math.round(coverage * 255);
    }
  }
  return encodePng(size, size, rgba);
}

// --------------------------------------------------------------------- main
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "menu-icons");
mkdirSync(outDir, { recursive: true });

for (const [name, glyph] of Object.entries(ICONS)) {
  writeFileSync(path.join(outDir, `${name}.png`), renderGlyph(glyph, 16));
  writeFileSync(path.join(outDir, `${name}@2x.png`), renderGlyph(glyph, 32));
  // ASCII preview at generation time so the glyph is eyeballed, not trusted.
  const preview = [];
  for (let y = 0; y < 12; y++) {
    let row = "";
    for (let x = 0; x < 24; x++) {
      const d = glyph(x + 0.5, y * 2 + 0.5);
      const cov = Math.min(1, Math.max(0, 0.5 - d / 2));
      row += cov > 0.66 ? "██" : cov > 0.25 ? "▓▓" : cov > 0.05 ? "░░" : "  ";
    }
    preview.push(row);
  }
  console.log(`${name}.png (+@2x):\n${preview.join("\n")}\n`);
}
console.log(`menu icons written to ${outDir}`);
