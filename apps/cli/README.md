# PromptBranch CLI

[![esbuild](https://img.shields.io/badge/bundled%20with-esbuild-CFD62E?logo=esbuild&logoColor=black)](./package.json)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)](../../pnpm-workspace.yaml)

`promptbranch` (`@promptbranch/cli`) — command-line interface to the local
PromptBranch library, for shell pipelines and AI coding agents that don't
speak MCP. Thin adapter over `@promptbranch/core`; shares the desktop app's
database.

> Part of [PromptBranch](../../README.md#agent-integration)

## Quick start

The CLI is published as the public `@promptbranch/cli` npm package.

```sh
npx -y @promptbranch/cli list --tag security
npx -y @promptbranch/cli get "security-audit" --json
npx -y @promptbranch/cli db-path
```

Install the package globally to use the shorter `promptbranch` command. Every
command supports `--json` for machine-readable output;
`db-path --json` returns `{ "path": "/absolute/path/to/library.db" }` without
creating or migrating the database.

## Sharing (human-only; MCP has no equivalent)

```sh
promptbranch publish "security-audit" --full-history   # scan → publish → prints URL + delete token
promptbranch import https://promptbranch.app/p/<id>    # imports the snapshot as a new prompt with an 'Imported from <url>' change note
```

`publish` blocks on high-severity secret findings (exit 1 with the finding
list) and stores the delete token in the library's `shared_snapshots` table so
the share can be revoked from the desktop app. `--portal <base-url>` overrides
the portal for one call; otherwise the library's `portal_base_url` setting
(default `https://promptbranch.app`) is used. A full snapshot URL names its
own portal — importing a friend's self-hosted link needs no flag. Portal
requests time out after 30 seconds instead of waiting indefinitely.

## Environment

Agents propose, humans approve: `suggest` creates a pending variation reviewed
in the desktop app's Suggestions view. Set `PROMPTBRANCH_DB` to point at a
different library (the PromptHub-era `PROMPTHUB_DB` and the pre-rename
`PROMPTBUILDER_DB` are still honored as deprecated fallbacks).

See the [main README](../../README.md#agent-integration) for tool semantics,
title resolution and onboarding.
