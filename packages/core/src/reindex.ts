import type BetterSqlite3 from "better-sqlite3";
import type { PromptRow, VersionRow } from "./types.js";

type SearchRow = { rowid: number };
type MappedSearchRow = SearchRow & { prompt_id: string; version_id: string | null };

// Migration v11 repairs natural-key history through the current sync engine.
// Its physical schema predates the companion table; keep that repair usable
// without modifying shipped migration SQL or caching a stale schema version.
function rowTable(db: BetterSqlite3.Database): "search_index_rows" | "search_index" {
  return (db.pragma("user_version", { simple: true }) as number) >= 15
    ? "search_index_rows"
    : "search_index";
}

function deleteRows(db: BetterSqlite3.Database, table: string, rows: SearchRow[]): void {
  if (rows.length === 0) return;
  const removeSearch = db.prepare("DELETE FROM search_index WHERE rowid = ?");
  const removeMapping = table === "search_index_rows"
    ? db.prepare("DELETE FROM search_index_rows WHERE rowid = ?")
    : null;
  for (const { rowid } of rows) {
    removeSearch.run(rowid);
    removeMapping?.run(rowid);
  }
}

function rowMatches(db: BetterSqlite3.Database, row: MappedSearchRow): boolean {
  return db.prepare(`SELECT rowid FROM search_index
    WHERE rowid = ? AND prompt_id = ? AND version_id IS ?`)
    .get(row.rowid, row.prompt_id, row.version_id) !== undefined;
}

// Older shared-DB writers rebuild FTS without updating the companion map.
// Validate the metadata anchor by rowid before a version mutation can trust
// that prompt's mappings. Healthy writes keep constant, indexed lookups.
function repairStalePromptMapping(db: BetterSqlite3.Database, table: string, promptId: string): boolean {
  if (table !== "search_index_rows") return false;
  const metadata = db.prepare(`SELECT rowid, prompt_id, version_id FROM search_index_rows
    WHERE prompt_id = ? AND version_id IS NULL`).get(promptId) as MappedSearchRow | undefined;
  const stale = metadata
    ? !rowMatches(db, metadata)
    : db.prepare("SELECT rowid FROM search_index_rows WHERE prompt_id = ? LIMIT 1").get(promptId) !== undefined;
  if (!stale) return false;
  rebuildPromptSearchIndex(db, promptId);
  return true;
}

// Recovery alone enumerates actual FTS ownership: a missing mapping must not
// leave an orphan row behind, and a stale rowid must not delete another prompt.
function discardPromptSearchIndex(db: BetterSqlite3.Database, promptId: string): void {
  const table = rowTable(db);
  const rows = db.prepare("SELECT rowid FROM search_index WHERE prompt_id = ?").all(promptId) as SearchRow[];
  deleteRows(db, table, rows);
  if (table === "search_index_rows") {
    db.prepare("DELETE FROM search_index_rows WHERE prompt_id = ?").run(promptId);
  }
}

// A legacy full rewrite can compact FTS rowids while leaving the metadata
// anchor unchanged. On allocation collision, reconstruct only affected owners'
// mappings from actual FTS rows, including the just-inserted row. FTS stays
// unchanged during this pass, so each displaced owner needs processing once.
function reconcileAllocatedRowMappings(db: BetterSqlite3.Database, promptIds: string[]): void {
  const owners = new Set(promptIds);
  const readRows = db.prepare("SELECT rowid, prompt_id, version_id FROM search_index WHERE prompt_id = ?");
  const readOwner = db.prepare("SELECT prompt_id FROM search_index_rows WHERE rowid = ?");
  const clearOwner = db.prepare("DELETE FROM search_index_rows WHERE prompt_id = ?");
  const mapRow = db.prepare(`INSERT INTO search_index_rows (rowid, prompt_id, version_id)
    VALUES (?, ?, ?) ON CONFLICT(rowid) DO UPDATE
    SET prompt_id = excluded.prompt_id, version_id = excluded.version_id`);
  for (const promptId of owners) {
    const rows = readRows.all(promptId) as MappedSearchRow[];
    for (const row of rows) {
      const displaced = readOwner.get(row.rowid) as { prompt_id: string } | undefined;
      if (displaced && displaced.prompt_id !== promptId) owners.add(displaced.prompt_id);
    }
    clearOwner.run(promptId);
    for (const row of rows) mapRow.run(row.rowid, row.prompt_id, row.version_id);
  }
}

function writeRow(
  db: BetterSqlite3.Database,
  table: string,
  row: SearchRow | undefined,
  promptId: string,
  versionId: string | null,
  title: string,
  description: string,
  tags: string,
  notes: string,
  content: string,
): void {
  if (row) {
    db.prepare(`UPDATE search_index
      SET prompt_id = ?, version_id = ?, title = ?, description = ?, tags = ?, notes = ?, content = ?
      WHERE rowid = ?`).run(promptId, versionId, title, description, tags, notes, content, row.rowid);
    if (table === "search_index_rows") {
      db.prepare("UPDATE search_index_rows SET prompt_id = ?, version_id = ? WHERE rowid = ?")
        .run(promptId, versionId, row.rowid);
    }
    return;
  }
  const inserted = db.prepare(`INSERT INTO search_index
    (prompt_id, version_id, title, description, tags, notes, content)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(promptId, versionId, title, description, tags, notes, content);
  if (table === "search_index_rows") {
    const previous = db.prepare("SELECT prompt_id FROM search_index_rows WHERE rowid = ?")
      .get(inserted.lastInsertRowid) as { prompt_id: string } | undefined;
    if (previous) {
      reconcileAllocatedRowMappings(db, [previous.prompt_id, promptId]);
      return;
    }
    db.prepare("INSERT INTO search_index_rows (rowid, prompt_id, version_id) VALUES (?, ?, ?)")
      .run(inserted.lastInsertRowid, promptId, versionId);
  }
}

/** Refresh one metadata row inside the caller's mutation transaction. */
export function refreshPromptSearchMetadata(db: BetterSqlite3.Database, promptId: string): void {
  const table = rowTable(db);
  if (repairStalePromptMapping(db, table, promptId)) return;
  const row = db.prepare(`SELECT rowid FROM ${table} WHERE prompt_id = ? AND version_id IS NULL`)
    .get(promptId) as SearchRow | undefined;
  const prompt = db.prepare("SELECT * FROM prompts WHERE id = ?").get(promptId) as PromptRow | undefined;
  if (!prompt) {
    deleteRows(db, table, row ? [row] : []);
    return;
  }
  const tagNames = (db.prepare(`SELECT t.name FROM tags t
    JOIN prompt_tags pt ON pt.tag_id = t.id WHERE pt.prompt_id = ? ORDER BY t.name`)
    .all(promptId) as Array<{ name: string }>).map((tag) => tag.name);
  const noteBodies = (db.prepare("SELECT body FROM notes WHERE prompt_id = ? ORDER BY created_at")
    .all(promptId) as Array<{ body: string }>).map((note) => note.body);
  writeRow(db, table, row, promptId, null, prompt.title, prompt.description ?? "",
    tagNames.join(" "), noteBodies.join("\n"), "");
}

/** Pending/rejected versions never receive a search row. */
export function refreshVersionSearchRow(db: BetterSqlite3.Database, versionId: string): void {
  const version = db.prepare("SELECT id, prompt_id, content, status FROM versions WHERE id = ?")
    .get(versionId) as Pick<VersionRow, "id" | "prompt_id" | "content" | "status"> | undefined;
  if (!version || version.status !== "active") {
    deleteVersionSearchRow(db, versionId);
    return;
  }
  const table = rowTable(db);
  if (repairStalePromptMapping(db, table, version.prompt_id)) return;
  const row = db.prepare(`SELECT rowid, prompt_id, version_id FROM ${table} WHERE version_id = ?`)
    .get(versionId) as MappedSearchRow | undefined;
  if (row && table === "search_index_rows" && !rowMatches(db, row)) {
    rebuildPromptSearchIndex(db, row.prompt_id);
    if (row.prompt_id !== version.prompt_id) refreshVersionSearchRow(db, versionId);
    return;
  }
  writeRow(db, table, row, version.prompt_id, version.id, "", "", "", "", version.content);
}

/** Mapping lookup still works after the materialized version has been deleted. */
export function deleteVersionSearchRow(db: BetterSqlite3.Database, versionId: string): void {
  const table = rowTable(db);
  const rows = db.prepare(`SELECT rowid, prompt_id, version_id FROM ${table} WHERE version_id = ?`)
    .all(versionId) as MappedSearchRow[];
  if (table === "search_index_rows") {
    for (const row of rows) {
      if (repairStalePromptMapping(db, table, row.prompt_id)) {
        deleteVersionSearchRow(db, versionId);
        return;
      }
      if (!rowMatches(db, row)) {
        rebuildPromptSearchIndex(db, row.prompt_id);
        deleteVersionSearchRow(db, versionId);
        return;
      }
    }
  }
  deleteRows(db, table, rows);
}

/** Indexed companion lookup avoids a virtual-table scan for prompt deletion. */
export function deletePromptSearchRows(db: BetterSqlite3.Database, promptId: string): void {
  const table = rowTable(db);
  const rows = db.prepare(`SELECT rowid, prompt_id, version_id FROM ${table} WHERE prompt_id = ?`)
    .all(promptId) as MappedSearchRow[];
  if (table === "search_index_rows" && rows.some((row) => !rowMatches(db, row))) {
    discardPromptSearchIndex(db, promptId);
    return;
  }
  deleteRows(db, table, rows);
}

/** Full rebuild reserved for imports and explicit derived-index recovery. */
export function rebuildPromptSearchIndex(db: BetterSqlite3.Database, promptId: string): void {
  discardPromptSearchIndex(db, promptId);
  refreshPromptSearchMetadata(db, promptId);
  const versions = db.prepare("SELECT id FROM versions WHERE prompt_id = ? AND status = 'active'")
    .all(promptId) as Array<{ id: string }>;
  for (const version of versions) refreshVersionSearchRow(db, version.id);
}

/** Compatibility name for callers explicitly rebuilding a derived search index. */
export const reindexPrompt = rebuildPromptSearchIndex;
