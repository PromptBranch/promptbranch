import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../verify-desktop-icons.mjs", import.meta.url));

function png(width, height) {
  const buffer = Buffer.alloc(24);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function writeValidFixture() {
  const buildDir = mkdtempSync(path.join(tmpdir(), "promptbranch-icons-"));
  const menuDir = path.join(buildDir, "menu-icons");
  mkdirSync(menuDir);

  writeFileSync(path.join(buildDir, "icon.png"), png(1024, 1024));
  writeFileSync(path.join(buildDir, "icon-512.png"), png(512, 512));
  writeFileSync(path.join(buildDir, "icon.icns"), Buffer.from("icns"));
  writeFileSync(path.join(buildDir, "icon.ico"), Buffer.from([0, 0, 1, 0]));

  for (const name of ["about", "check-updates", "settings"]) {
    writeFileSync(path.join(menuDir, `${name}.png`), png(16, 16));
    writeFileSync(path.join(menuDir, `${name}@2x.png`), png(32, 32));
  }

  return buildDir;
}

function runVerifier(buildDir) {
  return spawnSync(process.execPath, [scriptPath, "--build-dir", buildDir], {
    encoding: "utf8",
  });
}

test("accepts complete cross-platform desktop icon assets", () => {
  const result = runVerifier(writeValidFixture());

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified 10 desktop icon assets/);
});

test("rejects an icon asset with the wrong dimensions", () => {
  const buildDir = writeValidFixture();
  writeFileSync(path.join(buildDir, "icon-512.png"), png(256, 256));

  const result = runVerifier(buildDir);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /icon-512\.png.*expected 512x512.*found 256x256/);
});

test("rejects a missing generated platform icon", () => {
  const buildDir = writeValidFixture();
  writeFileSync(path.join(buildDir, "icon.ico"), Buffer.from("broken"));

  const result = runVerifier(buildDir);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /icon\.ico.*invalid ICO header/);
});
