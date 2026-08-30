import { access, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const optionNames = new Set(["platform", "arch", "version", "dist", "out"]);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${flag ?? ""}`);
    const name = flag.slice(2);
    if (!optionNames.has(name)) throw new Error(`unknown option: ${flag}`);
    options[name] = value;
  }
  for (const name of optionNames) {
    if (!options[name]) throw new Error(`missing required option: --${name}`);
  }
  return options;
}

function expectedInstallerNames(platform, arch, version) {
  const platformConfig = {
    mac: { os: "macos", extensions: ["dmg", "zip"] },
    win: { os: "windows", extensions: ["exe"] },
    linux: { os: "linux", extensions: ["AppImage", "deb"] },
  }[platform];
  if (!platformConfig) throw new Error(`unsupported platform: ${platform}`);
  if (arch !== "arm64" && arch !== "x64") throw new Error(`unsupported architecture: ${arch}`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid release version: ${version}`);

  return platformConfig.extensions.map(
    (extension) => `promptbranch_${version}_${platformConfig.os}_${arch}.${extension}`,
  );
}

async function main() {
  const { platform, arch, version, dist, out } = parseArgs(process.argv.slice(2));
  const expected = expectedInstallerNames(platform, arch, version);

  for (const name of expected) {
    try {
      await access(path.join(dist, name));
    } catch {
      throw new Error(`missing expected installer: ${name}`);
    }
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const name of expected) await copyFile(path.join(dist, name), path.join(out, name));
  console.log(`staged ${expected.length} installer(s): ${expected.join(", ")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
