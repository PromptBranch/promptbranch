# Core concepts

PromptBranch keeps prompt work organized without making you choose between
quick edits and a reliable history.

## Prompts, drafts, and versions

A **prompt** is the item in your library: it has a title, optional description,
content, and organization such as tags or collections. Creating a prompt also
creates its first version on the `main` variation.

Edit the displayed saved version as a **draft**. With autosave enabled, your
in-progress work is retained against that exact version when you switch prompts
or close the app. Press <kbd>⌘S</kbd> on macOS or <kbd>Ctrl+S</kbd> on Windows
and Linux, or choose **Save changes**, to update the displayed version without
changing its ID, label, number, or place in the version tree.

Choose **Save as new version** when you want to preserve the displayed version
and create a descendant. Include a short change note so you can understand the
reason for that new version later.

Version numbers are display labels scoped to a variation. Deleting an older
version leaves every surviving number unchanged, so gaps such as v1, v3, and
v4 are normal. The CLI and MCP server return a stable `versionId`; use it when
automation must keep referring to the same version record. Its content can be
amended in the desktop app, so save a new version when content itself must stay
as a historical snapshot.

## Current version and variations

Each prompt has one **current version**: its preferred/default saved revision.
This is what search, Quick access, the CLI, and the MCP server open or return
unless a caller asks for a specific version or variation. **Save changes**
never moves this pointer. **Save as new version** advances it when the displayed
base is current; saving a descendant from another historical version preserves
the current pointer until you deliberately change it.

Use **Duplicate as variation** to explore a different approach. A variation
copies the version currently displayed, opens that new working version, and has
its own numbered history. The current version remains unchanged until you
deliberately set another version as current.

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
