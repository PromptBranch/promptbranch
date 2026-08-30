import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

function parseDist(argv) {
  const index = argv.indexOf("--dist");
  const dist = index === -1 ? undefined : argv[index + 1];
  if (!dist) throw new Error("usage: verify-macos-distribution.mjs --dist <directory>");
  return path.resolve(dist);
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

async function main() {
  if (process.platform !== "darwin") throw new Error("macOS distribution verification requires macOS");
  const dist = parseDist(process.argv.slice(2));
  const artifacts = await findArtifacts(dist);
  const app = requireSingle("packaged .app", artifacts.apps);
  const dmg = requireSingle("DMG", artifacts.dmgs);

  run("hdiutil", ["verify", dmg]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", app]);
  run("spctl", ["-a", "-vv", "--type", "execute", app]);
  run("xcrun", ["stapler", "validate", app]);
  console.log(`verified signed and notarized macOS distribution: ${path.basename(dmg)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
