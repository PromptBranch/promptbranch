/**
 * Copies the root LICENSE and THIRD_PARTY_NOTICES.md into every npm-published
 * package so tarballs carry them (npm auto-includes LICENSE; the notices file
 * is whitelisted in each package's "files"). Run before publishing — CI does
 * this in .github/workflows/publish-npm.yml. The copies are gitignored; the
 * root files are the source of truth.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["packages/share", "packages/core", "packages/ai", "packages/mcp", "apps/cli"];

const license = path.join(root, "LICENSE");
const notices = path.join(root, "THIRD_PARTY_NOTICES.md");
if (!fs.existsSync(notices)) {
  console.error("THIRD_PARTY_NOTICES.md missing — run `pnpm notices` first.");
  process.exit(1);
}

for (const target of TARGETS) {
  fs.copyFileSync(license, path.join(root, target, "LICENSE"));
  fs.copyFileSync(notices, path.join(root, target, "THIRD_PARTY_NOTICES.md"));
  console.log(`synced LICENSE + THIRD_PARTY_NOTICES.md → ${target}`);
}
