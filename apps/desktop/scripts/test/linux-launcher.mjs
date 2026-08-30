import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const tempDirectories = [];
const hookUrl = pathToFileURL(join(import.meta.dirname, "..", "linux-launcher.mjs"));

test.afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const appOutDir = await mkdtemp(join(tmpdir(), "promptbranch-linux-launcher-"));
  tempDirectories.push(appOutDir);
  const executable = join(appOutDir, "promptbranch");
  await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
  await chmod(executable, 0o755);
  return appOutDir;
}

test("Linux packages launch Electron with X11 before application startup", async () => {
  const appOutDir = await fixture();
  const { default: installLinuxLauncher } = await import(hookUrl.href);

  await installLinuxLauncher({
    appOutDir,
    electronPlatformName: "linux",
    packager: { executableName: "promptbranch" },
  });

  const launcher = await readFile(join(appOutDir, "promptbranch"), "utf8");
  assert.match(launcher, /--ozone-platform=x11/);
  assert.equal((await stat(join(appOutDir, "promptbranch"))).mode & 0o111, 0o111);

  const result = spawnSync(join(appOutDir, "promptbranch"), ["--probe"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["--ozone-platform=x11", "--probe"]);
});

test("Linux package launcher preserves an explicit Ozone backend override", async () => {
  const appOutDir = await fixture();
  const { default: installLinuxLauncher } = await import(hookUrl.href);

  await installLinuxLauncher({
    appOutDir,
    electronPlatformName: "linux",
    packager: { executableName: "promptbranch" },
  });

  const result = spawnSync(
    join(appOutDir, "promptbranch"),
    ["--ozone-platform=wayland", "--probe"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["--ozone-platform=wayland", "--probe"]);
});
