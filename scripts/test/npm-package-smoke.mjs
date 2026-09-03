import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const packageDirs = ["packages/core", "packages/share", "apps/cli", "packages/mcp"];

function command(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed (${result.status ?? "no status"}): ${executable} ${args.join(" ")}`,
        result.stdout,
        result.stderr,
        result.error?.message,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}

function packageManager(name, args, options = {}) {
  return run(command(name), args, {
    shell: process.platform === "win32",
    ...options,
  });
}

function waitForMcpStartup(binPath, dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath], {
      cwd: root,
      env: { ...process.env, PROMPTBRANCH_DB: dbPath },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let stopping = false;
    const timer = setTimeout(() => {
      stopping = true;
      child.once("exit", () => reject(new Error(`MCP package did not start within 10 seconds.\n${stderr}`)));
      child.kill();
    }, 10_000);

    const fail = (error) => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("[promptbranch-mcp] serving") && !stopping) {
        stopping = true;
        clearTimeout(timer);
        child.once("exit", () => resolve());
        child.kill();
      }
    });
    child.once("error", (error) => fail(error));
    child.once("exit", (code) => {
      if (!stopping) {
        fail(new Error(`MCP package exited before startup (${code ?? "signal"}).\n${stderr}`));
      }
    });
  });
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "promptbranch-npm-smoke-"));
const tarballDir = path.join(tempRoot, "tarballs");
const consumerDir = path.join(tempRoot, "consumer");
fs.mkdirSync(tarballDir);
fs.mkdirSync(consumerDir);

try {
  run(process.execPath, [path.join(root, "scripts/sync-package-licenses.mjs")]);
  packageManager("pnpm", [
    "--filter",
    "@promptbranch/core",
    "--filter",
    "@promptbranch/share",
    "--filter",
    "@promptbranch/cli",
    "--filter",
    "@promptbranch/mcp",
    "build",
  ]);

  const tarballs = {};
  for (const packageDir of packageDirs) {
    const packed = packageManager("pnpm", [
      "--dir",
      packageDir,
      "pack",
      "--pack-destination",
      tarballDir,
      "--json",
    ]);
    const metadata = JSON.parse(packed.stdout);
    tarballs[metadata.name] = metadata.filename;

    const fileNames = new Set(metadata.files.map((file) => file.path));
    assert(fileNames.has("LICENSE"), `${metadata.name} tarball is missing LICENSE`);
    assert(fileNames.has("THIRD_PARTY_NOTICES.md"), `${metadata.name} tarball is missing THIRD_PARTY_NOTICES.md`);
    if (metadata.name === "@promptbranch/core" || metadata.name === "@promptbranch/share") {
      assert(fileNames.has("dist/index.js"), `${metadata.name} tarball is missing compiled JavaScript`);
      assert(fileNames.has("dist/index.d.ts"), `${metadata.name} tarball is missing declarations`);
      assert(
        [...fileNames].every((fileName) => !fileName.startsWith("src/") && !fileName.startsWith("tests/")),
        `${metadata.name} tarball contains development source or tests`,
      );
    }
  }

  fs.writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "promptbranch-package-smoke-consumer",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          Object.entries(tarballs).map(([name, filename]) => [name, `file:${filename}`]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  packageManager("npm", ["install", "--no-audit", "--no-fund"], { cwd: consumerDir });

  const require = createRequire(path.join(consumerDir, "package.json"));
  const sqliteManifestPath = require.resolve("better-sqlite3/package.json");
  const sqliteRoot = path.dirname(sqliteManifestPath);
  for (const target of [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "linuxmusl-arm64",
    "linuxmusl-x64",
    "win32-arm64",
    "win32-x64",
  ]) {
    assert(
      fs.existsSync(path.join(sqliteRoot, "prebuilds", `${target}.node`)),
      `better-sqlite3 is missing its ${target} prebuild`,
    );
  }

  const runtimeSmokePath = path.join(consumerDir, "runtime-smoke.mjs");
  fs.writeFileSync(
    runtimeSmokePath,
    `import assert from "node:assert/strict";
import { openMemoryDatabase, PromptLibrary } from "@promptbranch/core";
import { scanForSecrets, snapshotSchema } from "@promptbranch/share";

const db = openMemoryDatabase();
const library = new PromptLibrary(db);
const prompt = library.createPrompt({ title: "Cross-platform smoke", content: "Hello" });
assert.equal(library.getPrompt(prompt.id)?.title, "Cross-platform smoke");
db.close();
assert.deepEqual(scanForSecrets("ordinary prompt text"), []);
assert.equal(typeof snapshotSchema.parse, "function");
`,
  );
  run(process.execPath, [runtimeSmokePath], { cwd: consumerDir });

  const typeSmokePath = path.join(consumerDir, "type-smoke.ts");
  fs.writeFileSync(
    typeSmokePath,
    `import { openMemoryDatabase, type Database } from "@promptbranch/core";
import { type SnapshotPayload, snapshotSchema } from "@promptbranch/share";

const opened: Database = openMemoryDatabase();
const parser: typeof snapshotSchema = snapshotSchema;
const snapshot = null as SnapshotPayload | null;
void parser;
void snapshot;
opened.close();
`,
  );
  fs.writeFileSync(
    path.join(consumerDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ["type-smoke.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", consumerDir]);

  const cliPath = path.join(consumerDir, "node_modules/@promptbranch/cli/dist/index.js");
  assert.equal(fs.readFileSync(cliPath, "utf8").split(/\r?\n/, 1)[0], "#!/usr/bin/env node");
  const cliDbPath = path.join(tempRoot, "cli", "library.db");
  const cli = run(process.execPath, [cliPath, "list", "--json"], {
    cwd: consumerDir,
    env: { ...process.env, PROMPTBRANCH_DB: cliDbPath },
  });
  assert.deepEqual(JSON.parse(cli.stdout), []);

  const mcpPath = path.join(consumerDir, "node_modules/@promptbranch/mcp/dist/index.js");
  assert.equal(fs.readFileSync(mcpPath, "utf8").split(/\r?\n/, 1)[0], "#!/usr/bin/env node");
  await waitForMcpStartup(mcpPath, path.join(tempRoot, "mcp", "library.db"));

  console.log(`npm package smoke passed on ${process.platform}/${process.arch} with Node ${process.version}`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
