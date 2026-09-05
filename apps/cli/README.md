# PromptBranch CLI

[![npm version](https://img.shields.io/npm/v/%40promptbranch%2Fcli?logo=npm&logoColor=white)](https://www.npmjs.com/package/@promptbranch/cli)
[![esbuild](https://img.shields.io/badge/bundled%20with-esbuild-CFD62E?logo=esbuild&logoColor=black)](https://esbuild.github.io/)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

`promptbranch` (`@promptbranch/cli`) is a local-first prompt library CLI for
shell pipelines, scripts, and AI coding agents that do not speak MCP. Use it
to search and retrieve prompts, keep version history, record evaluations, and
share snapshots from the terminal. It works with the same local library as
the [PromptBranch desktop app](https://promptbranch.app).

Requires Node.js 22 or later. No account is required for local library work.

Source: [GitHub](https://github.com/PromptBranch/promptbranch/tree/main/apps/cli) ·
[documentation](https://promptbranch.app/docs/integrations/cli) ·
[report an issue](https://github.com/PromptBranch/promptbranch/issues)

## Install

Run a command without a global install:

```sh
npx -y @promptbranch/cli@latest list --tag security
```

Or install the `promptbranch` command globally:

```sh
npm install --global @promptbranch/cli@latest
promptbranch list --tag security
```

Every command supports `--json` for machine-readable output. For example:

```sh
promptbranch get "security-audit" --json
promptbranch search "sanitize inputs" --limit 5
promptbranch db-path --json
```

`get --json` returns an immutable `versionId`. Use
`get --version-id <id>`, `report-run --version-id <id>`, and
`suggest --base-version-id <id>` when automation must stay tied to exactly the
same prompt content. Version numbers are branch-scoped display labels and can
contain gaps after deletion.

`db-path --json` returns the resolved database path without creating or
migrating the database.

## Agent-safe prompt workflow

Use the CLI as a small prompt version-control layer in scripts and coding-agent
harnesses:

- `list`, `search`, and `get` browse the local prompt library.
- `report-run` records the tool, model, outcome rating (1–5), and summary.
- `suggest` proposes a variation as **pending**; a human approves it in the
  desktop app before it can become current.
- `suggestions` lists the pending review queue.

Prompt references resolve by id or title (exact, case-insensitive, or unique
substring). See the [CLI integration guide](https://promptbranch.app/docs/integrations/cli)
for all commands and options.

## Sharing from the terminal

Sharing is a human-only action; the MCP server has no equivalent publish or
import tool.

```sh
promptbranch publish "security-audit" --full-history
promptbranch import https://promptbranch.app/p/<id>
```

Before publishing, PromptBranch scans the snapshot for secrets. Imports create
a new local prompt with its tags and provenance note; they do not recreate the
remote version history. Use `--portal <base-url>` to override the sharing
portal for one command.

## Environment

Set `PROMPTBRANCH_DB=/path/to.db` to use a different library. The desktop app,
CLI, and MCP server can share the same SQLite database; legacy
`PROMPTHUB_DB` and `PROMPTBUILDER_DB` variables remain supported as deprecated
fallbacks.

## Build from source

From the [PromptBranch repository](https://github.com/PromptBranch/promptbranch),
with pnpm 11.7.0 available:

```sh
pnpm install
pnpm --filter @promptbranch/cli build
```

The bundled command is `dist/index.js`.
