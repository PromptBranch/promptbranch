/**
 * CI license gate: fails the build when any production dependency carries an
 * unknown/missing or copyleft / source-disclosure / non-commercial license
 * (GPL family, SSPL, EUPL, OSL, Sleepycat, NC variants, …). Permissive
 * licenses (MIT, ISC, BSD, Apache-2.0, 0BSD, MPL dev-side, etc.) pass.
 */
import { execFileSync } from "node:child_process";

const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

const DENY = [
  /unknown/i,
  /^$/,
  /\bGPL\b/i,
  /\bAGPL\b/i,
  /\bLGPL\b/i,
  /\bSSPL\b/i,
  /\bEUPL\b/i,
  /\bOSL\b/i,
  /\bSleepycat\b/i,
  /\bQPL\b/i,
  /\bRPL\b/i,
  /CC-BY-NC/i,
  /NON-COMMERCIAL/i,
];

const offenders = [];
for (const [license, packages] of Object.entries(JSON.parse(raw))) {
  if (DENY.some((re) => re.test(license))) {
    for (const pkg of packages) offenders.push(`${pkg.name}@${pkg.versions.join(",")} — ${license}`);
  }
}

if (offenders.length > 0) {
  console.error("License check FAILED — denied licenses in the production tree:");
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}

const count = Object.values(JSON.parse(raw)).reduce((n, ps) => n + ps.reduce((m, p) => m + p.versions.length, 0), 0);
console.log(`License check OK — ${count} production packages, no copyleft/unknown licenses.`);
