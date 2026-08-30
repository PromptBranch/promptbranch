import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
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
  const expected = [
    "PromptBranch-0.1.1-macos-arm64.dmg",
    "PromptBranch-0.1.1-macos-arm64.zip",
  ];
  const { dist, out } = await fixture([
    ...expected,
    "latest-mac.yml",
    "PromptBranch-0.1.1-macos-arm64.dmg.blockmap",
    "PromptBranch-0.1.1-windows-arm64.exe",
  ]);

  const result = collect({ platform: "mac", arch: "arm64", version: "0.1.1", dist, out });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(out)).sort(), expected.sort());
});

test("maps every platform and architecture to explicit installer names", async () => {
  const cases = [
    {
      platform: "win",
      arch: "x64",
      expected: ["PromptBranch-0.1.1-windows-x64.exe"],
    },
    {
      platform: "linux",
      arch: "arm64",
      expected: [
        "PromptBranch-0.1.1-linux-arm64.AppImage",
        "PromptBranch-0.1.1-linux-arm64.deb",
      ],
    },
  ];

  for (const entry of cases) {
    const { dist, out } = await fixture(entry.expected);
    const result = collect({ ...entry, version: "0.1.1", dist, out });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(out)).sort(), entry.expected.sort());
  }
});

test("fails closed when an expected installer is missing", async () => {
  const { dist, out } = await fixture(["PromptBranch-0.1.1-macos-x64.dmg"]);

  const result = collect({ platform: "mac", arch: "x64", version: "0.1.1", dist, out });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing expected installer/i);
});
