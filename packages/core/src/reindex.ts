import type BetterSqlite3 from "better-sqlite3";
import type { PromptRow, VersionRow } from "./types.js";

/**
 * Rebuilds all search_index rows for one prompt. Runs inside the caller's
 * transaction. Standalone (not a PromptLibrary method) so the sync engine can
 * reindex prompts it touched while applying remote ops.
 */
export function reindexPrompt(db: BetterSqlite3.Database, promptId: string): void {
  db.prepare("DELETE FROM search_index WHERE prompt_id = ?").run(promptId);
  const prompt = db.prepare("SELECT * FROM prompts WHERE id = ?").get(promptId) as PromptRow | undefined;
  if (!prompt) return;

  const tagNames = (
    db
      .prepare(
        "SELECT t.name FROM tags t JOIN prompt_tags pt ON pt.tag_id = t.id WHERE pt.prompt_id = ? ORDER BY t.name",
      )
      .all(promptId) as Array<{ name: string }>
  ).map((t) => t.name);
  const noteBodies = (
    db.prepare("SELECT body FROM notes WHERE prompt_id = ? ORDER BY created_at").all(promptId) as Array<{
      body: string;
    }>
  ).map((n) => n.body);

  db.prepare(
    `INSERT INTO search_index (prompt_id, version_id, title, description, tags, notes, content)
     VALUES (?, NULL, ?, ?, ?, ?, '')`,
  ).run(promptId, prompt.title, prompt.description ?? "", tagNames.join(" "), noteBodies.join("\n"));

  const versions = db
    .prepare("SELECT id, content FROM versions WHERE prompt_id = ? AND status = 'active'")
    .all(promptId) as Array<Pick<VersionRow, "id" | "content">>;
  for (const version of versions) {
    db.prepare(
      `INSERT INTO search_index (prompt_id, version_id, title, description, tags, notes, content)
       VALUES (?, ?, '', '', '', '', ?)`,
    ).run(promptId, version.id, version.content);
  }
}
