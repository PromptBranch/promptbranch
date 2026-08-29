# Command-Line Interface (CLI)

The **`promptbranch` CLI** (`@promptbranch/cli`) exposes the agent-safe library workflow plus human sharing commands to shell scripts and terminal workflows.

> [!NOTE]
> No public CLI package has been published yet. The npm commands on this page
> become usable when `@promptbranch/cli` is released.

Run a command without installing anything globally:

```bash
npx -y @promptbranch/cli db-path
```

Or install the package globally so the examples below work with the shorter command:

```bash
npm install --global @promptbranch/cli
```

---

## Global Options & Output Formats

### Plain Text vs. Machine-Readable JSON (`--json`)

- **Standard Output (Default)**: Optimized for Unix piping and terminal readability. For example, `promptbranch get` outputs only the raw prompt content to stdout, making it directly pipeable into LLM CLI utilities or files.
- **`--json` Flag**: Emits structured JSON outputs suitable for parsing with `jq`, Python, or automation scripts.

```bash
# Pipe prompt content directly into an LLM command
promptbranch get "pr-review" | llm -m claude-3-5-sonnet

# Parse prompt metadata with jq
promptbranch get "pr-review" --json | jq '.versionLabel'
```

`promptbranch db-path --json` returns a `{ "path": "..." }` object. Both the
plain and JSON forms only resolve the path; they do not create or migrate a
database.

---

## Command Reference

### 1. `promptbranch list`
Lists all active prompts in the library.

```bash
promptbranch list [--tag <tag_name>] [--collection <collection_name>] [--json]
```

#### Example
```bash
promptbranch list --tag security
# Output:
# sql-injection-audit   v2   2026-08-27T18:00:00.000Z   1202e635-...
# auth-flow-check       v1   2026-08-25T12:30:00.000Z   d6eb38dc-...
```

---

### 2. `promptbranch get`
Retrieves a prompt's text content. Defaults to the current designated production version.

```bash
promptbranch get <name-or-id> [--version <n>] [--branch <branch_name>] [--json]
```

#### Examples
```bash
# Output raw prompt template to stdout
promptbranch get "sql-injection-audit"

# Fetch specific version and redirect to a file
promptbranch get "sql-injection-audit" --version 1 > /tmp/prompt_v1.md

# Fetch prompt on an experimental branch
promptbranch get "sql-injection-audit" --branch "experiment/concise"
```

---

### 3. `promptbranch search`
Executes an instant FTS5 BM25 search across all prompts, notes, and version contents.

```bash
promptbranch search <query> [--limit <n>] [--json]
```

#### Example
```bash
promptbranch search "sanitize inputs" --limit 5
```

---

### 4. `promptbranch report-run`
Logs an execution run against a prompt version, recording the tool, model, outcome rating (1–5), and summary.

```bash
promptbranch report-run --prompt <name-or-id> \
  [--version <n>] \
  [--tool <tool_name>] \
  [--model <model_name>] \
  [--outcome <1-5>] \
  [--summary "..."] \
  [--json]
```

`--tool` is optional and defaults to `cli`.

#### Example
```bash
promptbranch report-run --prompt "sql-injection-audit" \
  --tool "ci-eval" \
  --model "claude-3-5-sonnet" \
  --outcome 5 \
  --summary "Identified 3 vulnerabilities in sample codebase"
```

---

### 5. `promptbranch add-note`
Attaches a context note to a prompt or specific version.

```bash
promptbranch add-note --prompt <name-or-id> --body "..." [--version-id <id>] [--json]
```

---

### 6. `promptbranch suggest`
Proposes an improved variation of a prompt. The suggestion is created as **`pending`** awaiting human approval in the desktop app.

Supply exactly one content source: `--file` or `--content`.

```bash
promptbranch suggest --prompt <name-or-id> \
  (--file <path> | --content "...") \
  [--rationale "..."] \
  [--base-version <n>] \
  [--json]
```

#### Example
```bash
promptbranch suggest --prompt "sql-injection-audit" \
  --file ./improved-prompt.md \
  --rationale "Refined instructions to reduce false positives"
```

---

### 7. `promptbranch suggestions`
Lists all pending variations currently waiting in the human review queue.

```bash
promptbranch suggestions [--json]
```

---

### 8. `promptbranch publish`
Scans for secrets and publishes an immutable snapshot to the sharing portal.

```bash
promptbranch publish <name-or-id> \
  [--full-history] \
  [--description "..."] \
  [--portal <portal_url>] \
  [--json]
```

#### Example
```bash
promptbranch publish "sql-injection-audit" --full-history
# Output:
# Published "sql-injection-audit": https://promptbranch.app/p/V1StGXR8_Z5jdHi6B-myT
# Delete token (shown once, also stored locally): 4F7a9b...
```

---

### 9. `promptbranch import`
Imports a shared snapshot from a portal URL or snapshot ID into your local library.

```bash
promptbranch import <url-or-id> [--portal <portal_url>] [--json]
```

Portal publish and import requests time out after 30 seconds and return a
non-zero exit with an actionable error rather than waiting indefinitely.

---

### 10. `promptbranch db-path`
Prints the absolute filesystem path of the resolved SQLite database file.

```bash
promptbranch db-path
# /Users/username/Library/Application Support/PromptBranch/library.db

promptbranch db-path --json
# { "path": "/Users/username/Library/Application Support/PromptBranch/library.db" }
```

---

### `promptbranch help`
Running `promptbranch`, `promptbranch help`, `--help`, or `-h` prints the full command list and exits.
