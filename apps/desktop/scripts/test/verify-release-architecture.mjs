import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../verify-release-architecture.mjs", import.meta.url));

const layouts = {
  "mac-arm64": {
    executable: "mac-arm64/PromptBranch.app/Contents/MacOS/PromptBranch",
    native: "mac-arm64/PromptBranch.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
  },
  "mac-x64": {
    executable: "mac/PromptBranch.app/Contents/MacOS/PromptBranch",
    native: "mac/PromptBranch.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-x64.node",
  },
  "win-arm64": {
    executable: "win-arm64-unpacked/PromptBranch.exe",
    native: "win-arm64-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-arm64.node",
  },
  "win-x64": {
    executable: "win-unpacked/PromptBranch.exe",
    native: "win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node",
  },
  "linux-arm64": {
    executable: "linux-arm64-unpacked/promptbranch-bin",
    native: "linux-arm64-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-arm64.node",
  },
  "linux-x64": {
    executable: "linux-unpacked/promptbranch-bin",
    native: "linux-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node",
  },
};

function machO(arch) {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  return buffer;
}

function pe(arch) {
  const buffer = Buffer.alloc(128);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(64, 0x3c);
  buffer.write("PE\0\0", 64, "binary");
  buffer.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 68);
  return buffer;
}

function elf(arch) {
  const buffer = Buffer.alloc(64);
  buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  buffer.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
  return buffer;
}

function binary(platform, arch) {
  if (platform === "mac") return machO(arch);
  if (platform === "win") return pe(arch);
  return elf(arch);
}

function writeFixture(platform, expectedArch, { executableArch = expectedArch, nativeArch = expectedArch } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "promptbranch-release-arch-"));
  const layout = layouts[`${platform}-${expectedArch}`];
  assert.ok(layout, `missing test layout for ${platform}-${expectedArch}`);

  for (const [relativePath, arch] of [
    [layout.executable, executableArch],
    [layout.native, nativeArch],
  ]) {
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, binary(platform, arch));
  }

  return { root, layout };
}

function runVerifier(platform, arch, dist) {
  return spawnSync(
    process.execPath,
    [scriptPath, "--platform", platform, "--arch", arch, "--dist", dist],
    { encoding: "utf8" },
  );
}

for (const platform of ["mac", "win", "linux"]) {
  for (const arch of ["x64", "arm64"]) {
    test(`accepts a ${platform}-${arch} app and runtime native module`, () => {
      const { root } = writeFixture(platform, arch);
      const result = runVerifier(platform, arch, root);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`Verified ${platform}-${arch}`));
    });
  }
}

test("rejects an app executable built for the wrong architecture", () => {
  const { root } = writeFixture("mac", "arm64", { executableArch: "x64" });
  const result = runVerifier("mac", "arm64", root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /PromptBranch.*expected arm64.*found x64/);
});

test("rejects a selected runtime native module built for the wrong architecture", () => {
  const { root } = writeFixture("linux", "x64", { nativeArch: "arm64" });
  const result = runVerifier("linux", "x64", root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /linux-x64\.node.*expected x64.*found arm64/);
});

test("rejects a package with no selected runtime native module", () => {
  const layout = layouts["win-x64"];
  assert.ok(layout);
  const missingRoot = mkdtempSync(path.join(tmpdir(), "promptbranch-release-arch-missing-"));
  const executable = path.join(missingRoot, layout.executable);
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, binary("win", "x64"));

  const result = runVerifier("win", "x64", missingRoot);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing selected runtime native module.*win32-x64\.node/);
});

test("rejects unsupported platform and architecture values", () => {
  const result = runVerifier("solaris", "riscv64", tmpdir());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported platform: solaris/);
});
