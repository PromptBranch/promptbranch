import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../../../.github/workflows/desktop-release.yml", import.meta.url);
const packageUrl = new URL("../../package.json", import.meta.url);
const macVerifierUrl = new URL("../verify-macos-distribution.mjs", import.meta.url);

test("macOS release builds require signing and notarization credentials", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  for (const secret of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(workflow, new RegExp(`${secret}:\\s*\\$\\{\\{ secrets\\.${secret} \\}\\}`));
  }
  assert.doesNotMatch(workflow, /Build and publish unsigned macOS artifacts/);
  assert.match(workflow, /verify-macos-distribution\.mjs/);
});

test("matrix jobs stage installers but never publish release assets directly", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.doesNotMatch(workflow, /--publish always/);
  assert.match(workflow, /node apps\/desktop\/node_modules\/electron\/install\.js/);
  assert.match(workflow, /collect-release-installers\.mjs/);
  assert.match(workflow, /path:\s*apps\/desktop\/release-artifacts\//);
});

test("one dependent job publishes installer-only artifacts to a draft release", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /publish-release:/);
  assert.match(workflow, /needs:\s*build-desktop/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /--draft/);
  assert.match(workflow, /Reject updater metadata/);
  assert.match(workflow, /\\\( -name '\*\.yml' -o -name '\*\.blockmap' \\\)/);
});

test("electron-builder names every installer with its OS and architecture", async () => {
  const manifest = JSON.parse(await readFile(packageUrl, "utf8"));

  assert.equal(manifest.build.mac.artifactName, "PromptBranch-${version}-macos-${arch}.${ext}");
  assert.equal(manifest.build.win.artifactName, "PromptBranch-${version}-windows-${arch}.${ext}");
  assert.equal(manifest.build.linux.artifactName, "PromptBranch-${version}-linux-${arch}.${ext}");
});

test("macOS verification checks the DMG container and the executable app payload", async () => {
  const verifier = await readFile(macVerifierUrl, "utf8");

  assert.match(verifier, /run\("hdiutil", \["verify", dmg\]\)/);
  assert.match(verifier, /run\("codesign", \["--verify"/);
  assert.match(verifier, /run\("spctl", \["-a"/);
  assert.match(verifier, /run\("xcrun", \["stapler", "validate", app\]\)/);
  assert.doesNotMatch(verifier, /run\("xcrun", \["stapler", "validate", dmg\]\)/);
});
