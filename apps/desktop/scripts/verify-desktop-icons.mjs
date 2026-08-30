import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  let buildDir = path.join(scriptsDir, "..", "build");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--build-dir") throw new Error(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value) throw new Error("Missing value for --build-dir");
    buildDir = path.resolve(value);
    index += 1;
  }
  return buildDir;
}

function readAsset(buildDir, relativePath) {
  const absolutePath = path.join(buildDir, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`${relativePath}: missing icon asset`);
  return fs.readFileSync(absolutePath);
}

function verifyPng(buildDir, relativePath, expectedWidth, expectedHeight) {
  const data = readAsset(buildDir, relativePath);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${relativePath}: invalid PNG header`);
  }

  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(
      `${relativePath}: expected ${expectedWidth}x${expectedHeight}, found ${width}x${height}`,
    );
  }
}

function verifyHeader(buildDir, relativePath, expected, format) {
  const data = readAsset(buildDir, relativePath);
  if (data.length < expected.length || !data.subarray(0, expected.length).equals(expected)) {
    throw new Error(`${relativePath}: invalid ${format} header`);
  }
}

function main() {
  const buildDir = parseArgs(process.argv.slice(2));
  verifyPng(buildDir, "icon.png", 1024, 1024);
  verifyPng(buildDir, "icon-512.png", 512, 512);
  verifyHeader(buildDir, "icon.icns", Buffer.from("icns"), "ICNS");
  verifyHeader(buildDir, "icon.ico", Buffer.from([0, 0, 1, 0]), "ICO");

  for (const name of ["about", "check-updates", "settings"]) {
    verifyPng(buildDir, `menu-icons/${name}.png`, 16, 16);
    verifyPng(buildDir, `menu-icons/${name}@2x.png`, 32, 32);
  }

  console.log(`Verified 10 desktop icon assets in ${buildDir}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
