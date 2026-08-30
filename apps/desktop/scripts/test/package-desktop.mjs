import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../package-desktop.mjs", import.meta.url));

test("Windows packaging forces the NSIS-compatible BCJ filter", async () => {
  const binDirectory = await mkdtemp(join(tmpdir(), "promptbranch-builder-bin-"));
  const fakeBuilder = join(binDirectory, "electron-builder");

  try {
    await writeFile(
      fakeBuilder,
      [
        "#!/usr/bin/env node",
        'console.log(`filter=${process.env.ELECTRON_BUILDER_7Z_FILTER ?? "unset"}`);',
        "console.log(`args=${process.argv.slice(2).join(\" \")}`);",
      ].join("\n"),
    );
    await chmod(fakeBuilder, 0o755);

    const environment = { ...process.env };
    delete environment.ELECTRON_BUILDER_7Z_FILTER;
    environment.PATH = `${binDirectory}${delimiter}${environment.PATH ?? ""}`;

    const result = spawnSync(process.execPath, [scriptPath, "--win", "--arm64"], {
      encoding: "utf8",
      env: environment,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^filter=BCJ$/m);
    assert.match(result.stdout, /^args=--win --arm64$/m);
  } finally {
    await rm(binDirectory, { recursive: true, force: true });
  }
});
