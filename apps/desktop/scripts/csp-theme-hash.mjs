/**
 * Recomputes the CSP sha256 for the inline theme-bootstrap script in
 * src/renderer/index.html. Run this after changing that script and update
 * the 'sha256-…' token in the Content-Security-Policy meta with the output.
 *
 *   node scripts/csp-theme-hash.mjs
 */
import fs from "node:fs";
import crypto from "node:crypto";

const html = fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
// The theme bootstrap is the inline script starting with an IIFE. (Match on
// the function body, not a bare tag, so this documentation's own markup can
// never confuse the extraction.)
const match = html.match(/<script>(\s*\(function[\s\S]*?)<\/script>/);
if (!match) {
  console.error("theme bootstrap script not found in src/renderer/index.html");
  process.exit(1);
}
console.log("sha256-" + crypto.createHash("sha256").update(match[1], "utf8").digest("base64"));
