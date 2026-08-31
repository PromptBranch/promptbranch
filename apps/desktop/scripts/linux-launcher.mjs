import { chmod, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

function launcherScript(executableName) {
  const binaryName = `${executableName}-bin`;
  return `#!/bin/sh
launcher="$0"
while [ -L "$launcher" ]; do
  launcher_dir="$(cd -P "$(dirname "$launcher")" >/dev/null 2>&1 && pwd)"
  launcher_target="$(readlink "$launcher")"
  case "$launcher_target" in
    /*) launcher="$launcher_target" ;;
    *) launcher="$launcher_dir/$launcher_target" ;;
  esac
done
binary="$(cd -P "$(dirname "$launcher")" >/dev/null 2>&1 && pwd)/${binaryName}"

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
