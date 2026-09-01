import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../collect-release-installers.mjs", import.meta.url));
const tempDirectories = [];

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "promptbranch-release-assets-"));
  tempDirectories.push(root);
  const dist = join(root, "dist");
  const out = join(root, "release-artifacts");
  await mkdir(dist);
  for (const file of files) await writeFile(join(dist, file), file);
  return { dist, out };
}

function collect({ platform, arch, version, dist, out }) {
  return spawnSync(
    process.execPath,
    [
      scriptPath,
      "--platform",
      platform,
      "--arch",
      arch,
      "--version",
      version,
      "--dist",
      dist,
      "--out",
      out,
    ],
    { encoding: "utf8" },
  );
}

test.afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

test("copies only clearly named macOS installers", async () => {
  const expected = ["promptbranch_0.1.0_macos_arm64.dmg"];
  const { dist, out } = await fixture([
    ...expected,
    "promptbranch_0.1.0_macos_arm64.zip",
    "latest-mac.yml",
    "promptbranch_0.1.0_macos_arm64.dmg.blockmap",
    "promptbranch_0.1.0_windows_arm64.exe",
  ]);

  const result = collect({ platform: "mac", arch: "arm64", version: "0.1.0", dist, out });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(out)).sort(), expected.sort());
});

test("maps every platform and architecture to explicit installer names", async () => {
  const cases = [
    {
      platform: "win",
      arch: "x64",
      expected: ["promptbranch_0.1.0_windows_x64.exe"],
    },
    {
      platform: "linux",
      arch: "arm64",
      expected: [
        "promptbranch_0.1.0_linux_arm64.AppImage",
        "promptbranch_0.1.0_linux_arm64.deb",
      ],
    },
  ];

  for (const entry of cases) {
    const { dist, out } = await fixture(entry.expected);
    const result = collect({ ...entry, version: "0.1.0", dist, out });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(out)).sort(), entry.expected.sort());
  }
});

test("fails closed when an expected installer is missing", async () => {
  const { dist, out } = await fixture(["promptbranch_0.1.0_macos_x64.zip"]);

  const result = collect({ platform: "mac", arch: "x64", version: "0.1.0", dist, out });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing expected installer/i);
});

test("electron-builder uses explicit lowercase platform and architecture names", async () => {
  const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.build.artifactName, undefined);
  assert.equal(manifest.build.mac.artifactName, "promptbranch_${version}_macos_${arch}.${ext}");
  assert.equal(manifest.build.win.artifactName, "promptbranch_${version}_windows_${arch}.${ext}");
  assert.equal(manifest.build.linux.artifactName, "promptbranch_${version}_linux_${arch}.${ext}");
});

test("macOS packaging produces only DMG installers", async () => {
  const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.deepEqual(manifest.build.mac.target, [{ target: "dmg" }]);
});

test("Linux installers force the X11 backend for reliable VM launches", async () => {
  const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.deepEqual(manifest.build.linux.executableArgs, ["--ozone-platform=x11"]);
});

test("AppImage builds use the static runtime toolset", async () => {
  const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.equal(manifest.build.toolsets.appimage, "1.0.3");
});

test("Debian packages declare every required Electron runtime library", async () => {
  const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.deepEqual(manifest.build.deb.depends, [
    "libgtk-3-0",
    "libnotify4",
    "libnss3",
    "libxss1",
    "libxtst6",
    "xdg-utils",
    "libatspi2.0-0",
    "libuuid1",
    "libsecret-1-0",
    "libgbm1",
    "libasound2t64 | libasound2",
  ]);
});
