# PromptBranch Core

[![npm version](https://img.shields.io/npm/v/%40promptbranch%2Fcore?logo=npm&logoColor=white)](https://www.npmjs.com/package/@promptbranch/core)

`@promptbranch/core` is the Node.js domain library behind PromptBranch. It
provides a SQLite-backed prompt library with version history, branches, tags,
collections, ratings, run records, full-text search, JSON import/export, and
peer-to-peer sync primitives. It has no Electron dependency.

Requires Node.js 22 or later.

Source: [GitHub](https://github.com/PromptBranch/promptbranch/tree/main/packages/core) ·
[documentation](https://promptbranch.app/docs) ·
[report an issue](https://github.com/PromptBranch/promptbranch/issues)

## Install

```sh
npm install @promptbranch/core@latest
```

`better-sqlite3` is a native dependency. Use a supported Node.js platform and
architecture with a compatible prebuilt binary, or a working native build
toolchain.

## Create a prompt library

```js
import { openMemoryDatabase, PromptLibrary } from "@promptbranch/core";

const db = openMemoryDatabase();
const library = new PromptLibrary(db);

const prompt = library.createPrompt({
  title: "Review this change",
  content: "Review {{target}} for correctness and security.",
  tagNames: ["code-review"],
});

console.log(library.getPrompt(prompt.id));
db.close();
```

`openMemoryDatabase()` applies the latest schema to a disposable in-memory
database. For a persistent library, pass an explicit path to `openDatabase()`:

```js
import { openDatabase, PromptLibrary } from "@promptbranch/core";

const { db, backupPath } = openDatabase("/absolute/path/library.db");
const library = new PromptLibrary(db);

console.log(library.listPrompts());
console.log({ backupPath });
db.close();
```

Migrations run automatically. When an existing on-disk database needs a
migration, PromptBranch creates a timestamped backup first and returns its
path as `backupPath`; otherwise that value is `null`.

## Main exports

- `PromptLibrary` — prompt, version, branch, note, tag, collection, rating,
  run, search, and import/export operations.
- `openDatabase()` and `openMemoryDatabase()` — SQLite lifecycle and schema
  setup.
- `resolveDatabasePath()` — the shared PromptBranch library location, with
  `PROMPTBRANCH_DB` override support.
- `extractPromptVariables()`, `missingPromptVariables()`, and
  `substitutePromptVariables()` — `{{variable}}` discovery and substitution.
- `resolvePrompt()` and `resolveVersion()` — id/title and version reference
  resolution.
- `SyncEngine` and hybrid logical clock helpers — transport-independent sync
  primitives.

The desktop app, CLI, and MCP server use this package against the same local
database. If several processes open that database, WAL mode and a busy timeout
are configured automatically.

## Build from source

From the [PromptBranch repository](https://github.com/PromptBranch/promptbranch),
with pnpm 11.7.0 available:

```sh
pnpm install
pnpm --filter @promptbranch/core build
```

The published package contains compiled ESM in `dist/` and TypeScript
declarations.
