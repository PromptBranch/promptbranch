import { beforeEach, describe, expect, it } from "vitest";
import {
  openMemoryDatabase,
  PromptLibrary,
  type Database,
  type LibraryExport,
  preflightLibraryImport,
  LibraryImportValidationError,
} from "../src/index.js";

let db: Database;
let lib: PromptLibrary;

beforeEach(() => {
  db = openMemoryDatabase();
  lib = new PromptLibrary(db);
});

/** Builds a library exercising every table. */
function populate(library: PromptLibrary) {
  const tag = library.createTag({ name: "coding", color: "#0af" });
  const collection = library.createCollection({ name: "Favorites", sortOrder: 1 });

  const prompt = library.createPrompt({
    title: "Reviewer",
    description: "Reviews code",
    tagIds: [tag.id],
    content: "Review this code",
  });
  const main = library.listBranches(prompt.id)[0]!;
  const v2 = library.createVersion({
    promptId: prompt.id,
    branchId: main.id,
    content: "Review this code carefully",
    changeNote: "more careful",
  });
  const { branch: altBranch } = library.createBranch({
    promptId: prompt.id,
    name: "strict",
    fromVersionId: v2.id,
  });
  library.createVersion({ promptId: prompt.id, branchId: altBranch.id, content: "Be strict" });
  library.setCurrentVersion(prompt.id, v2.id);

  library.addNote({ promptId: prompt.id, body: "general note" });
  library.addNote({ promptId: prompt.id, versionId: v2.id, body: "version note" });
  library.addRating({ targetType: "prompt", targetId: prompt.id, effectiveness: 4, clarity: 5 });
  library.addRating({ targetType: "version", targetId: v2.id, completeness: 3 });
  library.addRun({
    promptId: prompt.id,
    versionId: v2.id,
    tool: "claude",
    model: "claude-opus",
    promptContent: "Review the release candidate from 2026-09-02",
    outcomeRating: 5,
    resultSummary: "great",
    metrics: { tokens: 100 },
  });
  library.addPromptToCollection(collection.id, prompt.id, 3);
  library.setDraft(prompt.id, "draft text", v2.id);
  library.setStarred(prompt.id, true);
  // Re-fetch so current_version_id reflects setCurrentVersion above.
  return { prompt: library.getPrompt(prompt.id)!, tag, collection };
}

function rowCounts(database: Database): Record<string, number> {
  const tables = [
    "prompts",
    "branches",
    "versions",
    "notes",
    "tags",
    "prompt_tags",
    "collections",
    "collection_prompts",
    "ratings",
    "runs",
    "settings",
  ];
  return Object.fromEntries(
    tables.map((t) => [t, (database.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c]),
  );
}

/** Includes FTS shadow tables and every sync side table, not just row counts. */
function fullDatabaseSnapshot(database: Database): Record<string, unknown[]> {
  const names = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return Object.fromEntries(names.map(({ name }) => [name,
    database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]));
}

describe("import preflight", () => {
  function bundle(): LibraryExport {
    populate(lib);
    lib.createPrompt({ title: "Other owner", content: "foreign content" });
    const provider = lib.createProvider({ type: "openai", name: "Test provider" });
    lib.setProviderModels(provider.id, [{ modelId: "test-model" }]);
    return lib.exportLibrary();
  }

  function rejected(input: unknown, expectedPath: string): void {
    const before = fullDatabaseSnapshot(db);
    let error: unknown;
    try { lib.importLibrary(input); } catch (caught) { error = caught; }
    // Check all content even when the expected error is missing or is a SQL error.
    expect(fullDatabaseSnapshot(db)).toEqual(before);
    expect(error).toMatchObject({
      name: "LibraryImportValidationError",
      issues: expect.arrayContaining([expect.objectContaining({
        path: expectedPath, code: expect.any(String), message: expect.any(String),
      })]),
    });
  }

  const cases: Array<[string, (data: LibraryExport) => void, string]> = [
    ["duplicate entity ids", (d) => { d.tables.notes.push({ ...d.tables.notes[0]! }); }, "tables.notes[2].id"],
    ["blank ids", (d) => { d.tables.tags[0]!.id = "  "; }, "tables.tags[0].id"],
    ["missing prompt even when destination has it", (d) => { d.tables.prompts = []; }, "tables.branches[0].prompt_id"],
    ["missing branch even when destination has it", (d) => { d.tables.branches = []; }, "tables.versions[0].branch_id"],
    ["missing parent", (d) => { d.tables.versions[0]!.parent_version_id = "missing"; }, "tables.versions[0].parent_version_id"],
    ["missing current", (d) => { d.tables.prompts[0]!.current_version_id = "missing"; }, "tables.prompts[0].current_version_id"],
    ["missing draft base", (d) => { d.tables.prompts[0]!.draft_base_version_id = "missing"; }, "tables.prompts[0].draft_base_version_id"],
    ["foreign current", (d) => { d.tables.prompts[0]!.current_version_id = d.tables.versions.at(-1)!.id; }, "tables.prompts[0].current_version_id"],
    ["foreign draft base", (d) => { d.tables.prompts[0]!.draft_base_version_id = d.tables.versions.at(-1)!.id; }, "tables.prompts[0].draft_base_version_id"],
    ["draft base without content", (d) => { d.tables.prompts[0]!.draft_content = null; }, "tables.prompts[0].draft_base_version_id"],
    ["foreign branch", (d) => { d.tables.versions[0]!.branch_id = d.tables.branches.at(-1)!.id; }, "tables.versions[0].branch_id"],
    ["cross-prompt parent", (d) => { d.tables.versions[0]!.parent_version_id = d.tables.versions.at(-1)!.id; }, "tables.versions[0].parent_version_id"],
    ["self cycle", (d) => { d.tables.versions[0]!.parent_version_id = d.tables.versions[0]!.id; }, "tables.versions[0].parent_version_id"],
    ["multi-node cycle", (d) => { d.tables.versions[0]!.parent_version_id = d.tables.versions[1]!.id; }, "tables.versions[0].parent_version_id"],
    ["foreign note version", (d) => { d.tables.notes[0]!.version_id = d.tables.versions.at(-1)!.id; }, "tables.notes[0].version_id"],
    ["missing note version", (d) => { d.tables.notes[0]!.version_id = "missing"; }, "tables.notes[0].version_id"],
    ["missing note prompt", (d) => { d.tables.notes[0]!.prompt_id = "missing"; }, "tables.notes[0].prompt_id"],
    ["foreign run version", (d) => { d.tables.runs[0]!.version_id = d.tables.versions.at(-1)!.id; }, "tables.runs[0].version_id"],
    ["missing run version", (d) => { d.tables.runs[0]!.version_id = "missing"; }, "tables.runs[0].version_id"],
    ["missing run prompt", (d) => { d.tables.runs[0]!.prompt_id = "missing"; }, "tables.runs[0].prompt_id"],
    ["missing prompt rating", (d) => { d.tables.ratings[0]!.target_id = "missing"; }, "tables.ratings[0].target_id"],
    ["missing version rating", (d) => { d.tables.ratings[1]!.target_id = "missing"; }, "tables.ratings[1].target_id"],
    ["missing provider model owner", (d) => { d.tables.provider_models![0]!.provider_id = "missing"; }, "tables.provider_models[0].provider_id"],
    ["missing junction prompt", (d) => { d.tables.prompt_tags[0]!.prompt_id = "missing"; }, "tables.prompt_tags[0].prompt_id"],
    ["missing junction tag", (d) => { d.tables.prompt_tags[0]!.tag_id = "missing"; }, "tables.prompt_tags[0].tag_id"],
    ["missing collection", (d) => { d.tables.collection_prompts[0]!.collection_id = "missing"; }, "tables.collection_prompts[0].collection_id"],
    ["missing collection prompt", (d) => { d.tables.collection_prompts[0]!.prompt_id = "missing"; }, "tables.collection_prompts[0].prompt_id"],
    ["duplicate prompt tag", (d) => { d.tables.prompt_tags.push({ ...d.tables.prompt_tags[0]! }); }, "tables.prompt_tags[1]"],
    ["duplicate collection prompt", (d) => { d.tables.collection_prompts.push({ ...d.tables.collection_prompts[0]! }); }, "tables.collection_prompts[1]"],
    ["duplicate provider model", (d) => { d.tables.provider_models!.push({ ...d.tables.provider_models![0]! }); }, "tables.provider_models[1]"],
    ["duplicate tag name", (d) => { d.tables.tags.push({ ...d.tables.tags[0]!, id: "new-tag" }); }, "tables.tags[1].name"],
    ["duplicate collection name", (d) => { d.tables.collections.push({ ...d.tables.collections[0]!, id: "new-collection" }); }, "tables.collections[1].name"],
    ["duplicate branch name per prompt", (d) => { d.tables.branches.push({ ...d.tables.branches[0]!, id: "new-branch" }); }, "tables.branches[3].name"],
    ["duplicate setting key", (d) => { d.tables.settings = [{ key: "theme", value: "dark" }, { key: "theme", value: "light" }]; }, "tables.settings[1].key"],
  ];
  for (const status of ["pending", "rejected"] as const) {
    for (const field of ["current_version_id", "draft_base_version_id"] as const) {
      cases.push([`${status} ${field}`, (d) => {
        const id = d.tables.prompts[0]![field];
        d.tables.versions.find((v) => v.id === id)!.status = status;
      }, `tables.prompts[0].${field}`]);
    }
  }
  it.each(cases)("rejects %s atomically", (_name, mutate, path) => {
    const data = bundle();
    mutate(data);
    rejected(data, path);
  });

  const primitives: Array<[keyof LibraryExport["tables"], string, unknown]> = [
    ["prompts", "title", undefined], ["prompts", "title", 42],
    ["prompts", "description", false], ["prompts", "current_version_id", 3],
    ["prompts", "is_starred", true], ["prompts", "is_starred", 2],
    ["prompts", "created_at", "yesterday"], ["prompts", "deleted_at", "2026-02-30T00:00:00Z"],
    ["branches", "prompt_id", null], ["branches", "description", []],
    ["versions", "number", 1.5], ["versions", "number", Infinity],
    ["versions", "status", "approved"], ["versions", "source", "robot"],
    ["versions", "content", null], ["versions", "parent_version_id", {}],
    ["notes", "body", 3], ["notes", "created_at", "2026-01-01"],
    ["tags", "color", 5], ["collections", "sort_order", 0.5],
    ["collection_prompts", "sort_order", NaN], ["ratings", "target_type", "run"],
    ["ratings", "effectiveness", 0], ["ratings", "clarity", 6],
    ["ratings", "completeness", NaN], ["ratings", "actionability", "5"],
    ["runs", "status", "queued"], ["runs", "latency_ms", 1.5],
    ["runs", "latency_ms", Infinity], ["runs", "outcome_rating", 6],
    ["runs", "started_at", false], ["runs", "output", []],
    ["providers", "enabled", 2], ["providers", "base_url", false],
    ["provider_models", "enabled", true], ["provider_models", "display_name", 8],
  ];
  it.each(primitives)("validates %s.%s = %s atomically", (table, field, value) => {
    const data = bundle();
    (data.tables[table]![0] as unknown as Record<string, unknown>)[field] = value;
    rejected(data, `tables.${table}[0].${field}`);
  });
  it.each([null, 3, [], "row"].map((value) => [value]))("rejects a non-object row %s", (value) => {
    const data = bundle();
    (data.tables.notes as unknown[])[0] = value;
    rejected(data, "tables.notes[0]");
  });
  it("rejects sparse rows at the unknown boundary", () => {
    const data = bundle();
    delete data.tables.notes[0];
    rejected(data, "tables.notes[0]");
  });
  it("validates every supplied field and table row shape", () => {
    const data = bundle();
    data.tables.settings.push({ key: "theme", value: "dark" });
    for (const [table, rows] of Object.entries(data.tables)) {
      for (const field of Object.keys(rows[0]!)) {
        const invalid = structuredClone(data);
        const tables = invalid.tables as unknown as Record<string, Array<Record<string, unknown>>>;
        tables[table]![0]![field] = {};
        rejected(invalid, `tables.${table}[0].${field}`);
      }
      const invalid = structuredClone(data);
      (invalid.tables as unknown as Record<string, unknown>)[table] = {};
      rejected(invalid, `tables.${table}`);
    }
  });
  it.each([null, [], 3].map((value) => [value]))("rejects a non-object envelope %s", (input) => rejected(input, "$"));
  it("requires tables and the supported format version", () => {
    const data = bundle();
    rejected({ ...data, meta: { ...data.meta, formatVersion: 2 } }, "meta.formatVersion");
    const tables = { ...data.tables } as Record<string, unknown>;
    delete tables.notes;
    rejected({ ...data, tables }, "tables.notes");
    rejected({ ...data, tables: [] }, "tables");
  });
  it("accumulates independent issues in deterministic table/index/field order", () => {
    const data = bundle();
    const prompts = data.tables.prompts as unknown as Array<Record<string, unknown>>;
    prompts[0]!.title = false;
    prompts[0]!.is_starred = 3;
    prompts[1]!.description = 4;
    const tags = data.tables.tags as unknown as Array<Record<string, unknown>>;
    tags[0]!.color = 8;
    const before = fullDatabaseSnapshot(db);
    let caught: unknown;
    try { lib.importLibrary(data); } catch (error) { caught = error; }
    expect(fullDatabaseSnapshot(db)).toEqual(before);
    expect(caught).toMatchObject({ name: "LibraryImportValidationError", issues: [
      expect.objectContaining({ path: "tables.prompts[0].is_starred" }),
      expect.objectContaining({ path: "tables.prompts[0].title" }),
      expect.objectContaining({ path: "tables.prompts[1].description" }),
      expect.objectContaining({ path: "tables.tags[0].color" }),
    ] });
  });
  it("preserves null-base legacy drafts, unresolved run providers and concurrent numbering", () => {
    const data = bundle();
    delete (data.tables.prompts[0] as Partial<LibraryExport["tables"]["prompts"][number]>).draft_base_version_id;
    data.tables.runs[0]!.provider = "deleted-provider";
    data.tables.versions[1]!.number = data.tables.versions[0]!.number;
    const fresh = openMemoryDatabase();
    try {
      const destination = new PromptLibrary(fresh);
      destination.importLibrary(data);
      expect(destination.getPrompt(data.tables.prompts[0]!.id)).toMatchObject({
        draft_content: "draft text", draft_base_version_id: null,
      });
      expect(destination.listRuns(data.tables.prompts[0]!.id)[0]!.provider).toBe("deleted-provider");
      const expected = structuredClone(data.tables);
      expected.prompts[0]!.draft_base_version_id = null;
      expect(destination.exportLibrary().tables).toEqual(expected);
    } finally { fresh.close(); }
  });
  it("normalizes missing provider fields without mutating the input", () => {
    const data = bundle();
    const provider = data.tables.providers![0]!;
    const raw = provider as unknown as Record<string, unknown>;
    for (const field of ["driver", "base_url", "enabled", "created_at", "api_key_enc"]) delete raw[field];
    const before = structuredClone(data);
    const normalized = preflightLibraryImport(data);
    expect(normalized.tables.providers[0]).toMatchObject({
      id: provider.id, type: "openai", driver: "openai", base_url: null,
      enabled: 1, api_key_enc: null, created_at: expect.any(String),
    });
    expect(data).toEqual(before);
    lib.importLibrary(data);
    expect(lib.listProviders().every((row) => row.api_key_enc === null)).toBe(true);
  });
  it("checks deep ancestry iteratively and reports only the cycle members", () => {
    const data = bundle();
    const root = data.tables.versions[0]!;
    for (let i = 0; i < 12_000; i += 1) {
      data.tables.versions.push({ ...root, id: `deep-${i}`, parent_version_id: i ? `deep-${i - 1}` : root.id });
    }
    expect(preflightLibraryImport(data).tables.versions).toHaveLength(12_005);
    data.tables.versions[5]!.parent_version_id = "deep-11999";
    let caught: unknown;
    const before = fullDatabaseSnapshot(db);
    try { lib.importLibrary(data); } catch (error) { caught = error; }
    expect(fullDatabaseSnapshot(db)).toEqual(before);
    expect(caught).toBeInstanceOf(LibraryImportValidationError);
    const issues = (caught as LibraryImportValidationError).issues;
    expect(issues).toHaveLength(12_000);
    expect(issues[0]).toMatchObject({ path: "tables.versions[5].parent_version_id", code: "parent_cycle" });
    expect(issues.at(-1)).toMatchObject({ path: "tables.versions[12004].parent_version_id", code: "parent_cycle" });
  });
});

describe("export/import", () => {
  it("round-trips losslessly into a fresh database", () => {
    const { prompt } = populate(lib);
    const exported = lib.exportLibrary();
    // Must be plain JSON-serializable.
    const payload = JSON.parse(JSON.stringify(exported)) as LibraryExport;
    expect(payload.meta.formatVersion).toBe(1);

    const freshDb = openMemoryDatabase();
    const freshLib = new PromptLibrary(freshDb);
    const summary = freshLib.importLibrary(payload);

    expect(rowCounts(freshDb)).toEqual(rowCounts(db));
    expect(freshLib.exportLibrary().tables).toEqual(exported.tables);
    expect(summary.prompts!.inserted).toBe(1);
    expect(summary.prompts!.remapped).toBe(0);

    // Spot-check content survived.
    const imported = freshLib.getPrompt(prompt.id)!;
    expect(imported.title).toBe("Reviewer");
    expect(imported.draft_content).toBe("draft text");
    expect(imported.draft_base_version_id).toBe(prompt.current_version_id);
    expect(imported.is_starred).toBe(1);
    expect(imported.current_version_id).toBe(prompt.current_version_id);

    const versions = freshLib.listVersions(prompt.id);
    expect(versions).toHaveLength(4);
    const alt = versions.find((v) => v.branch_name === "strict" && v.number === 2)!;
    expect(alt.content).toBe("Be strict");
    expect(alt.parent_version_id).not.toBeNull();

    expect(freshLib.listNotes(prompt.id)).toHaveLength(2);
    expect(freshLib.listTags()[0]!.usage_count).toBe(1);
    expect(freshLib.listCollections()[0]!.prompt_count).toBe(1);
    expect(freshLib.getAverageRatings("prompt", prompt.id).effectiveness).toBeCloseTo(4);
    expect(freshLib.listRuns(prompt.id)[0]!.model).toBe("claude-opus");
    expect(freshLib.listRuns(prompt.id)[0]!.prompt_content).toBe(
      "Review the release candidate from 2026-09-02",
    );
    expect(JSON.parse(freshLib.listRuns(prompt.id)[0]!.metrics_json!)).toEqual({ tokens: 100 });

    // Search index rebuilt.
    expect(freshLib.search("carefully").map((r) => r.promptId)).toContain(prompt.id);
    freshDb.close();
  });

  it("remaps colliding ids without clobbering existing rows", () => {
    const { prompt, tag, collection } = populate(lib);
    const exported = JSON.parse(JSON.stringify(lib.exportLibrary())) as LibraryExport;

    // Import the same payload back into the same database: every id collides.
    const summary = lib.importLibrary(exported);

    expect(summary.prompts!.remapped).toBe(1);
    expect(summary.prompts!.inserted).toBe(0);
    // Tag and collection merge by unique name instead of duplicating.
    expect(summary.tags!.merged).toBe(1);
    expect(summary.collections!.merged).toBe(1);

    // Original rows untouched.
    const original = lib.getPrompt(prompt.id)!;
    expect(original.title).toBe("Reviewer");
    expect(original.current_version_id).toBe(prompt.current_version_id);

    // Doubled entity rows, merged tag/collection, junctions not duplicated.
    const counts = rowCounts(db);
    expect(counts.prompts).toBe(2);
    expect(counts.branches).toBe(4);
    expect(counts.versions).toBe(8);
    expect(counts.notes).toBe(4);
    expect(counts.tags).toBe(1);
    expect(counts.collections).toBe(1);
    expect(counts.ratings).toBe(4);
    expect(counts.runs).toBe(2);
    // Both prompts now carry the merged tag; collection holds both prompts.
    expect(counts.prompt_tags).toBe(2);
    expect(counts.collection_prompts).toBe(2);

    // The imported copy is a fully wired clone.
    const clone = db
      .prepare("SELECT * FROM prompts WHERE id != ?")
      .get(prompt.id) as { id: string; title: string; current_version_id: string };
    expect(clone.title).toBe("Reviewer");
    expect(clone.id).not.toBe(prompt.id);
    expect(clone.current_version_id).not.toBe(prompt.current_version_id);
    const cloneVersions = lib.listVersions(clone.id);
    expect(cloneVersions).toHaveLength(4);
    expect(cloneVersions.map((v) => v.id)).toContain(clone.current_version_id);
    const cloneAlt = cloneVersions.find((v) => v.branch_name === "strict" && v.number === 2)!;
    expect(cloneAlt.content).toBe("Be strict");
    // Clone's parent pointers reference clone versions, not originals.
    const originalIds = new Set(lib.listVersions(prompt.id).map((v) => v.id));
    for (const v of cloneVersions) {
      if (v.parent_version_id) expect(originalIds.has(v.parent_version_id)).toBe(false);
    }

    // Imported tag merge points the clone's prompt_tags at the existing tag.
    const cloneTagRow = db
      .prepare("SELECT tag_id FROM prompt_tags WHERE prompt_id = ?")
      .get(clone.id) as { tag_id: string };
    expect(cloneTagRow.tag_id).toBe(tag.id);

    // Search finds both copies.
    const hits = new Set(lib.search("strict").map((r) => r.promptId));
    expect(hits.size).toBeGreaterThanOrEqual(2);
    expect(hits.has(prompt.id)).toBe(true);
    expect(hits.has(clone.id)).toBe(true);
  });

  it("remaps colliding version parents when children appear first", () => {
    const prompt = lib.createPrompt({ title: "Child first", content: "v1" });
    const branch = lib.listBranches(prompt.id)[0]!;
    const v2 = lib.createVersion({
      promptId: prompt.id,
      branchId: branch.id,
      content: "v2",
    });
    const originalParentId = v2.parent_version_id!;
    const exported = JSON.parse(JSON.stringify(lib.exportLibrary())) as LibraryExport;
    exported.tables.versions.reverse();

    lib.importLibrary(exported);

    const clone = lib.listPrompts().find((row) => row.id !== prompt.id)!;
    const cloneVersions = lib.listVersions(clone.id);
    const cloneV1 = cloneVersions.find((version) => version.number === 1)!;
    const cloneV2 = cloneVersions.find((version) => version.number === 2)!;
    expect(cloneV2.parent_version_id).toBe(cloneV1.id);
    expect(cloneV2.parent_version_id).not.toBe(originalParentId);
  });

  it("remaps a prompt id that was previously hard-deleted on this device", () => {
    const sourceDb = openMemoryDatabase();
    const sourceLib = new PromptLibrary(sourceDb);
    const sourcePrompt = sourceLib.createPrompt({ title: "Imported again", content: "v1" });
    const sourceVersionId = sourcePrompt.current_version_id!;
    const exported = sourceLib.exportLibrary();

    lib.importLibrary(exported);
    lib.hardDeletePrompt(sourcePrompt.id);
    const summary = lib.importLibrary(exported);

    expect(lib.getPrompt(sourcePrompt.id)).toBeNull();
    const replacement = lib.listPrompts().find((prompt) => prompt.title === "Imported again");
    expect(replacement?.id).toBeDefined();
    expect(replacement?.id).not.toBe(sourcePrompt.id);
    expect(lib.listVersions(replacement!.id)[0]?.id).not.toBe(sourceVersionId);
    expect(summary.prompts?.remapped).toBe(1);
    expect(summary.versions?.remapped).toBe(1);
    sourceDb.close();
  });

  it("round-trips provider configuration without API keys", () => {
    const { prompt } = populate(lib);
    const provider = lib.createProvider({
      type: "groq",
      driver: "openai-compatible",
      name: "Groq",
      apiKeyEnc: "enc:device-bound-blob",
      baseUrl: "https://api.groq.com/openai/v1",
    });
    lib.setProviderModels(provider.id, [
      { modelId: "llama-3.1-8b-instant" },
      { modelId: "llama-3.3-70b-versatile", enabled: false },
    ]);
    lib.recordModelRun({
      promptId: prompt.id,
      versionId: prompt.current_version_id!,
      provider: provider.id,
      model: "llama-3.1-8b-instant",
      status: "completed",
      output: "hi",
      runGroupId: "g1",
    });

    const exported = JSON.parse(JSON.stringify(lib.exportLibrary())) as LibraryExport;
    // Keys never leave the device: exported as null even though one is stored.
    expect(exported.tables.providers).toHaveLength(1);
    expect(exported.tables.providers![0]!.api_key_enc).toBeNull();
    expect(JSON.stringify(exported)).not.toContain("device-bound-blob");

    const freshLib = new PromptLibrary(openMemoryDatabase());
    freshLib.importLibrary(exported);

    const imported = freshLib.getProvider(provider.id)!;
    expect(imported).toMatchObject({
      type: "groq",
      driver: "openai-compatible",
      name: "Groq",
      api_key_enc: null, // → hasApiKey false; the user re-enters the key
      base_url: "https://api.groq.com/openai/v1",
      enabled: 1,
    });
    // Model visibility survives.
    expect(freshLib.listProviderModels(provider.id)).toEqual([
      expect.objectContaining({ model_id: "llama-3.1-8b-instant", enabled: 1 }),
      expect.objectContaining({ model_id: "llama-3.3-70b-versatile", enabled: 0 }),
    ]);
    // Runs still resolve their provider name in run groups.
    const group = freshLib.listRunGroups(prompt.id)[0]!;
    expect(group.runs[0]!.providerName).toBe("Groq");
  });

  it("keeps device-local settings out of library files", () => {
    lib.setCatalogCache('{"providers":[],"models":{}}');
    lib.setSetting("portal_base_url", "https://source.example");
    lib.setSetting("sync.enabled", "1");

    const exported = lib.exportLibrary();
    expect(exported.tables.settings).toEqual([]);

    const destination = new PromptLibrary(openMemoryDatabase());
    destination.setCatalogCache('{"providers":[{"id":"trusted"}],"models":{}}');
    destination.setSetting("portal_base_url", "https://destination.example");
    destination.setSetting("sync.enabled", "0");
    const trustedCache = destination.getCatalogCache();
    const crafted = JSON.parse(JSON.stringify(exported)) as LibraryExport;
    crafted.tables.settings.push({
      key: "model_catalog",
      value: JSON.stringify({
        fetchedAt: "2026-09-03T00:00:00.000Z",
        json: '{"providers":[{"id":"attacker"}],"models":{}}',
      }),
    });
    crafted.tables.settings.push(
      { key: "portal_base_url", value: "https://attacker.example" },
      { key: "sync.enabled", value: "1" },
    );

    const summary = destination.importLibrary(crafted);

    expect(destination.getCatalogCache()).toEqual(trustedCache);
    expect(destination.getSetting("portal_base_url")).toBe("https://destination.example");
    expect(destination.getSetting("sync.enabled")).toBe("0");
    expect(summary.settings?.skipped).toBe(3);
  });

  it("remaps provider ids on collision, keeping runs wired to the clone", () => {
    const { prompt } = populate(lib);
    const provider = lib.createProvider({ type: "openai", name: "My OpenAI" });
    lib.recordModelRun({
      promptId: prompt.id,
      versionId: prompt.current_version_id!,
      provider: provider.id,
      model: "gpt-4o-mini",
      status: "completed",
      output: "hi",
      runGroupId: "g1",
    });

    // Importing into the same database remaps every id, providers included.
    const exported = JSON.parse(JSON.stringify(lib.exportLibrary())) as LibraryExport;
    const summary = lib.importLibrary(exported);
    expect(summary.providers!.remapped).toBe(1);

    const clone = db.prepare("SELECT id FROM prompts WHERE id != ?").get(prompt.id) as { id: string };
    const cloneGroup = lib.listRunGroups(clone.id)[0]!;
    expect(cloneGroup.runs[0]!.provider).not.toBe(provider.id);
    expect(cloneGroup.runs[0]!.providerName).toBe("My OpenAI");
  });

  it("imports a pre-v3 bundle: old-shape runs default, provider tables absent", () => {
    // Hand-built bundle as produced before schema v3 (and without the later
    // provider tables): runs carry only the original columns.
    const bundle = {
      meta: { formatVersion: 1, exportedAt: "2024-01-01T00:00:00Z" },
      tables: {
        prompts: [
          {
            id: "p1",
            title: "Old",
            description: null,
            icon: null,
            draft_content: null,
            current_version_id: "v1",
            is_starred: 0,
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
            deleted_at: null,
          },
        ],
        branches: [{ id: "b1", prompt_id: "p1", name: "main", description: null, created_at: "2024-01-01T00:00:00Z" }],
        versions: [
          {
            id: "v1",
            prompt_id: "p1",
            branch_id: "b1",
            parent_version_id: null,
            number: 1,
            label: null,
            content: "old content",
            content_format: "markdown",
            change_note: null,
            author: "You",
            // pre-v2: no status/source
            created_at: "2024-01-01T00:00:00Z",
          },
        ],
        notes: [],
        tags: [],
        prompt_tags: [],
        collections: [],
        collection_prompts: [],
        ratings: [],
        runs: [
          {
            id: "r1",
            prompt_id: "p1",
            version_id: "v1",
            tool: "claude",
            model: "claude-opus",
            outcome_rating: 4,
            result_summary: "worked",
            metrics_json: null,
            started_at: null,
            // pre-v3: no provider/status/output/error/latency_ms/run_group_id
            created_at: "2024-01-01T00:00:00Z",
          },
        ],
        settings: [],
        // pre-v3: no providers / provider_models tables at all
      },
    } as unknown as LibraryExport;

    const freshLib = new PromptLibrary(openMemoryDatabase());
    expect(() => freshLib.importLibrary(bundle)).not.toThrow();

    const run = freshLib.listRuns("p1")[0]!;
    expect(run.status).toBe("completed");
    expect(run.provider).toBeNull();
    expect(run.output).toBeNull();
    expect(run.prompt_content).toBeNull();
    expect(run.outcome_rating).toBe(4);
    expect(freshLib.getPrompt("p1")!.current_version_id).toBe("v1");
    expect(freshLib.listProviders()).toEqual([]);
  });
});
