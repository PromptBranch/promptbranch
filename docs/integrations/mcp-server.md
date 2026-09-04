# MCP server integration

PromptBranch exposes your local library through a standard-input/output MCP
server. Use it with any MCP-capable coding agent or harness, including Claude
Desktop, Cursor, Windsurf, Cline, and custom clients.

It requires **Node.js 22** or later.

The MCP server and desktop app use the same local library. Open **Settings →
Agent integration** in the app for the resolved database path and a ready-to-
paste configuration.

## Add it to an MCP client

Configure a stdio server with this command:

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

For an agent harness with separate command and argument fields, use `npx` as
the command and `-y`, `@promptbranch/mcp@latest` as the arguments. Restart or
reload the client after saving its configuration.

To connect a client to a different library, set `PROMPTBRANCH_DB` in that
client's MCP environment. See [configuration](../reference/configuration-and-env.md).

## What an agent can do

| Tool | Use it for |
| --- | --- |
| `get_prompt` | Fetch the current prompt, or a chosen version or variation. |
| `search_prompts` | Find prompts by text, tag, or collection. |
| `list_prompts` | Browse prompt titles and current versions. |
| `report_run` | Record a tool, model, rating, summary, and optional metrics. |
| `add_note` | Save a finding on a prompt or version. |
| `suggest_variation` | Submit an improved version for human review. |

Prompt references can be a title or id. Title matching tries an exact match,
then a case-insensitive match, then a unique substring. If a reference is
ambiguous, the server returns close matches.

## Recommended agent workflow

1. Search for or fetch the prompt before using it.
2. Use the returned content and record the outcome with `report_run`.
3. Add a note when the result needs context.
4. Use `suggest_variation` only when you have a concrete improvement and a
   rationale.

Agents propose, humans approve: a suggested variation is pending, invisible to
normal search and listings, and cannot become current until someone approves
it in the desktop app's **Suggestions** view. MCP intentionally cannot publish
or import web content; sharing is a human action in the desktop app or CLI.

## Build from source

From a PromptBranch checkout:

```sh
pnpm install
pnpm --filter @promptbranch/mcp build
```

The built server is `packages/mcp/dist/index.js`.
