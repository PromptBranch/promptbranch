/**
 * Regenerates THIRD_PARTY_NOTICES.md from the production dependency tree.
 *
 * Source of truth: `pnpm licenses list --prod --json` for name/version/license
 * and each package's own license file inside node_modules/.pnpm for the text.
 * Run after any dependency change (pnpm notices) and commit the result — the
 * file ships in the desktop installers (electron-builder extraResources) and
 * in the CLI/MCP npm tarballs (see scripts/sync-package-licenses.mjs).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "THIRD_PARTY_NOTICES.md");
const MAX_TEXT_BYTES = 20_000; // guard against pathological "license" files

const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

// pnpm returns { "<SPDX>": [{ name, versions: string[] }, ...] }
const entries = [];
for (const [license, packages] of Object.entries(JSON.parse(raw))) {
  for (const pkg of packages) {
    for (const version of pkg.versions) {
      entries.push({ name: pkg.name, version, license });
    }
  }
}
entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// Locate a package in the pnpm virtual store. Scoped names encode "/" as "+"
// and directory names carry an optional "_<peer>@<version>" suffix.
const storeDir = path.join(root, "node_modules", ".pnpm");
const storeDirs = fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : [];
function packageDir(name, version) {
  const prefix = `${name.replace(/\//g, "+")}@`;
  const dir = storeDirs.find((d) => d === `${prefix}${version}` || d.startsWith(`${prefix}${version}_`));
  return dir ? path.join(storeDir, dir, "node_modules", name) : null;
}

const LICENSE_FILES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENSE-MIT",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "COPYING",
  "COPYING.txt",
  "COPYRIGHT",
];
function licenseText(pkgDir) {
  for (const file of LICENSE_FILES) {
    const p = path.join(pkgDir, file);
    try {
      if (fs.statSync(p).isFile()) {
        const text = fs.readFileSync(p, "utf8").trim();
        return text.length > 0 ? text.slice(0, MAX_TEXT_BYTES) : null;
      }
    } catch {
      // missing or unreadable — try the next candidate
    }
  }
  return null;
}

const chunks = [
  `# PromptBranch — Third-Party Notices

PromptBranch (https://promptbranch.app/) is licensed under the MIT License;
see the LICENSE file. This product additionally bundles the following
third-party software packages, used under the licenses below. Entries are
generated from the production dependency tree (\`pnpm licenses list --prod\`);
regenerate with \`pnpm notices\` after dependency changes.

Notes:

- Dual-licensed packages are used under the permissive branch shown; notably
  \`json-schema\` (AFL-2.1 OR BSD-3-Clause) is used under **BSD-3-Clause**.
- The Electron runtime ships with its own \`LICENSE\` and
  \`LICENSES.chromium.html\` (covering Chromium, Node.js and their components),
  which are preserved inside the application bundle.
- The model catalog is fetched at runtime from models.dev (MIT,
  https://github.com/sst/models.dev) and cached locally; it is not bundled.

---
`,
];

let missingText = 0;
for (const { name, version, license } of entries) {
  const dir = packageDir(name, version);
  const text = dir ? licenseText(dir) : null;
  if (text === null) missingText += 1;
  chunks.push(`\n## ${name}@${version}\n\nLicense: ${license}\n`);
  chunks.push(
    text === null
      ? `\n(No license file present in the package; license text for ${license} applies — see https://www.npmjs.com/package/${name}.)\n`
      : `\n\`\`\`\n${text}\n\`\`\`\n`,
  );
}

fs.writeFileSync(OUT, chunks.join(""));
console.log(`THIRD_PARTY_NOTICES.md: ${entries.length} packages, ${missingText} without an in-package license text`);
