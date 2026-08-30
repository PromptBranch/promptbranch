import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../../../.github/workflows/desktop-release.yml", import.meta.url);

async function readStep(name) {
  const workflow = await readFile(workflowUrl, "utf8");
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);

  const end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

test("tagged macOS releases cannot discover or import a signing identity", async () => {
  const step = await readStep("Build and publish unsigned macOS artifacts");

  assert.match(step, /CSC_IDENTITY_AUTO_DISCOVERY:\s*['"]false['"]/);
  assert.doesNotMatch(step, /APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|CSC_LINK|CSC_KEY_PASSWORD/);
});

test("tagged Windows releases cannot import a signing identity", async () => {
  const step = await readStep("Build and publish unsigned Windows artifacts");

  assert.match(step, /CSC_IDENTITY_AUTO_DISCOVERY:\s*['"]false['"]/);
  assert.doesNotMatch(step, /WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD/);
});
