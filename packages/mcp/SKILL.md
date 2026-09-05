---
name: promptbranch
description: Fetch, evaluate and improve prompts in the user's local PromptBranch library via the promptbranch MCP server or CLI. Use when a task benefits from a saved prompt, when you should report how a prompt performed, or when you have an improvement to propose.
---

# PromptBranch library workflow

The user keeps a local, versioned prompt library (PromptBranch). You read from
it and report back to it, but you **never edit it directly** — agents propose,
humans approve.

Access it through the `promptbranch` MCP tools, or the `promptbranch` CLI
(every command supports `--json`). Both share the app's database.

## When to fetch a prompt

Before doing work that matches a saved prompt (code review, security audit,
commit messages, …), fetch it instead of improvising:

- MCP: `get_prompt` with the prompt title or id. Defaults to the current
  (preferred) version. Reuse the returned `versionId` to pin an exact revision;
  use `version`/`branch` only to browse a numbered version or variation.
- If `get_prompt` returns `status: "needs_input"`, stop and ask the user once
  for every name in `missingVariables`. Call `get_prompt` again with those
  values in `variables`, and execute `content` only when `status` is `"ready"`.
  Variable values are used for that response only; they are not saved back to
  the prompt.
- CLI: `promptbranch get "security-audit" --json`
- Don't know the exact name? `search_prompts` / `promptbranch search <query>`,
  or `list_prompts` with a collection/tag filter.

## When to report an outcome

After you *use* a fetched prompt, close the loop so the library learns what
works:

- MCP: `report_run` with `prompt`, `tool`, `model`, `outcomeRating` (1–5) and
  a one-line `resultSummary`. Pass the `versionId` returned by `get_prompt`.
- CLI: `promptbranch report-run --prompt "security-audit" --version-id <id> --tool <you> --outcome 4 --summary "found 2 issues"`

Report honestly — a low rating with a concrete summary is more useful than a
polite 5.

## When to propose an improvement

If a prompt underperformed or you see a concrete improvement, propose it —
do **not** edit the library yourself:

- MCP: `suggest_variation` with `prompt`, the fetched revision as
  `baseVersionId`, `newContent` and a `rationale`.
- CLI: `promptbranch suggest --prompt "security-audit" --base-version-id <id> --file improved.md --rationale "tighter scope"`

A suggestion is created as a **pending** version: invisible to search, unusable
as current, until the human approves it in the app's **Suggestions** view.
Always tell the user a suggestion is waiting for their review.

## Rules

- Read freely; write only via `report_run`, `add_note` and `suggest_variation`.
- Never modify, restore or delete prompts or versions — that is the human's job.
- Ambiguous title? The tools list close candidates — pick deliberately or ask.
