#!/usr/bin/env node

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const platformLayouts = {
  mac: {
    format: "Mach-O",
    nativePrefix: "darwin",
    unpackedDirectory: { x64: "mac", arm64: "mac-arm64" },
    executable: "PromptBranch.app/Contents/MacOS/PromptBranch",
    resources: "PromptBranch.app/Contents/Resources",
  },
  win: {
    format: "PE",
    nativePrefix: "win32",
    unpackedDirectory: { x64: "win-unpacked", arm64: "win-arm64-unpacked" },
    executable: "PromptBranch.exe",
    resources: "resources",
  },
  linux: {
    format: "ELF",
    nativePrefix: "linux",
    unpackedDirectory: { x64: "linux-unpacked", arm64: "linux-arm64-unpacked" },
    executable: "promptbranch",
    resources: "resources",
  },
};

const nativeModuleDirectory = path.join(
  "app.asar.unpacked",
  "node_modules",
  "better-sqlite3",
  "prebuilds",
);

function architectureName(cpu) {
  if (cpu === 0x01000007 || cpu === 0x8664 || cpu === 62) return "x64";
  if (cpu === 0x0100000c || cpu === 0xaa64 || cpu === 183) return "arm64";
  return `unknown(0x${cpu.toString(16)})`;
}

function parseMachO(buffer) {
  const thinMagic = 0xfeedfacf;
  const littleEndian = buffer.readUInt32LE(0) === thinMagic;
  const bigEndian = buffer.readUInt32BE(0) === thinMagic;
  if (littleEndian || bigEndian) {
    const cpu = littleEndian ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
    return { format: "Mach-O", architectures: [architectureName(cpu)] };
  }

  const fatMagic = 0xcafebabe;
  const fat64Magic = 0xcafebabf;
  const magicBE = buffer.readUInt32BE(0);
  const magicLE = buffer.readUInt32LE(0);
  const fatBigEndian = magicBE === fatMagic || magicBE === fat64Magic;
  const fatLittleEndian = magicLE === fatMagic || magicLE === fat64Magic;
  if (!fatBigEndian && !fatLittleEndian) return null;

  const readUInt32 = fatBigEndian
    ? (offset) => buffer.readUInt32BE(offset)
    : (offset) => buffer.readUInt32LE(offset);
  const magic = fatBigEndian ? magicBE : magicLE;
  const entrySize = magic === fat64Magic ? 32 : 20;
  const count = readUInt32(4);
  if (count === 0 || 8 + count * entrySize > buffer.length) {
    throw new Error("Truncated Mach-O universal binary header");
  }

  const architectures = [];
  for (let index = 0; index < count; index += 1) {
    architectures.push(architectureName(readUInt32(8 + index * entrySize)));
  }
  return { format: "Mach-O", architectures: [...new Set(architectures)] };
}

function parsePe(buffer) {
  if (buffer.length < 64 || buffer.toString("ascii", 0, 2) !== "MZ") return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length || buffer.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("Truncated or invalid PE header");
  }
  return {
    format: "PE",
    architectures: [architectureName(buffer.readUInt16LE(peOffset + 4))],
  };
}

function parseElf(buffer) {
  if (
    buffer.length < 20 ||
    buffer[0] !== 0x7f ||
    buffer.toString("ascii", 1, 4) !== "ELF"
  ) {
    return null;
  }
  const endianness = buffer[5];
  if (endianness !== 1 && endianness !== 2) throw new Error("Unsupported ELF byte order");
  const cpu = endianness === 1 ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18);
  return { format: "ELF", architectures: [architectureName(cpu)] };
}

export function readBinaryInfo(buffer) {
  if (buffer.length < 8) throw new Error("Binary header is too short");
  const info = parseMachO(buffer) ?? parsePe(buffer) ?? parseElf(buffer);
  if (!info) throw new Error("Unsupported binary format");
  return info;
}

function readBinaryHeader(filePath) {
  const size = Math.min(statSync(filePath).size, 64 * 1024);
  const buffer = Buffer.alloc(size);
  const descriptor = openSync(filePath, "r");
  try {
    readSync(descriptor, buffer, 0, size, 0);
  } finally {
    closeSync(descriptor);
  }
  return buffer;
}

function verifyBinary(filePath, label, expectedFormat, expectedArch) {
  if (!existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
  const info = readBinaryInfo(readBinaryHeader(filePath));
  if (info.format !== expectedFormat) {
    throw new Error(`${filePath}: expected ${expectedFormat}, found ${info.format}`);
  }
  if (info.architectures.length !== 1 || info.architectures[0] !== expectedArch) {
    throw new Error(
      `${filePath}: expected ${expectedArch}, found ${info.architectures.join(", ")}`,
    );
  }
  return info;
}

export function verifyReleaseArchitecture({ platform, arch, dist }) {
  const layout = platformLayouts[platform];
  if (!layout) throw new Error(`Unsupported platform: ${platform}`);
  if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported architecture: ${arch}`);
  if (!dist) throw new Error("Missing --dist path");

  const unpackedRoot = path.resolve(dist, layout.unpackedDirectory[arch]);
  const executablePath = path.join(unpackedRoot, layout.executable);
  const nativeName = `${layout.nativePrefix}-${arch}.node`;
  const nativePath = path.join(unpackedRoot, layout.resources, nativeModuleDirectory, nativeName);
  const executableInfo = verifyBinary(
    executablePath,
    "packaged application executable",
    layout.format,
    arch,
  );
  const nativeInfo = verifyBinary(
    nativePath,
    `selected runtime native module (${nativeName})`,
    layout.format,
    arch,
  );

  return { executablePath, nativePath, executableInfo, nativeInfo };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near: ${flag ?? "<end>"}`);
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

function main() {
  const { platform, arch, dist } = parseArgs(process.argv.slice(2));
  const result = verifyReleaseArchitecture({ platform, arch, dist });
  console.log(
    `Verified ${platform}-${arch}: ${path.basename(result.executablePath)} and ${path.basename(result.nativePath)}`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
