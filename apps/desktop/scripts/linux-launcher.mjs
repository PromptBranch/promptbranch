import { chmod, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

function launcherScript(executableName) {
  const binaryName = `${executableName}-bin`;
  return `#!/bin/sh
binary="$(dirname "$0")/${binaryName}"

for argument in "$@"; do
  case "$argument" in
    --ozone-platform|--ozone-platform=*) exec "$binary" "$@" ;;
  esac
done

exec "$binary" --ozone-platform=x11 "$@"
`;
}

export default async function installLinuxLauncher(context) {
  if (context.electronPlatformName !== "linux") return;

  const executableName = context.packager.executableName;
  const executablePath = join(context.appOutDir, executableName);
  const binaryPath = join(context.appOutDir, `${executableName}-bin`);

  await rename(executablePath, binaryPath);
  await writeFile(executablePath, launcherScript(executableName), { mode: 0o755 });
  await chmod(executablePath, 0o755);
}
