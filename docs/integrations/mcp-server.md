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
| `get_prompt` | Fetch and render the current prompt, or a chosen version or variation. |
| `search_prompts` | Find prompts by text, tag, or collection. |
| `list_prompts` | Browse prompt titles and current versions. |
| `report_run` | Record a tool, model, rating, summary, and optional metrics. |
| `add_note` | Save a finding on a prompt or version. |
| `suggest_variation` | Submit an improved version for human review. |

Prompt references can be a title or id. Title matching tries an exact match,
then a case-insensitive match, then a unique substring. If a reference is
ambiguous, the server returns close matches.

`get_prompt` returns the immutable `versionId` for the content it fetched.
Pass that id back as `versionId` to `get_prompt` or `report_run`, or as
`baseVersionId` to `suggest_variation`, when an agent must keep using the exact
same revision. The numeric `version` and `baseVersion` selectors are convenient
for browsing, but they are branch-scoped labels rather than durable pins.
Version numbers stay unchanged after deletion, so histories can contain gaps;
paired devices can also reconcile a number created concurrently on both
devices.

## Dynamic prompt variables

Prompts can contain variables such as `{{target}}` and
`{{number_of_agents}}`. When `get_prompt` finds variables without supplied
values, it returns `status: "needs_input"`, the raw `templateContent`, and the
names in `missingVariables`. The agent should stop, ask the user for all
missing values, and call `get_prompt` again with a `variables` object:

```json
{
  "prompt": "Parallel code review",
  "variables": {
    "target": "packages/core",
    "number_of_agents": 3
  }
}
```

After every required value is supplied, the response has `status: "ready"`.
Use `content` as the rendered prompt:

```json
{
  "status": "ready",
  "templateContent": "Review {{target}} using {{number_of_agents}} agents.",
  "content": "Review packages/core using 3 agents.",
  "requiredVariables": ["target", "number_of_agents"],
  "missingVariables": []
}
```

Variable names may contain Unicode letters and numbers, underscores, periods,
and hyphens. Values can be strings, finite numbers, or booleans. An absent or
empty-string value remains missing; repeated variables are requested once.
Unknown variable names are rejected to catch typing mistakes.

Substitution is plain text and happens only for that `get_prompt` response.
Values are not saved, logged, synced, or written back to the prompt. A value
such as `number_of_agents: 3` renders an instruction for the connected agent;
PromptBranch does not create or control those agents itself.

## Recommended agent workflow

1. Search for or fetch the prompt before using it.
2. If `get_prompt` returns `needs_input`, ask for every missing value and fetch
   it again. Run only `ready` content.
3. Use the returned content and record the outcome with `report_run`, passing
   its `versionId` so the run remains attached to that exact input.
4. Add a note when the result needs context.
5. Use `suggest_variation` only when you have a concrete improvement and a
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
