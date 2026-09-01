import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  parseDistributionOptions,
  verifyMacExecutableUuids,
} from "../verify-macos-distribution.mjs";

function writeUInt(buffer, value, offset, endian) {
  if (endian === "little") buffer.writeUInt32LE(value, offset);
  else buffer.writeUInt32BE(value, offset);
}

function thinMachO(architecture, uuid) {
  const buffer = Buffer.alloc(56);
  writeUInt(buffer, 0xfeedfacf, 0, "little");
  writeUInt(buffer, architecture === "arm64" ? 0x0100000c : 0x01000007, 4, "little");
  writeUInt(buffer, 2, 12, "little");
  writeUInt(buffer, 1, 16, "little");
  writeUInt(buffer, 24, 20, "little");
  writeUInt(buffer, 0x1b, 32, "little");
  writeUInt(buffer, 24, 36, "little");
  Buffer.from(uuid, "hex").copy(buffer, 40);
  return buffer;
}

function fatMachO(slices) {
  const tableEnd = 8 + slices.length * 20;
  const offsets = [];
  let nextOffset = tableEnd;
  for (const slice of slices) {
    offsets.push(nextOffset);
    nextOffset += slice.buffer.length;
  }
  const buffer = Buffer.alloc(nextOffset);
  buffer.writeUInt32BE(0xcafebabe, 0);
  buffer.writeUInt32BE(slices.length, 4);
  for (const [index, slice] of slices.entries()) {
    const entryOffset = 8 + index * 20;
    buffer.writeUInt32BE(slice.architecture === "arm64" ? 0x0100000c : 0x01000007, entryOffset);
    buffer.writeUInt32BE(offsets[index], entryOffset + 8);
    buffer.writeUInt32BE(slice.buffer.length, entryOffset + 12);
    slice.buffer.copy(buffer, offsets[index]);
  }
  return buffer;
}

test("requires an explicit build architecture and preserves a stock executable override", () => {
  assert.throws(
    () => parseDistributionOptions(["--dist", "dist"]),
    /--arch must be x64, arm64, or universal/,
  );

  assert.deepEqual(
    parseDistributionOptions([
      "--dist",
      "dist-x64",
      "--arch",
      "x64",
      "--stock-electron",
      "fixtures/Electron-x64",
    ]),
    {
      dist: resolve("dist-x64"),
      arch: "x64",
      stockElectron: resolve("fixtures/Electron-x64"),
    },
  );
});

test("accepts a packaged UUID that differs from stock Electron for the same architecture", () => {
  const result = verifyMacExecutableUuids({
    packagedBuffer: thinMachO("arm64", "11112222333344445555666677778888"),
    stockBuffer: thinMachO("arm64", "00112233445566778899aabbccddeeff"),
    expectedArchitectures: ["arm64"],
  });

  assert.deepEqual(result, [
    { architecture: "arm64", uuid: "11112222-3333-4444-5555-666677778888" },
  ]);
});

test("rejects a packaged executable whose UUID equals stock Electron for that architecture", () => {
  assert.throws(
    () => verifyMacExecutableUuids({
      packagedBuffer: thinMachO("x64", "00112233445566778899aabbccddeeff"),
      stockBuffer: thinMachO("x64", "00112233445566778899aabbccddeeff"),
      expectedArchitectures: ["x64"],
    }),
    /x64 UUID.*matches stock Electron/,
  );
});

test("matches universal UUIDs by architecture rather than slice order", () => {
  const stock = fatMachO([
    {
      architecture: "x64",
      buffer: thinMachO("x64", "00112233445566778899aabbccddeeff"),
    },
    {
      architecture: "arm64",
      buffer: thinMachO("arm64", "ffeeddccbbaa99887766554433221100"),
    },
  ]);
  const packaged = fatMachO([
    {
      architecture: "arm64",
      buffer: thinMachO("arm64", "00112233445566778899aabbccddeeff"),
    },
    {
      architecture: "x64",
      buffer: thinMachO("x64", "ffeeddccbbaa99887766554433221100"),
    },
  ]);

  assert.deepEqual(
    verifyMacExecutableUuids({
      packagedBuffer: packaged,
      stockBuffer: stock,
      expectedArchitectures: ["arm64", "x64"],
    }),
    [
      { architecture: "arm64", uuid: "00112233-4455-6677-8899-AABBCCDDEEFF" },
      { architecture: "x64", uuid: "FFEEDDCC-BBAA-9988-7766-554433221100" },
    ],
  );
});

test("rejects a cross-architecture stock executable instead of comparing unrelated UUIDs", () => {
  assert.throws(
    () => verifyMacExecutableUuids({
      packagedBuffer: thinMachO("x64", "11112222333344445555666677778888"),
      stockBuffer: thinMachO("arm64", "00112233445566778899aabbccddeeff"),
      expectedArchitectures: ["x64"],
    }),
    /stock Electron.*expected x64.*found arm64.*--stock-electron/,
  );
});

test("rejects missing packaged UUIDs and unexpected packaged architectures", () => {
  const missingUuid = thinMachO("arm64", "00112233445566778899aabbccddeeff");
  missingUuid.writeUInt32LE(1, 32);
  assert.throws(
    () => verifyMacExecutableUuids({
      packagedBuffer: missingUuid,
      stockBuffer: thinMachO("arm64", "00112233445566778899aabbccddeeff"),
      expectedArchitectures: ["arm64"],
    }),
    /exactly one LC_UUID.*found 0/,
  );

  assert.throws(
    () => verifyMacExecutableUuids({
      packagedBuffer: thinMachO("arm64", "11112222333344445555666677778888"),
      stockBuffer: thinMachO("arm64", "00112233445566778899aabbccddeeff"),
      expectedArchitectures: ["x64"],
    }),
    /packaged executable.*expected x64.*found arm64/,
  );
});
