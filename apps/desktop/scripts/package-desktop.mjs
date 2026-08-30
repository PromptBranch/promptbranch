import { spawnSync } from "node:child_process";

const builderArguments = process.argv.slice(2);
const targetsWindows =
  process.platform === "win32" ||
  builderArguments.some(
    (argument) => argument === "--win" || argument === "-w" || argument.startsWith("--win="),
  );
const environment = { ...process.env };

if (targetsWindows) {
  // electron-builder 26.15's newer 7-Zip can choose filters that the older
  // NSIS extractor silently skips, leaving the installed app without its EXE.
  environment.ELECTRON_BUILDER_7Z_FILTER = "BCJ";
}

const result = spawnSync("electron-builder", builderArguments, {
  env: environment,
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
