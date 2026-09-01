import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import afterPack from "../after-pack.mjs";
import {
  readMachOUuids,
  replaceMacExecutableUuids,
} from "../macos-executable-uuid.mjs";

const CPU = {
  x64: 0x01000007,
  arm64: 0x0100000c,
};
const tempDirectories = [];

test.afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function writeUInt(buffer, value, offset, endian) {
  if (endian === "little") buffer.writeUInt32LE(value, offset);
  else buffer.writeUInt32BE(value, offset);
}

function uuidCommand(uuid) {
  const command = Buffer.alloc(24);
  command.writeUInt32LE(0x1b, 0);
  command.writeUInt32LE(24, 4);
  Buffer.from(uuid, "hex").copy(command, 8);
  return command;
}

function thinMachO({
  arch = "arm64",
  uuid = "00112233445566778899aabbccddeeff",
  endian = "little",
  is64 = true,
  commands,
} = {}) {
  const loadCommands = commands ?? [uuidCommand(uuid)];
  const headerSize = is64 ? 32 : 28;
  const commandBytes = Buffer.concat(loadCommands);
  const buffer = Buffer.alloc(headerSize + commandBytes.length);
  const magic = is64 ? 0xfeedfacf : 0xfeedface;

  writeUInt(buffer, magic, 0, endian);
  writeUInt(buffer, CPU[arch] ?? 0x01234567, 4, endian);
  writeUInt(buffer, 0, 8, endian);
  writeUInt(buffer, 2, 12, endian);
  writeUInt(buffer, loadCommands.length, 16, endian);
  writeUInt(buffer, commandBytes.length, 20, endian);
  writeUInt(buffer, 0, 24, endian);
  if (is64) writeUInt(buffer, 0, 28, endian);

  if (endian === "big") {
    let commandOffset = 0;
    for (const command of loadCommands) {
      const size = command.readUInt32LE(4);
      command.writeUInt32BE(command.readUInt32LE(0), 0);
      command.writeUInt32BE(size, 4);
      command.copy(commandBytes, commandOffset);
      commandOffset += command.length;
    }
  }
  commandBytes.copy(buffer, headerSize);
  return buffer;
}

function align(value, multiple) {
  return Math.ceil(value / multiple) * multiple;
}

function fatMachO(slices, { endian = "big", is64 = false } = {}) {
  const entrySize = is64 ? 32 : 20;
  const tableEnd = 8 + entrySize * slices.length;
  const entries = [];
  let sliceOffset = align(tableEnd, 8);

  for (const slice of slices) {
    entries.push({ slice, offset: sliceOffset });
    sliceOffset = align(sliceOffset + slice.buffer.length, 8);
  }

  const buffer = Buffer.alloc(sliceOffset);
  writeUInt(buffer, is64 ? 0xcafebabf : 0xcafebabe, 0, endian);
  writeUInt(buffer, slices.length, 4, endian);

  for (const [index, entry] of entries.entries()) {
    const offset = 8 + index * entrySize;
    writeUInt(buffer, CPU[entry.slice.arch], offset, endian);
    writeUInt(buffer, 0, offset + 4, endian);
    if (is64) {
      const writeBigUInt = endian === "little" ? "writeBigUInt64LE" : "writeBigUInt64BE";
      buffer[writeBigUInt](BigInt(entry.offset), offset + 8);
      buffer[writeBigUInt](BigInt(entry.slice.buffer.length), offset + 16);
      writeUInt(buffer, 3, offset + 24, endian);
      writeUInt(buffer, 0, offset + 28, endian);
    } else {
      writeUInt(buffer, entry.offset, offset + 8, endian);
      writeUInt(buffer, entry.slice.buffer.length, offset + 12, endian);
      writeUInt(buffer, 3, offset + 16, endian);
    }
    entry.slice.buffer.copy(buffer, entry.offset);
  }
  return buffer;
}

async function executableFixture(executable, asar = "promptbranch fixture\n") {
  const root = await mkdtemp(join(tmpdir(), "promptbranch-macho-uuid-"));
  tempDirectories.push(root);
  const executablePath = join(root, "PromptBranch");
  const asarPath = join(root, "app.asar");
  await writeFile(executablePath, executable);
  await writeFile(asarPath, asar);
  return { executablePath, asarPath };
}

test("thin UUID replacement is deterministic and changes only LC_UUID bytes", async () => {
  const original = thinMachO();
  const first = await executableFixture(original);
  const second = await executableFixture(original);

  await replaceMacExecutableUuids(first);
  await replaceMacExecutableUuids(second);

  const firstOutput = await readFile(first.executablePath);
  const secondOutput = await readFile(second.executablePath);
  assert.deepEqual(firstOutput, secondOutput);
  assert.deepEqual(readMachOUuids(firstOutput), [
    { architecture: "arm64", uuid: "2DF99D2A-7110-FECC-FDC7-E778B04E022B" },
  ]);

  const changedOffsets = [];
  for (let index = 0; index < original.length; index += 1) {
    if (original[index] !== firstOutput[index]) changedOffsets.push(index);
  }
  assert.ok(changedOffsets.length > 0);
  assert.ok(changedOffsets.every((offset) => offset >= 40 && offset < 56));
});

test("changing app.asar changes the deterministic UUID", async () => {
  const executable = thinMachO();
  const originalPayload = await executableFixture(executable);
  const changedPayload = await executableFixture(executable, "different payload\n");

  await replaceMacExecutableUuids(originalPayload);
  await replaceMacExecutableUuids(changedPayload);

  assert.deepEqual(readMachOUuids(await readFile(changedPayload.executablePath)), [
    { architecture: "arm64", uuid: "27914463-99BE-E0B9-8DAB-04827998EED1" },
  ]);
  assert.notDeepEqual(
    await readFile(originalPayload.executablePath),
    await readFile(changedPayload.executablePath),
  );
});

for (const [endian, is64] of [
  ["big", false],
  ["little", false],
  ["big", true],
  ["little", true],
]) {
  test(`replaces distinct UUIDs in ${endian}-endian FAT${is64 ? "64" : "32"} slices`, async () => {
    const executable = fatMachO(
      [
        {
          arch: "x64",
          buffer: thinMachO({
            arch: "x64",
            uuid: "00112233445566778899aabbccddeeff",
            endian: "big",
          }),
        },
        {
          arch: "arm64",
          buffer: thinMachO({
            arch: "arm64",
            uuid: "ffeeddccbbaa99887766554433221100",
          }),
        },
      ],
      { endian, is64 },
    );
    const fixture = await executableFixture(executable);

    await replaceMacExecutableUuids(fixture);

    assert.deepEqual(readMachOUuids(await readFile(fixture.executablePath)), [
      { architecture: "x64", uuid: "2DF99D2A-7110-FECC-FDC7-E778B04E022B" },
      { architecture: "arm64", uuid: "88D65D76-EA90-1C27-7D17-A7F210D9AFE4" },
    ]);
  });
}

test("rejects missing and duplicate LC_UUID commands", () => {
  const nonUuidCommand = Buffer.alloc(8);
  nonUuidCommand.writeUInt32LE(1, 0);
  nonUuidCommand.writeUInt32LE(8, 4);
  assert.throws(
    () => readMachOUuids(thinMachO({ commands: [nonUuidCommand] })),
    /arm64 slice.*exactly one LC_UUID.*found 0/,
  );

  assert.throws(
    () => readMachOUuids(thinMachO({ commands: [uuidCommand("00".repeat(16)), uuidCommand("11".repeat(16))] })),
    /arm64 slice.*exactly one LC_UUID.*found 2/,
  );
});

test("rejects malformed commands, unsafe FAT offsets, and unsupported architectures", () => {
  const malformedCommand = Buffer.alloc(8);
  malformedCommand.writeUInt32LE(0x1b, 0);
  malformedCommand.writeUInt32LE(4, 4);
  assert.throws(
    () => readMachOUuids(thinMachO({ commands: [malformedCommand] })),
    /invalid load command size 4/,
  );

  const unsafeFat = fatMachO([
    { arch: "arm64", buffer: thinMachO() },
  ]);
  unsafeFat.writeUInt32BE(unsafeFat.length - 4, 16);
  assert.throws(() => readMachOUuids(unsafeFat), /slice extends beyond file bounds/);

  assert.throws(
    () => readMachOUuids(thinMachO({ arch: "unsupported" })),
    /unsupported Mach-O CPU type 0x1234567/,
  );
});

test("validates every slice before writing any UUID", async () => {
  const executable = fatMachO([
    { arch: "x64", buffer: thinMachO({ arch: "x64" }) },
    {
      arch: "arm64",
      buffer: thinMachO({
        arch: "arm64",
        commands: [Buffer.from([1, 0, 0, 0, 8, 0, 0, 0])],
      }),
    },
  ]);
  const fixture = await executableFixture(executable);

  await assert.rejects(() => replaceMacExecutableUuids(fixture), /exactly one LC_UUID/);
  assert.deepEqual(await readFile(fixture.executablePath), executable);
});

function afterPackContext(appOutDir, electronPlatformName, arch) {
  return {
    arch,
    appOutDir,
    electronPlatformName,
    packager: {
      executableName: "promptbranch",
      appInfo: { productFilename: "PromptBranch" },
    },
  };
}

async function macAppFixture(appOutDir, executable, asar = "promptbranch fixture\n") {
  const contents = join(appOutDir, "PromptBranch.app", "Contents");
  const executablePath = join(contents, "MacOS", "PromptBranch");
  await Promise.all([
    mkdir(join(contents, "MacOS"), { recursive: true }),
    mkdir(join(contents, "Resources"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(executablePath, executable),
    writeFile(join(contents, "Resources", "app.asar"), asar),
  ]);
  return executablePath;
}

test("composite hook preserves the Linux launcher and skips UUID correction", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptbranch-after-pack-linux-"));
  tempDirectories.push(root);
  await writeFile(join(root, "promptbranch"), "linux executable");

  await afterPack(afterPackContext(root, "linux"));

  assert.equal(await readFile(join(root, "promptbranch-bin"), "utf8"), "linux executable");
  assert.match(await readFile(join(root, "promptbranch"), "utf8"), /--ozone-platform=x11/);
});

test("composite hook is a strict Windows no-op", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptbranch-after-pack-win-"));
  tempDirectories.push(root);
  const executable = join(root, "PromptBranch.exe");
  await writeFile(executable, "windows executable");

  await afterPack(afterPackContext(root, "win32"));

  assert.equal(await readFile(executable, "utf8"), "windows executable");
});

test("composite hook changes only the outer macOS executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptbranch-after-pack-mac-"));
  tempDirectories.push(root);
  const contents = join(root, "PromptBranch.app", "Contents");
  const executablePath = join(contents, "MacOS", "PromptBranch");
  const helperPath = join(contents, "Frameworks", "PromptBranch Helper.app", "PromptBranch Helper");
  const asarPath = join(contents, "Resources", "app.asar");
  await Promise.all([
    mkdir(join(contents, "MacOS"), { recursive: true }),
    mkdir(join(contents, "Resources"), { recursive: true }),
    mkdir(join(contents, "Frameworks", "PromptBranch Helper.app"), { recursive: true }),
  ]);
  const outer = thinMachO();
  const helper = thinMachO({ uuid: "ffeeddccbbaa99887766554433221100" });
  await Promise.all([
    writeFile(executablePath, outer),
    writeFile(helperPath, helper),
    writeFile(asarPath, "promptbranch fixture\n"),
  ]);

  await afterPack(afterPackContext(root, "darwin"));

  assert.notDeepEqual(await readFile(executablePath), outer);
  assert.deepEqual(await readFile(helperPath), helper);
});

test("universal packaging transforms only the final merged executable once", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptbranch-after-pack-universal-"));
  tempDirectories.push(root);
  const finalAppOutDir = join(root, "mac-universal");
  const x64TempDir = `${finalAppOutDir}-x64-temp`;
  const arm64TempDir = `${finalAppOutDir}-arm64-temp`;
  const x64Original = thinMachO({
    arch: "x64",
    uuid: "00112233445566778899aabbccddeeff",
  });
  const arm64Original = thinMachO({
    arch: "arm64",
    uuid: "ffeeddccbbaa99887766554433221100",
  });
  const x64TempExecutable = await macAppFixture(x64TempDir, x64Original);
  const arm64TempExecutable = await macAppFixture(arm64TempDir, arm64Original);

  await afterPack(afterPackContext(x64TempDir, "darwin", 1));
  await afterPack(afterPackContext(arm64TempDir, "darwin", 3));

  const x64ForMerge = await readFile(x64TempExecutable);
  const arm64ForMerge = await readFile(arm64TempExecutable);
  const mergedExecutable = fatMachO([
    { arch: "x64", buffer: x64ForMerge },
    { arch: "arm64", buffer: arm64ForMerge },
  ]);
  const finalExecutable = await macAppFixture(finalAppOutDir, mergedExecutable);
  await afterPack(afterPackContext(finalAppOutDir, "darwin", 4));

  assert.deepEqual(x64ForMerge, x64Original);
  assert.deepEqual(arm64ForMerge, arm64Original);
  assert.deepEqual(readMachOUuids(await readFile(finalExecutable)), [
    { architecture: "x64", uuid: "2DF99D2A-7110-FECC-FDC7-E778B04E022B" },
    { architecture: "arm64", uuid: "88D65D76-EA90-1C27-7D17-A7F210D9AFE4" },
  ]);
});

test("standalone thin x64 and arm64 packaging still transforms each executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptbranch-after-pack-thin-"));
  tempDirectories.push(root);

  for (const [architecture, arch, directory] of [
    ["x64", 1, "mac"],
    ["arm64", 3, "mac-arm64"],
  ]) {
    const appOutDir = join(root, directory);
    const executablePath = await macAppFixture(
      appOutDir,
      thinMachO({ arch: architecture }),
    );
    await afterPack(afterPackContext(appOutDir, "darwin", arch));
    assert.deepEqual(readMachOUuids(await readFile(executablePath)), [
      { architecture, uuid: "2DF99D2A-7110-FECC-FDC7-E778B04E022B" },
    ]);
  }
});
