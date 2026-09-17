import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase, PromptLibrary, rebuildPromptSearchIndex, type Database } from "../src/index.js";

let db: Database;
let lib: PromptLibrary;

beforeEach(() => {
  db = openMemoryDatabase();
  lib = new PromptLibrary(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function searchRows() {
  return db.prepare("SELECT rowid, * FROM search_index ORDER BY rowid").all() as Array<{
    rowid: number;
    prompt_id: string;
    version_id: string | null;
    content: string;
  }>;
}

function expectConsistentSearch() {
  const rows = searchRows().map(({ rowid, prompt_id, version_id }) => ({ rowid, prompt_id, version_id }));
  expect(db.prepare("SELECT * FROM search_index_rows ORDER BY rowid").all()).toEqual(rows);
  const expected = db.prepare(`SELECT id AS prompt_id, NULL AS version_id FROM prompts
    UNION ALL SELECT prompt_id, id AS version_id FROM versions WHERE status = 'active'
    ORDER BY prompt_id, version_id`).all();
  expect(db.prepare("SELECT prompt_id, version_id FROM search_index_rows ORDER BY prompt_id, version_id")
    .all()).toEqual(expected);
}

/** Observe executed writes and changed rows, including repeated statement runs. */
function observeSearchWrites() {
  const writes: Array<{ sql: string; changes: number }> = [];
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (/^\s*(INSERT INTO|UPDATE|DELETE FROM) search_index\b/i.test(sql)) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, "run").mockImplementation((...params: unknown[]) => {
        const result = run(...params);
        writes.push({ sql, changes: result.changes });
        return result;
      });
    }
    return statement;
  });
  return writes;
}

function manyVersions() {
  const prompt = lib.createPrompt({ title: "Index owner", content: "initial content" });
  const branch = lib.listBranches(prompt.id)[0]!;
  for (let i = 0; i < 8; i++) {
    lib.createVersion({ promptId: prompt.id, branchId: branch.id, content: `version ${i}` });
  }
  return { prompt, branch };
}

describe("incremental search maintenance", () => {
  it.each(["version", "prompt"])(
    "reconciles a sparse legacy rewrite when allocating a new %s row",
    (operation) => {
      const prompt = lib.createPrompt({ title: "Sparse owner", content: "firstcontent" });
      const branch = lib.listBranches(prompt.id)[0]!;
      const removed = lib.createVersion({ promptId: prompt.id, branchId: branch.id, content: "removed" });
      const current = lib.createVersion({ promptId: prompt.id, branchId: branch.id, content: "lastcontent" });
      lib.deleteVersion(removed.id);
      expect(searchRows().map((row) => row.rowid)).toEqual([1, 2, 4]);
      const legacyRows = searchRows();
      db.prepare("DELETE FROM search_index WHERE prompt_id = ?").run(prompt.id);
      for (const row of legacyRows) {
        db.prepare(`INSERT INTO search_index
          (prompt_id, version_id, title, description, tags, notes, content)
          VALUES (?, ?, ?, '', '', '', ?)`)
          .run(prompt.id, row.version_id, row.version_id === null ? "Sparse owner" : "", row.content);
      }
      expect(searchRows().map((row) => row.rowid)).toEqual([1, 2, 3]);
      expect(db.prepare("SELECT rowid FROM search_index_rows ORDER BY rowid").all())
        .toEqual([{ rowid: 1 }, { rowid: 2 }, { rowid: 4 }]);
      const before = searchRows();
      if (operation === "version") {
        const saved = lib.createVersion({ promptId: prompt.id, branchId: branch.id, content: "newcontent" });
        expect(lib.search("newcontent").map((hit) => hit.versionId)).toEqual([saved.id]);
      } else {
        const added = lib.createPrompt({ title: "Another owner", content: "othercontent" });
        expect(lib.search("othercontent").map((hit) => hit.promptId)).toEqual([added.id]);
        expect(searchRows().filter((row) => row.prompt_id === prompt.id)).toEqual(before);
      }
      expect(lib.search("lastcontent").map((hit) => hit.versionId)).toEqual([current.id]);
      expectConsistentSearch();
    },
  );

  it.each(["metadata", "version", "new version", "hard delete"])(
    "repairs a legacy FTS rewrite before a new-client %s mutation",
    (operation) => {
      const { prompt, branch } = manyVersions();
      const other = lib.createPrompt({ title: "Keep", content: "survivor" });
      const survivor = searchRows().filter((row) => row.prompt_id === other.id);
      // Pre-v15 writers maintain FTS directly and cannot update the new map.
      const legacyRows = searchRows().filter((row) => row.prompt_id === prompt.id);
      db.prepare("DELETE FROM search_index WHERE prompt_id = ?").run(prompt.id);
      const insert = db.prepare(`INSERT INTO search_index
        (prompt_id, version_id, title, description, tags, notes, content)
        VALUES (?, ?, ?, '', '', '', ?)`);
      for (const row of legacyRows) {
        insert.run(prompt.id, row.version_id, row.version_id === null ? "Index owner" : "", row.content);
      }
      if (operation === "metadata") lib.updatePromptMetadata(prompt.id, { title: "Recovered title" });
      if (operation === "version") lib.updateVersionContent(prompt.current_version_id!, "recoveredcontent");
      if (operation === "new version") lib.createVersion({ promptId: prompt.id, branchId: branch.id, content: "newcontent" });
      if (operation === "hard delete") lib.hardDeletePrompt(prompt.id);
      expectConsistentSearch();
      expect(searchRows().filter((row) => row.prompt_id === other.id)).toEqual(survivor);
      if (operation === "metadata") {
        expect(lib.search("Index owner")).toEqual([]);
        expect(lib.search("Recovered title").map((row) => row.promptId)).toEqual([prompt.id]);
      }
      if (operation === "version") {
        expect(lib.search("recoveredcontent").map((row) => row.versionId)).toEqual([prompt.current_version_id]);
      }
    },
  );

  it("explicit recovery repairs missing and stale mappings without leaving duplicate search rows", () => {
    const { prompt } = manyVersions();
    const other = lib.createPrompt({ title: "Keep", content: "survivor" });
    const survivor = searchRows().filter((row) => row.prompt_id === other.id);
    db.prepare("DELETE FROM search_index_rows WHERE prompt_id = ?").run(prompt.id);
    db.prepare("INSERT INTO search_index_rows (rowid, prompt_id, version_id) VALUES (9999, ?, NULL)")
      .run(prompt.id);
    db.prepare("UPDATE prompts SET title = 'Recovered title' WHERE id = ?").run(prompt.id);
    db.transaction(() => rebuildPromptSearchIndex(db, prompt.id))();
    expectConsistentSearch();
    expect(searchRows().filter((row) => row.prompt_id === other.id)).toEqual(survivor);
    expect(lib.search("Index owner")).toEqual([]);
    expect(lib.search("Recovered title").map((row) => row.promptId)).toEqual([prompt.id]);
  });

  it("changes one metadata row for metadata, tags and notes without rewriting versions", () => {
    const { prompt } = manyVersions();
    const tag = lib.createTag({ name: "astronomy" });
    const versions = searchRows().filter((row) => row.version_id !== null);
    const writes = observeSearchWrites();
    const change = (action: () => void) => {
      writes.length = 0;
      action();
      expect(writes.reduce((sum, write) => sum + write.changes, 0)).toBe(1);
      expect(searchRows().filter((row) => row.version_id !== null)).toEqual(versions);
      expectConsistentSearch();
    };
    change(() => { lib.updatePromptMetadata(prompt.id, { title: "Stargazer" }); });
    expect(lib.search("Stargazer").map((row) => row.promptId)).toEqual([prompt.id]);
    change(() => { lib.addTagToPrompt(prompt.id, tag.id); });
    expect(lib.search("astronomy").map((row) => row.promptId)).toEqual([prompt.id]);
    change(() => { lib.removeTagFromPrompt(prompt.id, tag.id); });
    expect(lib.search("astronomy")).toEqual([]);
    change(() => { lib.setPromptTags(prompt.id, [tag.id]); });
    let noteId = "";
    change(() => { noteId = lib.addNote({ promptId: prompt.id, body: "nebula" }).id; });
    expect(lib.search("nebula").map((row) => row.promptId)).toEqual([prompt.id]);
    change(() => { lib.deleteNote(noteId); });
    expect(lib.search("nebula")).toEqual([]);
  });

  it("creates, amends and deletes only the selected version row", () => {
    const { prompt, branch } = manyVersions();
    const previous = searchRows();
    const writes = observeSearchWrites();
    const added = lib.createVersion({ promptId: prompt.id, branchId: branch.id, content: "quasar" });
    expect(writes.reduce((sum, write) => sum + write.changes, 0)).toBe(1);
    expect(searchRows().filter((row) => row.version_id !== added.id)).toEqual(previous);
    expectConsistentSearch();
    writes.length = 0;
    lib.updateVersionContent(added.id, "pulsar");
    expect(writes.reduce((sum, write) => sum + write.changes, 0)).toBe(1);
    expect(searchRows().filter((row) => row.version_id !== added.id)).toEqual(previous);
    expect(lib.search("quasar")).toEqual([]);
    expect(lib.search("pulsar").map((row) => row.versionId)).toEqual([added.id]);
    expectConsistentSearch();
    lib.setCurrentVersion(prompt.id, prompt.current_version_id!);
    writes.length = 0;
    lib.deleteVersion(added.id);
    expect(writes.reduce((sum, write) => sum + write.changes, 0)).toBe(1);
    expect(writes.filter((write) => /DELETE FROM search_index\b/.test(write.sql))
      .every((write) => /WHERE rowid = \?/.test(write.sql))).toBe(true);
    expect(searchRows()).toEqual(previous);
    expectConsistentSearch();
  });

  it("adds only an approved suggestion and excludes pending and rejected rows", () => {
    const { prompt } = manyVersions();
    const previous = searchRows();
    const writes = observeSearchWrites();
    const suggest = (word: string) => lib.suggestVariation({
      promptId: prompt.id, baseVersionId: prompt.current_version_id!,
      newContent: word, rationale: "test review", branchName: word,
    }).version;
    const pending = suggest("supernova");
    const rejected = suggest("blackhole");
    lib.rejectSuggestion(rejected.id);
    expect(writes).toEqual([]);
    expectConsistentSearch();
    lib.approveSuggestion(pending.id);
    expect(writes.reduce((sum, write) => sum + write.changes, 0)).toBe(1);
    expect(searchRows().filter((row) => row.version_id !== pending.id)).toEqual(previous);
    expect(lib.search("supernova").map((row) => row.versionId)).toEqual([pending.id]);
    expect(lib.search("blackhole")).toEqual([]);
    expectConsistentSearch();
  });

  it("does not touch FTS for collection-only changes", () => {
    const { prompt } = manyVersions();
    const writes = observeSearchWrites();
    const collection = lib.createCollection({ name: "Favorites" });
    lib.addPromptToCollection(collection.id, prompt.id);
    lib.removePromptFromCollection(collection.id, prompt.id);
    expect(writes).toEqual([]);
    expectConsistentSearch();
  });

  it("hard deletes every owned FTS row by rowid without disturbing other prompts", () => {
    const { prompt } = manyVersions();
    const other = lib.createPrompt({ title: "Keep", content: "survivor" });
    const survivor = searchRows().filter((row) => row.prompt_id === other.id);
    const writes = observeSearchWrites();
    lib.hardDeletePrompt(prompt.id);
    expect(searchRows()).toEqual(survivor);
    expectConsistentSearch();
    expect(writes.filter((write) => /DELETE FROM search_index\b/.test(write.sql)))
      .toHaveLength(10);
    expect(writes.every((write) => /WHERE rowid = \?/.test(write.sql))).toBe(true);
  });
});

describe("search", () => {
  it("finds prompts by title, content, tag and note text", () => {
    const byTitle = lib.createPrompt({ title: "Cold outreach email", content: "generic body" });
    const byContent = lib.createPrompt({
      title: "Summarizer",
      content: "Summarize the following article about photosynthesis",
    });
    const byTag = lib.createPrompt({ title: "Translator", content: "translate text" });
    const tag = lib.createTag({ name: "localization" });
    lib.addTagToPrompt(byTag.id, tag.id);
    const byNote = lib.createPrompt({ title: "Critic", content: "review drafts" });
    lib.addNote({ promptId: byNote.id, body: "Works badly for screenplay formatting" });

    expect(lib.search("outreach").map((r) => r.promptId)).toContain(byTitle.id);
    expect(lib.search("photosynthesis").map((r) => r.promptId)).toContain(byContent.id);
    expect(lib.search("localization").map((r) => r.promptId)).toContain(byTag.id);
    expect(lib.search("screenplay").map((r) => r.promptId)).toContain(byNote.id);
  });

  it("supports prefix queries and porter stemming", () => {
    const prompt = lib.createPrompt({ title: "Prompt versioning guide", content: "x" });
    // "vers" is a prefix of "versioning"; porter stems let "version" match too.
    expect(lib.search("vers").map((r) => r.promptId)).toContain(prompt.id);
    expect(lib.search("version").map((r) => r.promptId)).toContain(prompt.id);
  });

  it("returns ranked results with snippets and version pointers", () => {
    const prompt = lib.createPrompt({
      title: "Chef",
      content: "You are a meticulous sous-chef who writes recipes",
    });
    const results = lib.search("sous-chef");
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.promptId === prompt.id && r.versionId !== null);
    expect(hit).toBeDefined();
    expect(hit!.title).toBe("Chef");
    expect(hit!.snippet.toLowerCase()).toContain("sous");
    expect(typeof hit!.rank).toBe("number");
  });

  it("applies filters", () => {
    const a = lib.createPrompt({ title: "Alpha helper", content: "x" });
    const b = lib.createPrompt({ title: "Beta helper", content: "y" });
    lib.setStarred(a.id, true);

    expect(lib.search("helper", { starred: true }).map((r) => r.promptId)).toEqual([a.id]);
    expect(new Set(lib.search("helper").map((r) => r.promptId))).toEqual(new Set([a.id, b.id]));
  });

  it("stays in sync across updates and branch content", () => {
    const prompt = lib.createPrompt({ title: "Renamable", content: "x" });
    expect(lib.search("zephyr")).toHaveLength(0);

    lib.updatePromptMetadata(prompt.id, { description: "tuned for zephyr models" });
    expect(lib.search("zephyr").map((r) => r.promptId)).toContain(prompt.id);

    const { branch } = lib.createBranch({
      promptId: prompt.id,
      name: "alt",
      fromVersionId: prompt.current_version_id!,
    });
    const v = lib.createVersion({
      promptId: prompt.id,
      branchId: branch.id,
      content: "alt branch mentions quixotic constraints",
    });
    const hits = lib.search("quixotic");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.versionId).toBe(v.id);
  });

  it("returns nothing for empty queries", () => {
    lib.createPrompt({ title: "Anything", content: "x" });
    expect(lib.search("   ")).toEqual([]);
  });
});
