import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readMachOUuids } from "./macos-executable-uuid.mjs";

const defaultStockElectron = fileURLToPath(
  new URL("../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", import.meta.url),
);

export function parseDistributionOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${flag ?? "<end>"}`);
    }
    const name = flag.slice(2);
    if (name !== "dist" && name !== "arch" && name !== "stock-electron") {
      throw new Error(`unknown option --${name}`);
    }
    values[name] = value;
  }
  if (!values.dist) {
    throw new Error(
      "usage: verify-macos-distribution.mjs --dist <directory> --arch <x64|arm64|universal> [--stock-electron <executable>]",
    );
  }
  if (values.arch !== "x64" && values.arch !== "arm64" && values.arch !== "universal") {
    throw new Error("--arch must be x64, arm64, or universal");
  }
  return {
    dist: path.resolve(values.dist),
    arch: values.arch,
    stockElectron: path.resolve(values["stock-electron"] ?? defaultStockElectron),
  };
}

async function findArtifacts(directory, result = { apps: [], dmgs: [] }) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".app")) result.apps.push(entryPath);
      else await findArtifacts(entryPath, result);
    } else if (entry.isFile() && entry.name.endsWith(".dmg")) {
      result.dmgs.push(entryPath);
    }
  }
  return result;
}

function requireSingle(label, values) {
  if (values.length !== 1) {
    throw new Error(`expected exactly one ${label}, found ${values.length}: ${values.join(", ")}`);
  }
  return values[0];
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit" });
}

function sameArchitectures(actual, expected) {
  return actual.length === expected.length && expected.every((arch) => actual.includes(arch));
}

export function verifyMacExecutableUuids({
  packagedBuffer,
  stockBuffer,
  expectedArchitectures,
}) {
  const packaged = readMachOUuids(packagedBuffer);
  const stock = readMachOUuids(stockBuffer);
  const packagedArchitectures = packaged.map(({ architecture }) => architecture);
  const stockArchitectures = stock.map(({ architecture }) => architecture);

  if (!sameArchitectures(packagedArchitectures, expectedArchitectures)) {
    throw new Error(
      `packaged executable: expected ${expectedArchitectures.join(", ")}, found ${packagedArchitectures.join(", ")}`,
    );
  }
  const stockByArchitecture = new Map(stock.map((entry) => [entry.architecture, entry.uuid]));
  const missingStock = expectedArchitectures.filter((architecture) => !stockByArchitecture.has(architecture));
  if (missingStock.length > 0) {
    throw new Error(
      `stock Electron: expected ${missingStock.join(", ")}, found ${stockArchitectures.join(", ")}; supply a matching executable with --stock-electron`,
    );
  }

  const packagedByArchitecture = new Map(
    packaged.map((entry) => [entry.architecture, entry]),
  );
  return expectedArchitectures.map((architecture) => {
    const packagedEntry = packagedByArchitecture.get(architecture);
    if (packagedEntry.uuid === stockByArchitecture.get(architecture)) {
      throw new Error(
        `packaged ${architecture} UUID ${packagedEntry.uuid} matches stock Electron`,
      );
    }
    return packagedEntry;
  });
}

async function main() {
  if (process.platform !== "darwin") throw new Error("macOS distribution verification requires macOS");
  const { dist, arch, stockElectron } = parseDistributionOptions(process.argv.slice(2));
  const artifacts = await findArtifacts(dist);
  const app = requireSingle("packaged .app", artifacts.apps);
  const dmg = requireSingle("DMG", artifacts.dmgs);
  const executable = path.join(app, "Contents", "MacOS", path.basename(app, ".app"));
  const expectedArchitectures = arch === "universal" ? ["arm64", "x64"] : [arch];
  const uuids = verifyMacExecutableUuids({
    packagedBuffer: await readFile(executable),
    stockBuffer: await readFile(stockElectron),
    expectedArchitectures,
  });

  run("hdiutil", ["verify", dmg]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", app]);
  run("spctl", ["-a", "-vv", "--type", "execute", app]);
  run("xcrun", ["stapler", "validate", app]);
  console.log(`verified packaged UUIDs: ${uuids.map(({ architecture, uuid }) => `${architecture}=${uuid}`).join(", ")}`);
  console.log(`verified signed and notarized macOS distribution: ${path.basename(dmg)}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
