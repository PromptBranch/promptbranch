# Search, Tags & Collections

PromptBranch provides an embedded **SQLite FTS5 full-text search engine** and flexible organizational tools to help you manage libraries containing hundreds of prompts.

---

## Instant Full-Text Search (FTS5)

In the 0.1.0 macOS desktop app, press <kbd>⌘K</kbd> from anywhere in the
application to open the **Command Palette & Search Modal**. Planned Windows and
Linux desktop builds use <kbd>Ctrl+K</kbd>.

### How the Search Engine Works

PromptBranch maintains an embedded **SQLite FTS5** full-text search index with the following characteristics:

- **Porter Stemming**: Searches automatically match word stems (e.g. searching for `"refactor"` matches `"refactored"`, `"refactoring"`, and `"refactors"`).
- **BM25 Relevance Ranking**: Results are ordered using the Okapi BM25 ranking algorithm.
- **Prefix Matching**: Typing partial words (e.g. `sec`) matches `security`, `secure`, and `secrets`; PromptBranch adds the prefix query internally.
- **Search Across All Content**:
  - Prompt Titles & Descriptions
  - Tag Names
  - Note Bodies
  - Version Template Content across all versions and branches

> [!NOTE]
> Search indexing is maintained atomically within SQLite database transactions. There are zero external search daemons, local web servers, or cloud dependencies.

The smaller search field above the prompt list is intentionally narrower: it
filters the current list by title, description, and tag name. In 0.1.0, use
<kbd>⌘K</kbd> when you need full-text matches from version content or notes.

---

## Filtering & Sorting

The prompt list pane provides granular filtering and sorting controls to quickly locate specific prompt sets:

### Sort Options
- **Updated** (default): Most recently updated prompts first.
- **Created**: Newest prompts first.
- **Name**: A–Z sorting by title.
- **Rating**: Highest average evaluation score first.

### Filter Dimensions
- **Tags**: Multi-select tags to find prompts carrying specific labels.
- **Starred only**: Show only favorite starred prompts.
- **Minimum rating**: Only prompts rated ≥ the chosen score.

Collections have their own section in the left rail — clicking a collection narrows the prompt list to its members.

---

## Organizing with Tags

Tags are lightweight, color-coded labels that can be attached to prompts for cross-cutting classification.

### Managing Tags
- **Creating Tags**: Use the **+** button beside **Tags** in the left rail. Existing tags can then be selected in the New Prompt dialog or attached with **Add tag** in the Inspector.
- **Tag Colors**: Each tag gets a stable color derived automatically from its name — no configuration needed.
- **Tag Filtering**: Open the Library's **Filters** control and select one or more tags. The left rail shows each tag and its usage count.

---

## Organizing with Collections

Collections act as curated folders or "playlists" of prompts.

### Working with Collections
- **Multi-Membership**: A single prompt can belong to multiple collections simultaneously without duplication.
- **Collection Management**: Create collections with the **+** button beside **Collections**, add or remove the current prompt through **More actions → Move to collection…**, and click a collection in the left rail to view its members.

---

## Starred Prompts

Click the **Star icon** (<span style="color:#f5a623">★</span>) on any prompt card or in the prompt header to mark it as a favorite.

- Starred prompts appear under the **Starred** view in the left rail for instant one-click access.
- Star status is synchronized across all your paired devices during P2P sync.

---

## Prompt Notes

Attach freeform context, research observations, and lessons learned directly to prompts:

- **Prompt-Level Notes**: General guidelines and usage advice applicable to the entire prompt project.
- **Version-Specific Notes**: Observations attached to a specific version number (e.g., *"Version 3 works exceptionally well on Claude 3.5 Sonnet but hallucinated on smaller models"*).
- **Searchable**: All note bodies are indexed in FTS5 and searchable via <kbd>⌘K</kbd>.
