/**
 * Derives the platform icon set from build/icon.png (created by
 * generate-icon.mjs):
 *   build/icon.icns      macOS (via sips + iconutil)
 *   build/icon.ico       Windows (multi-size, via png-to-ico)
 *   build/icon-512.png   Linux
 * The About dialog uses a copy at src/renderer/src/assets/icon.png — refresh
 * it from build/icon.png if the brand icon changes.
 * Run: node scripts/build-icons.mjs  (or: pnpm icons)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(scriptsDir, "..", "build");
const src = path.join(buildDir, "icon.png");

if (!fs.existsSync(src)) {
  execFileSync(process.execPath, [path.join(scriptsDir, "generate-icon.mjs")], { stdio: "inherit" });
}

function resize(size, outPath) {
  execFileSync("sips", ["-z", String(size), String(size), src, "--out", outPath], { stdio: "pipe" });
}

// --- macOS .icns -------------------------------------------------------------
const iconset = fs.mkdtempSync(path.join(os.tmpdir(), "pb-iconset-"));
const iconsetDir = path.join(iconset, "icon.iconset");
fs.mkdirSync(iconsetDir);
for (const size of [16, 32, 128, 256, 512]) {
  resize(size, path.join(iconsetDir, `icon_${size}x${size}.png`));
  resize(size * 2, path.join(iconsetDir, `icon_${size}x${size}@2x.png`));
}
execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", path.join(buildDir, "icon.icns")]);
fs.rmSync(iconset, { recursive: true, force: true });

// --- Windows .ico (multi-size) ------------------------------------------------
const icoTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pb-ico-"));
const icoPngs = [16, 32, 48, 64, 128, 256].map((size) => {
  const p = path.join(icoTmp, `${size}.png`);
  resize(size, p);
  return p;
});
fs.writeFileSync(path.join(buildDir, "icon.ico"), await pngToIco(icoPngs));
fs.rmSync(icoTmp, { recursive: true, force: true });

// --- Linux 512x512 png ---------------------------------------------------------
resize(512, path.join(buildDir, "icon-512.png"));

for (const f of ["icon.icns", "icon.ico", "icon-512.png"]) {
  console.log(`icon written: ${path.join(buildDir, f)}`);
}
