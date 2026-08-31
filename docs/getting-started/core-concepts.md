# Core concepts

PromptBranch keeps prompt work organized without making you choose between
quick edits and a reliable history.

## Prompts, drafts, and versions

A **prompt** is the item in your library: it has a title, optional description,
content, and organization such as tags or collections. Creating a prompt also
creates its first version on the `main` variation.

Edit the prompt as a **draft**. With autosave enabled, your in-progress work
is retained when you switch prompts or close the app. Choose **Save as new
version** when the change is worth keeping. Versions are immutable; include a
short change note so you can understand the reason for each one later.

## Current version and variations

Each prompt has one **current version**. This is what the CLI and MCP server
return unless a caller asks for a specific version or variation.

Use **Duplicate as variation** to explore a different approach. A variation
starts from a selected version and has its own numbered history, while the
current version remains unchanged until you deliberately set another version
as current.

## Runs, ratings, and notes

Every desktop model run records the model, output, timing, token usage, and
estimated cost when available. You can compare runs, add a manual rating, or
ask a connected model to judge an output. Notes capture context and findings
for a prompt or a particular version.

## Agent suggestions

Agents can read prompts, log runs and notes, and propose a variation. Their
suggestion appears in the desktop app's **Suggestions** view as pending. It
does not show up in ordinary searches or become current until you approve it.
Rejecting a suggestion keeps it out of use while preserving the review record.

## Tags, collections, and Trash

Use **tags** for labels you can reuse across prompts, and **collections** for
groups of related prompts. Star important prompts for quick access. Deleting a
prompt moves it to **Trash**, where you can restore it or permanently remove
it when you are sure.

Next: [manage versions and variations](../features/prompt-management.md) or
[connect an AI provider](../integrations/ai-providers.md).
