import { join } from "node:path";

import installLinuxLauncher from "./linux-launcher.mjs";
import { replaceMacExecutableUuids } from "./macos-executable-uuid.mjs";

export default async function afterPack(context) {
  await installLinuxLauncher(context);
  if (context.electronPlatformName !== "darwin") return;

  const productFilename = context.packager.appInfo.productFilename;
  const contents = join(context.appOutDir, `${productFilename}.app`, "Contents");
  await replaceMacExecutableUuids({
    executablePath: join(contents, "MacOS", productFilename),
    asarPath: join(contents, "Resources", "app.asar"),
  });
}
