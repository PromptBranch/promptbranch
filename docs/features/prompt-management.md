# Manage prompts and versions

PromptBranch lets you make quick edits while keeping reliable versions to
return to later.

Right-click a prompt in the list for quick access to star, rename, collection,
duplication, export, and delete actions. In a collection, the menu also removes
the prompt from that collection. In Trash, it instead offers **Restore** and
**Delete permanently**.

## Edit and save a version

Use **Edit**, **Split**, or **Preview** in the prompt editor to work in the
view you prefer. The formatting toolbar helps with common Markdown.

With **Autosave drafts** enabled in **Settings → Editor**, unfinished edits are
kept against the exact saved version you were editing when you switch prompts
or close the app. You have two save actions:

- Press <kbd>⌘S</kbd> on macOS or <kbd>Ctrl+S</kbd> on Windows and Linux, or
  select **Save changes**, to update the exact version displayed in the editor.
  Its ID, number, label, parent, and current/default status stay unchanged.
- Select **Save as new version** to preserve the displayed version and create a
  descendant. Add a short change note, then select **Save version**.

You can open any active version from the version menu or **History** and edit
it directly. Saving as new creates the next unused number on that variation and
records the displayed version as its parent. If you started from a historical
version, neither save action changes the prompt's current/default version
automatically.

The History tab also lets you rename versions, duplicate the selected version
as a standalone prompt, or compare two versions side by side or as a unified
diff. Duplicate actions always copy the version displayed or explicitly chosen,
not an unrelated branch head.

## Use variations

A variation is an alternative direction for a prompt. It keeps experiments away
from the version you normally use.

1. Open **More actions → Duplicate as variation…**, or duplicate a version from
   the History tab.
2. Give the variation a name and optional description.
3. Edit it and save versions as usual.

Each variation starts from the displayed or explicitly selected version and has
its own version numbers. Creating one opens its copied v1 for editing without
changing the prompt's current/default version. Choose **Set as current** in the
History tab when a version should become the one opened by search and Quick
access and returned by the CLI and MCP server by default.

## Delete and recover

**More actions → Delete prompt** moves a prompt to **Trash**. Restore it from
Trash to bring back its versions, notes, and runs. Permanently deleting a
prompt, or choosing **Permanently empty Trash** in **Settings → Data & Backup**,
cannot be undone.

To permanently remove an older version, use **Delete** beside that version in
the **History** tab, or open the version and choose **More actions → Delete
version…**. The current version cannot be deleted. Deleting an older version
removes its run results and ratings, keeps its notes as prompt-level notes,
keeps already-published shares live, and leaves every surviving version number
unchanged. A history can therefore contain gaps such as v1, v3, and v4.

For exporting, importing, backups, and the library-wide activity feed, see
[Library data, backups, and transfer](library-data-and-backups.md).
