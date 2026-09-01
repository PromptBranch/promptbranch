import { join } from "node:path";

import installLinuxLauncher from "./linux-launcher.mjs";
import { replaceMacExecutableUuids } from "./macos-executable-uuid.mjs";

// These are electron-builder's stable Arch enum values. Keep them local so the
// packaging hook does not import builder-util through pnpm's transitive layout.
const universalTempSuffixByArch = new Map([
  [1, "-x64-temp"],
  [3, "-arm64-temp"],
]);

function isUniversalTempPack(context) {
  const suffix = universalTempSuffixByArch.get(context.arch);
  return suffix !== undefined && context.appOutDir.endsWith(suffix);
}

export default async function afterPack(context) {
  await installLinuxLauncher(context);
  if (context.electronPlatformName !== "darwin") return;
  // electron-builder invokes afterPack for both temporary thin apps before
  // merging them, then invokes it again for the final universal app.
  if (isUniversalTempPack(context)) return;

  const productFilename = context.packager.appInfo.productFilename;
  const contents = join(context.appOutDir, `${productFilename}.app`, "Contents");
  await replaceMacExecutableUuids({
    executablePath: join(contents, "MacOS", productFilename),
    asarPath: join(contents, "Resources", "app.asar"),
  });
}
