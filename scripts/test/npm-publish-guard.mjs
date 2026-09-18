import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const guardPath = path.join(root, "scripts/require-pnpm-publish.mjs");
const guardedPackages = ["apps/cli", "packages/mcp"];
const expectedScript = "node ../../scripts/require-pnpm-publish.mjs";

for (const packageDir of guardedPackages) {
  const manifestPath = path.join(root, packageDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(
    manifest.scripts?.prepublishOnly,
    expectedScript,
    `${manifest.name} must refuse npm publication from the workspace`,
  );
  assert.equal(
    manifest.scripts?.prepack,
    `${expectedScript} && pnpm build`,
    `${manifest.name} must refuse npm packing from the workspace`,
  );
}

function runGuard(userAgent) {
  return spawnSync(process.execPath, [guardPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_user_agent: userAgent },
  });
}

const npmAttempt = runGuard("npm/11.0.0 node/v22.0.0 darwin arm64");
assert.notEqual(npmAttempt.status, 0, "npm publication must be rejected");
assert.match(
  `${npmAttempt.stdout}${npmAttempt.stderr}`,
  /pnpm publish/i,
  "the rejected publication must explain the supported command",
);

const pnpmAttempt = runGuard("pnpm/11.7.0 npm/? node/v22.0.0 darwin arm64");
assert.equal(pnpmAttempt.status, 0, pnpmAttempt.stderr || pnpmAttempt.stdout);

console.log("npm publication guard passed");
