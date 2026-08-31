import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";

const builderArguments = process.argv.slice(2);
const targetsLinux = builderArguments.some(
  (argument) => argument === "--linux" || argument === "-l" || argument.startsWith("--linux="),
);
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
if (result.status === 0 && targetsLinux) {
  for (const name of readdirSync("dist")) {
    const normalizedName = name.replace(/_linux_(?:x86_64|amd64)(?=\.)/, "_linux_x64");
    if (normalizedName === name) continue;

    const source = path.join("dist", name);
    const destination = path.join("dist", normalizedName);
    if (existsSync(destination)) {
      throw new Error(`cannot normalize Linux artifact because destination exists: ${normalizedName}`);
    }
    renameSync(source, destination);
  }
}
process.exitCode = result.status ?? 1;
