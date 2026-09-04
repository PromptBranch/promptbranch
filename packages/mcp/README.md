# PromptBranch MCP server

[![npm version](https://img.shields.io/npm/v/%40promptbranch%2Fmcp?logo=npm&logoColor=white)](https://www.npmjs.com/package/@promptbranch/mcp)
[![stdio](https://img.shields.io/badge/transport-stdio-3C2E6E)](https://modelcontextprotocol.io/)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

[`@promptbranch/mcp`](https://www.npmjs.com/package/@promptbranch/mcp) is a
local-first [Model Context Protocol](https://modelcontextprotocol.io/) server
for AI coding agents. It gives an MCP-capable assistant a searchable prompt
library with version history, run reports, notes, and human-reviewed
improvement proposals. It uses the same local SQLite library as the
[PromptBranch desktop app](https://promptbranch.app).

Requires Node.js 22 or later. No account or hosted database is required for
local library operations.

Source: [GitHub](https://github.com/PromptBranch/promptbranch/tree/main/packages/mcp) ·
[MCP integration guide](https://promptbranch.app/docs/integrations/mcp-server) ·
[agent workflow](https://github.com/PromptBranch/promptbranch/blob/main/packages/mcp/SKILL.md) ·
[report an issue](https://github.com/PromptBranch/promptbranch/issues)

## Install

Add the stdio server to any MCP client that supports a command and arguments:

```json
{
  "mcpServers": {
    "promptbranch": {
      "command": "npx",
      "args": ["-y", "@promptbranch/mcp@latest"]
    }
  }
}
```

This works with MCP-capable tools such as Claude Desktop, Cursor, Windsurf,
Cline, and other agent harnesses. The package can also be installed globally:

```sh
npm install --global @promptbranch/mcp@latest
```

## Tools

| Tool | Purpose |
|---|---|
| `get_prompt` | Fetch current prompt content or a specific version/branch |
| `search_prompts` | Search the library with optional tag, collection, and limit filters |
| `list_prompts` | Browse prompt metadata |
| `report_run` | Record a 1–5 outcome rating, summary, and metrics |
| `add_note` | Attach a note to a prompt or version |
| `suggest_variation` | Propose an improved version that stays **pending** until human approval |

The intended agent loop is **fetch → run → report → suggest**. Agents can read
prompts, record evidence about what worked, and propose improvements. Pending
suggestions never enter search results or become current until a person reviews
them in the desktop app's Suggestions view.

The server deliberately has no publish or import tool. Sharing remains a
human action in the desktop app or CLI.

## Configuration

Set `PROMPTBRANCH_DB=/path/to.db` to use a different local library. The desktop
app, CLI, and MCP server can share the same SQLite database; legacy
`PROMPTHUB_DB` and `PROMPTBUILDER_DB` variables remain supported as deprecated
fallbacks.

Prompts can be referenced by id or title (exact, case-insensitive, or unique
substring). See the [MCP integration guide](https://promptbranch.app/docs/integrations/mcp-server)
for client configuration and workflow details.

## Build from source

From the [PromptBranch repository](https://github.com/PromptBranch/promptbranch),
with pnpm 11.7.0 available:

```sh
pnpm install
pnpm --filter @promptbranch/mcp build
```

The bundled server is `dist/index.js`.
