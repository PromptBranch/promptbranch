/**
 * Dev-only hack (macOS): in dev the app runs the bare Electron binary, whose
 * menu-bar title comes from CFBundleName/CFBundleDisplayName in
 * node_modules/electron/dist/Electron.app/Contents/Info.plist ("Electron").
 * app.setName() cannot change that, so we patch the plist in place and touch
 * the .app so LaunchServices notices. Idempotent; no-ops elsewhere.
 *
 * NOTE: this breaks the dev binary's code signature — fine for local dev,
 * never shipped (packaged builds brand via electron-builder's productName).
 * Re-run automatically via the "postinstall" script.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "PromptBranch";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(packageDir, "node_modules", "electron");

if (process.platform !== "darwin") {
  console.log("patch-electron-name: not macOS, skipping");
  process.exit(0);
}

if (!fs.existsSync(electronDir)) {
  console.log("patch-electron-name: electron not installed yet, skipping");
  process.exit(0);
}

// pnpm symlinks node_modules/electron into .pnpm — resolve to the real dist.
const realDir = fs.realpathSync(electronDir);
const appBundle = path.join(realDir, "dist", "Electron.app");
const plist = path.join(appBundle, "Contents", "Info.plist");

if (!fs.existsSync(plist)) {
  console.log(`patch-electron-name: no Info.plist at ${plist} (unexpected layout), skipping`);
  process.exit(0);
}

const read = (key) => {
  try {
    return execFileSync("plutil", ["-extract", key, "raw", plist], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

if (read("CFBundleName") === APP_NAME && read("CFBundleDisplayName") === APP_NAME) {
  console.log("patch-electron-name: already patched");
  process.exit(0);
}

for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
  if (read(key) === null) {
    execFileSync("plutil", ["-insert", key, "-string", APP_NAME, plist]);
  } else {
    execFileSync("plutil", ["-replace", key, "-string", APP_NAME, plist]);
  }
}

// Bump mtimes and force re-registration so LaunchServices re-reads the
// bundle's plist (it caches the menu-bar title per bundle).
const now = new Date();
for (const p of [appBundle, path.join(appBundle, "Contents")]) {
  fs.utimesSync(p, now, now);
}
try {
  execFileSync(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", appBundle],
  );
} catch {
  console.log("patch-electron-name: lsregister failed; a reboot/relogin may be needed for the menu bar to update");
}

console.log(`patch-electron-name: ${plist} → ${APP_NAME}`);
