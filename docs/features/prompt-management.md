# Manage prompts and versions

PromptBranch lets you make quick edits while keeping reliable versions to
return to later.

## Edit and save a version

Use **Edit**, **Split**, or **Preview** in the prompt editor to work in the
view you prefer. The formatting toolbar helps with common Markdown.

With **Autosave drafts** enabled in **Settings → Editor**, unfinished edits are
kept when you switch prompts or close the app. When a change is ready to keep:

1. Select **Save as new version**.
2. Add a short change note explaining the change.
3. Select **Save version**.

Saved versions cannot be edited. Open an older version from the version menu or
the **History** tab to review it. The History tab also lets you compare two
versions side by side or as a unified diff.

## Use variations

A variation is an alternative direction for a prompt. It keeps experiments away
from the version you normally use.

1. Open **More actions → Duplicate as variation…**, or duplicate a version from
   the History tab.
2. Give the variation a name and optional description.
3. Edit it and save versions as usual.

Each variation starts from the selected content and has its own version numbers.
Choose **Set as current** in the History tab when a version should become the
one returned by the CLI and MCP server by default.

## Delete and recover

**More actions → Delete** moves a prompt to **Trash**. Restore it from Trash to
bring back its versions, notes, and runs. Permanently deleting a prompt, or
choosing **Permanently empty Trash** in **Settings → Data & Backup**, cannot be
undone.

For exporting, importing, backups, and the library-wide activity feed, see
[Library data, backups, and transfer](library-data-and-backups.md).
