# PromptBranch MCP Server

[![stdio](https://img.shields.io/badge/transport-stdio-3C2E6E)](https://modelcontextprotocol.io)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)](../../pnpm-workspace.yaml)

[`@promptbranch/mcp`](.) is a stdio MCP server exposing the local PromptBranch
library to AI coding agents. Thin adapter over `@promptbranch/core`; shares
the desktop app's database.

> Part of [PromptBranch](../../README.md#agent-integration) · agent workflow: [`SKILL.md`](SKILL.md)

## Install

The MCP server is published as the public `@promptbranch/mcp` npm package.

Point your MCP client at it:

```json
{
  "mcpServers": {
    "promptbranch": {
      "command": "npx",
      "args": ["-y", "@promptbranch/mcp"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `get_prompt` | Fetch a prompt's content (current, or a specific version/branch) |
| `search_prompts` | Full-text search (optional tag/collection filter, result limit) |
| `list_prompts` | List library entries (metadata for browsing) |
| `report_run` | Report an execution outcome: 1–5 rating, summary, metrics |
| `add_note` | Attach a note to a prompt or a specific version |
| `suggest_variation` | Propose an improved version — stays **pending** until a human approves it in the app |

The MCP server deliberately has no publish or import tool. It can read the
library, log runs and notes, and submit pending suggestions; sharing remains a
human action in the desktop app or CLI.

## Configuration

Set `PROMPTBRANCH_DB=/path/to.db` to point at a different library (the
PromptHub-era `PROMPTHUB_DB` and the pre-rename `PROMPTBUILDER_DB` are still
honored as deprecated fallbacks).

Prompts are referenced by title or id; see the
[main README](../../README.md#agent-integration) for the
"agents propose, humans approve" invariant and onboarding.
