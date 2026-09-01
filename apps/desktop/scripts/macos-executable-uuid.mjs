import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const LC_UUID = 0x1b;
const CPU_NAMES = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);

function readUInt32(buffer, offset, endian) {
  return endian === "little" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function readUInt64(buffer, offset, endian) {
  const value = endian === "little"
    ? buffer.readBigUInt64LE(offset)
    : buffer.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Mach-O offset or size ${value} exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

function checkedEnd(offset, size, limit, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0) {
    throw new Error(`${label} has an unsafe offset or size`);
  }
  const end = offset + size;
  if (!Number.isSafeInteger(end) || end > limit) {
    throw new Error(`${label} extends beyond file bounds`);
  }
  return end;
}

function thinFormat(buffer, offset) {
  if (offset + 4 > buffer.length) return undefined;
  switch (buffer.readUInt32BE(offset)) {
    case 0xfeedface:
      return { endian: "big", is64: false };
    case 0xcefaedfe:
      return { endian: "little", is64: false };
    case 0xfeedfacf:
      return { endian: "big", is64: true };
    case 0xcffaedfe:
      return { endian: "little", is64: true };
    default:
      return undefined;
  }
}

function fatFormat(buffer) {
  if (buffer.length < 4) return undefined;
  switch (buffer.readUInt32BE(0)) {
    case 0xcafebabe:
      return { endian: "big", is64: false };
    case 0xbebafeca:
      return { endian: "little", is64: false };
    case 0xcafebabf:
      return { endian: "big", is64: true };
    case 0xbfbafeca:
      return { endian: "little", is64: true };
    default:
      return undefined;
  }
}

function architectureName(cpuType) {
  const name = CPU_NAMES.get(cpuType);
  if (!name) throw new Error(`unsupported Mach-O CPU type 0x${cpuType.toString(16)}`);
  return name;
}

function parseThinSlice(buffer, slice, declaredArchitecture) {
  const format = thinFormat(buffer, slice.offset);
  if (!format) throw new Error(`${slice.label} does not contain a supported thin Mach-O header`);

  const headerSize = format.is64 ? 32 : 28;
  if (slice.size < headerSize) throw new Error(`${slice.label} has a truncated Mach-O header`);
  const headerEnd = checkedEnd(slice.offset, headerSize, buffer.length, `${slice.label} header`);
  const cpuType = readUInt32(buffer, slice.offset + 4, format.endian);
  const architecture = architectureName(cpuType);
  if (!format.is64) {
    throw new Error(`${slice.label} uses an unsupported 32-bit Mach-O header for ${architecture}`);
  }
  if (declaredArchitecture && architecture !== declaredArchitecture) {
    throw new Error(
      `${slice.label} architecture ${architecture} does not match FAT header ${declaredArchitecture}`,
    );
  }

  const commandCount = readUInt32(buffer, slice.offset + 16, format.endian);
  const commandBytes = readUInt32(buffer, slice.offset + 20, format.endian);
  if (commandCount > Math.floor(commandBytes / 8)) {
    throw new Error(`${architecture} slice declares too many load commands for its command table`);
  }
  const sliceEnd = checkedEnd(slice.offset, slice.size, buffer.length, `${architecture} slice`);
  const commandTableEnd = checkedEnd(headerEnd, commandBytes, sliceEnd, `${architecture} load commands`);

  const uuidOffsets = [];
  let commandOffset = headerEnd;
  for (let index = 0; index < commandCount; index += 1) {
    if (commandOffset + 8 > commandTableEnd) {
      throw new Error(`${architecture} slice has a truncated load command header at index ${index}`);
    }
    const command = readUInt32(buffer, commandOffset, format.endian);
    const commandSize = readUInt32(buffer, commandOffset + 4, format.endian);
    if (commandSize < 8 || commandSize % 8 !== 0) {
      throw new Error(`${architecture} slice has invalid load command size ${commandSize} at index ${index}`);
    }
    const nextCommand = checkedEnd(
      commandOffset,
      commandSize,
      commandTableEnd,
      `${architecture} load command ${index}`,
    );
    if (command === LC_UUID) {
      if (commandSize !== 24) {
        throw new Error(`${architecture} slice has invalid LC_UUID command size ${commandSize}`);
      }
      uuidOffsets.push(commandOffset + 8);
    }
    commandOffset = nextCommand;
  }
  if (commandOffset !== commandTableEnd) {
    throw new Error(`${architecture} slice load commands do not consume the declared command table`);
  }
  if (uuidOffsets.length !== 1) {
    throw new Error(
      `${architecture} slice must contain exactly one LC_UUID command; found ${uuidOffsets.length}`,
    );
  }

  const uuidOffset = uuidOffsets[0];
  return {
    architecture,
    uuidOffset,
    uuidBytes: Buffer.from(buffer.subarray(uuidOffset, uuidOffset + 16)),
  };
}

function parseFatSlices(buffer, format) {
  if (buffer.length < 8) throw new Error("truncated Mach-O FAT header");
  const architectureCount = readUInt32(buffer, 4, format.endian);
  if (architectureCount === 0) throw new Error("Mach-O FAT header contains no architecture slices");
  const entrySize = format.is64 ? 32 : 20;
  const tableSize = architectureCount * entrySize;
  if (!Number.isSafeInteger(tableSize)) throw new Error("Mach-O FAT architecture table is unsafe");
  const tableEnd = checkedEnd(8, tableSize, buffer.length, "Mach-O FAT architecture table");
  const slices = [];
  const architectures = new Set();

  for (let index = 0; index < architectureCount; index += 1) {
    const entryOffset = 8 + index * entrySize;
    const cpuType = readUInt32(buffer, entryOffset, format.endian);
    const architecture = architectureName(cpuType);
    if (architectures.has(architecture)) {
      throw new Error(`Mach-O FAT header contains duplicate ${architecture} slices`);
    }
    architectures.add(architecture);

    const offset = format.is64
      ? readUInt64(buffer, entryOffset + 8, format.endian)
      : readUInt32(buffer, entryOffset + 8, format.endian);
    const size = format.is64
      ? readUInt64(buffer, entryOffset + 16, format.endian)
      : readUInt32(buffer, entryOffset + 12, format.endian);
    const alignment = readUInt32(buffer, entryOffset + (format.is64 ? 24 : 16), format.endian);
    if (format.is64 && readUInt32(buffer, entryOffset + 28, format.endian) !== 0) {
      throw new Error(`${architecture} FAT64 entry has a non-zero reserved field`);
    }
    if (size === 0) throw new Error(`${architecture} slice is empty`);
    if (offset < tableEnd) throw new Error(`${architecture} slice overlaps the Mach-O FAT header`);
    checkedEnd(offset, size, buffer.length, `${architecture} slice`);
    if (alignment > 63 || BigInt(offset) % (1n << BigInt(alignment)) !== 0n) {
      throw new Error(`${architecture} slice offset does not satisfy FAT alignment 2^${alignment}`);
    }
    slices.push({ architecture, offset, size, label: `${architecture} slice` });
  }

  const byOffset = [...slices].sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < byOffset.length; index += 1) {
    const previous = byOffset[index - 1];
    const current = byOffset[index];
    if (previous.offset + previous.size > current.offset) {
      throw new Error(`${previous.architecture} and ${current.architecture} slices overlap`);
    }
  }

  return slices.map((slice) => parseThinSlice(buffer, slice, slice.architecture));
}

function parseMachOUuids(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("Mach-O input must be a Buffer");
  if (buffer.length < 4) throw new Error("Mach-O file is too short");
  const fat = fatFormat(buffer);
  if (fat) return parseFatSlices(buffer, fat);
  if (!thinFormat(buffer, 0)) throw new Error("unsupported Mach-O magic");
  return [parseThinSlice(buffer, { offset: 0, size: buffer.length, label: "thin Mach-O" })];
}

function formatUuid(uuidBytes) {
  const hex = uuidBytes.toString("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function readMachOUuids(buffer) {
  return parseMachOUuids(buffer).map(({ architecture, uuidBytes }) => ({
    architecture,
    uuid: formatUuid(uuidBytes),
  }));
}

export async function replaceMacExecutableUuids({ executablePath, asarPath }) {
  const [executable, asar] = await Promise.all([readFile(executablePath), readFile(asarPath)]);
  const slices = parseMachOUuids(executable);
  const asarDigest = createHash("sha256").update(asar).digest();
  const output = Buffer.from(executable);

  const replacements = slices.map(({ architecture, uuidOffset, uuidBytes }) => {
    // The original UUID acts as the per-slice namespace, while the packaged
    // payload digest makes otherwise identical Electron executables app-specific.
    const newUuid = createHash("sha256")
      .update(uuidBytes)
      .update(asarDigest)
      .digest()
      .subarray(0, 16);
    newUuid.copy(output, uuidOffset);
    return { architecture, uuid: formatUuid(newUuid) };
  });

  // Parsing and derivation finish for every slice before the executable is opened for writing.
  await writeFile(executablePath, output);
  return replacements;
}
