# MCP Server Integration

PromptBranch publishes a **Model Context Protocol (MCP)** stdio server (`@promptbranch/mcp`). It allows AI coding assistants—such as **Claude Desktop**, **Cursor**, **Windsurf**, and custom agent frameworks—to interact with your local prompt library.

---

## Configuration

### Claude Desktop
Add the following to your `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

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

### Cursor & Windsurf
Add an MCP stdio server with:
- **Command**: `npx`
- **Args**: `["-y", "@promptbranch/mcp"]`

> [!TIP]
> The desktop app prints this configuration ready-to-paste in **Settings → Agent integration**.

---

## Registered MCP Tools

The PromptBranch MCP server registers 6 specialized tools:

| Tool Name | Purpose | Key Parameters |
| :--- | :--- | :--- |
| **`get_prompt`** | Fetch full prompt template & metadata | `prompt`, `version` (opt), `branch` (opt) |
| **`search_prompts`** | Full-text FTS5 BM25 search with filters | `query`, `tag` (opt), `collection` (opt), `limit` (opt) |
| **`list_prompts`** | List library prompts by tag or collection | `tag` (opt), `collection` (opt) |
| **`report_run`** | Log execution outcome & metrics | `prompt`, `version`, `tool`, `model`, `outcomeRating` (1–5), `resultSummary` |
| **`add_note`** | Attach observations & research notes | `prompt`, `versionId` (opt), `body` |
| **`suggest_variation`** | Propose improved prompt variations | `prompt`, `baseVersion` (opt), `newContent`, `rationale` |

---

### 1. `get_prompt`
Fetches a prompt's full content, version metadata, and tags. By default, returns the **Current** designated production version.

#### Input Schema
- `prompt` (string, required): Prompt title (exact, case-insensitive, or unique substring) or prompt ID.
- `version` (integer, optional): Per-branch version number (e.g. `1`, `2`). Defaults to current version.
- `branch` (string, optional): Branch name. Defaults to the current version's branch.

#### Example Call
```json
{
  "prompt": "security-audit",
  "version": 2
}
```

---

### 2. `search_prompts`
Performs an instant full-text search over prompt titles, descriptions, tags, notes, and version contents using SQLite FTS5 BM25 ranking.

#### Input Schema
- `query` (string, required): Search term or keyword.
- `tag` (string, optional): Restrict search to prompts carrying this tag name.
- `collection` (string, optional): Restrict search to this collection name.
- `limit` (integer, optional): Maximum results (default `10`).

---

### 3. `list_prompts`
Lists prompts in the library with titles, current version labels, and update timestamps.

#### Input Schema
- `tag` (string, optional): Filter by tag name.
- `collection` (string, optional): Filter by collection name.

---

### 4. `report_run`
Enables agents to report when they executed a prompt, logging the model used, outcome rating (1–5), and a result summary.

#### Input Schema
- `prompt` (string, required): Prompt title or ID.
- `version` (integer, optional): Version number executed.
- `tool` (string, required): Name of tool or agent (e.g. `'cursor'`, `'claude-desktop'`, `'kimi-cli'`).
- `model` (string, optional): Model identifier (e.g. `'claude-3-5-sonnet'`).
- `outcomeRating` (integer, optional): Integer score from `1` (poor) to `5` (excellent).
- `resultSummary` (string, optional): Short summary of the run outcome.
- `metrics` (object, optional): Structured metrics (latency, token counts, error codes).

---

### 5. `add_note`
Attaches research notes, caveats, or test observations to a prompt.

#### Input Schema
- `prompt` (string, required): Prompt title or ID.
- `versionId` (string, optional): Specific version ID; omit for a prompt-level note.
- `body` (string, required): Markdown note content.

---

### 6. `suggest_variation`
Proposes an improved rewrite or variation of a prompt.

> [!IMPORTANT]
> **Agents Propose, Humans Approve**: Suggestions created by agents are marked with `status = 'pending'`. They are invisible to search and regular listings, and cannot become the active production version until a human reviews and approves them in the **Suggestions** view of the desktop app.

#### Input Schema
- `prompt` (string, required): Prompt title or ID.
- `baseVersion` (integer, optional): Version number to base the variation on. Defaults to current.
- `newContent` (string, required): The proposed new prompt text.
- `rationale` (string, required): Explanation of why this change improves the prompt.

---

## Agent Skill File (`SKILL.md`)

For agents that support custom skill files, the `@promptbranch/mcp` package includes a ready-to-use `SKILL.md`. It teaches coding agents the **fetch → execute → report → suggest** workflow.
