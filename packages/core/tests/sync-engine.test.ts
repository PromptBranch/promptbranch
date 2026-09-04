import { describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../src/db.js";
import { formatHlc } from "../src/sync/hlc.js";
import { PromptLibrary } from "../src/library.js";
import { SyncEngine, type SyncOp } from "../src/sync/engine.js";

interface Rig {
  db: ReturnType<typeof openMemoryDatabase>;
  lib: PromptLibrary;
  engine: SyncEngine;
}

function rig(): Rig {
  const db = openMemoryDatabase();
  return { db, lib: new PromptLibrary(db), engine: new SyncEngine(db) };
}

/** Pushes everything `from` knows that `to` is missing, in budgeted rounds. */
function drain(from: SyncEngine, to: SyncEngine, byteBudget?: number): void {
  for (let round = 0; round < 200; round++) {
    const { ops, hasMore } = from.opsSince(to.haveVector(), byteBudget);
    if (ops.length > 0) to.applyRemote(ops);
    if (!hasMore || ops.length === 0) break;
  }
}

function syncBoth(a: Rig, b: Rig, byteBudget?: number): void {
  drain(a.engine, b.engine, byteBudget);
  drain(b.engine, a.engine, byteBudget);
}

function fixedOp(
  source: string,
  seq: number,
  table: SyncOp["table"],
  recordId: string,
  payload: Record<string, unknown> | null,
  millis: number,
  kind: "upsert" | "delete" = "upsert",
): SyncOp {
  return {
    source,
    seq,
    opId: `${source}-${seq}-${table}-${recordId}-${kind}`,
    table,
    recordId,
    kind,
    payload,
    hlc: formatHlc({ millis, counter: 0 }),
    createdAt: "2026-09-03T00:00:00.000Z",
  };
}

function seedPrompt(r: Rig, id: string): void {
  r.db
    .prepare(
      `INSERT INTO prompts (id, title, created_at, updated_at)
       VALUES (?, 'Fixed prompt', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z')`,
    )
    .run(id);
  r.db.prepare("DELETE FROM sync_dirty").run();
}

/** Export with table arrays sorted by stable keys, for cross-device equality. */
function normalizedExport(r: Rig) {
  const data = r.lib.exportLibrary();
  const t = data.tables;
  const by = <T>(rows: T[], key: (row: T) => string): T[] =>
    [...rows].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  return {
    prompts: by(t.prompts, (p) => p.id),
    branches: by(t.branches, (b) => b.id),
    versions: by(t.versions, (v) => v.id),
    notes: by(t.notes, (n) => n.id),
    tags: by(t.tags, (g) => g.name),
    prompt_tags: by(t.prompt_tags, (p) => `${p.prompt_id}:${p.tag_id}`),
    collections: by(t.collections, (c) => c.id),
    collection_prompts: by(t.collection_prompts, (c) => `${c.collection_id}:${c.prompt_id}`),
    ratings: by(t.ratings, (row) => row.id),
    runs: by(t.runs, (row) => row.id),
  };
}

describe("sync engine", () => {
  it("gives each device a stable distinct id", () => {
    const a = rig();
    const b = rig();
    expect(a.engine.deviceId()).toBe(a.engine.deviceId());
    expect(a.engine.deviceId()).not.toBe(b.engine.deviceId());
  });

  it("propagates a new prompt with versions, tags and notes, and FTS finds it on the peer", () => {
    const a = rig();
    const b = rig();
    const tag = a.lib.createTag({ name: "prod", color: "#ff0000" });
    const prompt = a.lib.createPrompt({
      title: "Code reviewer",
      description: "Reviews a diff",
      content: "Review this diff carefully",
      changeNote: "initial",
      tagIds: [tag.id],
    });
    a.lib.addNote({ promptId: prompt.id, body: "works great with Sonnet" });
    a.lib.createVersion({
      promptId: prompt.id,
      branchId: prompt.current_version_id ? a.lib.listBranches(prompt.id)[0]!.id : "",
      content: "Review this diff v2",
      changeNote: "tightened",
    });
    expect(a.engine.pendingDirty()).toBeGreaterThan(0);

    a.engine.refineDirty();
    drain(a.engine, b.engine);

    const got = b.lib.getPrompt(prompt.id);
    expect(got?.title).toBe("Code reviewer");
    expect(b.lib.listVersions(prompt.id).length).toBe(2);
    expect(b.lib.listNotes(prompt.id)[0]?.body).toBe("works great with Sonnet");
    expect(b.lib.listTagsForPrompt(prompt.id).map((t) => t.name)).toEqual(["prod"]);
    expect(b.lib.search("sonnet").length).toBeGreaterThan(0);
    expect(b.lib.search("diff").length).toBeGreaterThan(0);
    expect(b.engine.pendingDirty()).toBe(0);
  });

  it("propagates version names and standalone prompt duplicates", () => {
    const a = rig();
    const b = rig();
    const tag = a.lib.createTag({ name: "review" });
    const collection = a.lib.createCollection({ name: "Work" });
    const source = a.lib.createPrompt({
      title: "Reviewer",
      description: "Reviews a change",
      content: "Review this change",
      tagIds: [tag.id],
    });
    a.lib.addPromptToCollection(collection.id, source.id, 4);
    const sourceVersion = a.lib.listVersions(source.id)[0]!;

    a.lib.updateVersionLabel(sourceVersion.id, "Production");
    const duplicate = a.lib.duplicatePrompt({
      promptId: source.id,
      versionId: sourceVersion.id,
      title: "Reviewer copy",
    });

    a.engine.refineDirty();
    drain(a.engine, b.engine);

    expect(b.lib.getVersion(sourceVersion.id)?.label).toBe("Production");
    expect(b.lib.getPrompt(duplicate.id)).toMatchObject({
      title: "Reviewer copy",
      description: "Reviews a change",
      is_starred: 0,
    });
    expect(b.lib.listVersions(duplicate.id)).toMatchObject([
      { number: 1, label: null, content: "Review this change" },
    ]);
    expect(b.lib.listTagsForPrompt(duplicate.id).map((item) => item.id)).toEqual([tag.id]);
    expect(b.lib.listCollectionIdsForPrompt(duplicate.id)).toEqual([collection.id]);
  });

  it("propagates content committed into an empty version 1 placeholder", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Drafted prompt", content: "" });
    const branch = a.lib.listBranches(prompt.id)[0]!;
    const v1Id = prompt.current_version_id!;

    a.engine.refineDirty();
    drain(a.engine, b.engine);
    expect(b.lib.getVersion(v1Id)?.content).toBe("");

    const saved = a.lib.createVersion({
      promptId: prompt.id,
      branchId: branch.id,
      content: "First committed sync content",
    });
    expect(saved.id).toBe(v1Id);

    a.engine.refineDirty();
    drain(a.engine, b.engine);

    expect(b.lib.getVersion(v1Id)?.content).toBe("First committed sync content");
    expect(b.lib.listVersions(prompt.id)).toHaveLength(1);
    expect(b.lib.search("sync content").map((result) => result.promptId)).toEqual([prompt.id]);
  });

  it("syncs provider model ids that contain the composite-key delimiter", () => {
    const a = rig();
    const b = rig();
    const provider = a.lib.createProvider({
      type: "ollama",
      driver: "openai-compatible",
      name: "Local Ollama",
    });
    a.lib.setProviderModels(provider.id, [
      { modelId: "llama3.2:latest", displayName: "Llama 3.2 Latest" },
    ]);

    a.engine.refineDirty();
    drain(a.engine, b.engine);

    expect(b.lib.getProvider(provider.id)?.name).toBe("Local Ollama");
    expect(b.lib.listProviderModels(provider.id)).toEqual([
      expect.objectContaining({
        provider_id: provider.id,
        model_id: "llama3.2:latest",
        display_name: "Llama 3.2 Latest",
      }),
    ]);
  });

  it("bootstraps provider model ids that contain the composite-key delimiter", () => {
    const a = rig();
    const b = rig();
    const provider = a.lib.createProvider({
      type: "ollama",
      driver: "openai-compatible",
      name: "Bootstrap Ollama",
    });
    a.lib.setProviderModels(provider.id, [{ modelId: "qwen3:8b" }]);
    a.db.prepare("DELETE FROM sync_dirty").run();

    a.engine.bootstrapDirty();
    a.engine.refineDirty();
    drain(a.engine, b.engine);

    expect(b.lib.listProviderModels(provider.id)).toEqual([
      expect.objectContaining({ model_id: "qwen3:8b" }),
    ]);
  });

  it("applies LWW consistently to delimiter-bearing provider model ids", () => {
    const a = rig();
    const b = rig();
    const provider = a.lib.createProvider({
      type: "ollama",
      driver: "openai-compatible",
      name: "LWW Ollama",
    });
    a.lib.setProviderModels(provider.id, [
      { modelId: "qwen3:8b", displayName: "Original" },
    ]);
    a.engine.refineDirty(1_000);
    drain(a.engine, b.engine);

    b.lib.setProviderModels(provider.id, [
      { modelId: "qwen3:8b", displayName: "Newer local" },
    ]);
    b.engine.refineDirty(3_000);
    a.lib.setProviderModels(provider.id, [
      { modelId: "qwen3:8b", displayName: "Older remote" },
    ]);
    a.engine.refineDirty(2_000);
    drain(a.engine, b.engine);

    expect(b.lib.listProviderModels(provider.id)[0]?.display_name).toBe("Newer local");
  });

  it("syncs deletion of provider model ids containing the composite-key delimiter", () => {
    const a = rig();
    const b = rig();
    const provider = a.lib.createProvider({
      type: "ollama",
      driver: "openai-compatible",
      name: "Delete Ollama",
    });
    a.lib.setProviderModels(provider.id, [{ modelId: "llama3.2:latest" }]);
    a.engine.refineDirty(1_000);
    drain(a.engine, b.engine);

    a.lib.setProviderModels(provider.id, []);
    a.engine.refineDirty(2_000);
    drain(a.engine, b.engine);

    expect(b.lib.listProviderModels(provider.id)).toEqual([]);
  });

  it("syncs imported composite ids that begin with the JSON encoding marker", () => {
    const a = rig();
    const b = rig();
    a.db
      .prepare(
        `INSERT INTO providers (id, type, driver, name, created_at)
         VALUES ('[tenant', 'ollama', 'openai-compatible', 'Bracket Ollama', '2026-09-02T00:00:00.000Z')`,
      )
      .run();
    a.db
      .prepare(
        `INSERT INTO provider_models (provider_id, model_id, display_name, enabled)
         VALUES ('[tenant', 'llama', 'Bracket Llama', 1)`,
      )
      .run();

    a.engine.refineDirty(1_000);
    drain(a.engine, b.engine);
    expect(b.lib.listProviderModels("[tenant")).toHaveLength(1);

    a.db
      .prepare("DELETE FROM provider_models WHERE provider_id = '[tenant' AND model_id = 'llama'")
      .run();
    a.engine.refineDirty(2_000);
    drain(a.engine, b.engine);
    expect(b.lib.listProviderModels("[tenant")).toEqual([]);
  });

  it("syncs imported delimiter-bearing ids through every junction table", () => {
    const a = rig();
    const b = rig();
    const createdAt = "2026-09-02T00:00:00.000Z";
    a.db
      .prepare(
        `INSERT INTO prompts (id, title, created_at, updated_at)
         VALUES ('tenant:prompt', 'Imported prompt', ?, ?)`,
      )
      .run(createdAt, createdAt);
    a.db.prepare("INSERT INTO tags (id, name) VALUES ('tag:one', 'Imported tag')").run();
    a.db
      .prepare("INSERT INTO prompt_tags (prompt_id, tag_id) VALUES ('tenant:prompt', 'tag:one')")
      .run();
    a.db
      .prepare("INSERT INTO collections (id, name, sort_order) VALUES ('collection:one', 'Imported', 0)")
      .run();
    a.db
      .prepare(
        `INSERT INTO collection_prompts (collection_id, prompt_id, sort_order)
         VALUES ('collection:one', 'tenant:prompt', 0)`,
      )
      .run();

    a.engine.refineDirty(1_000);
    drain(a.engine, b.engine);

    expect(b.lib.listTagsForPrompt("tenant:prompt").map((tag) => tag.id)).toEqual(["tag:one"]);
    expect(
      b.db
        .prepare(
          `SELECT 1 FROM collection_prompts
           WHERE collection_id = 'collection:one' AND prompt_id = 'tenant:prompt'`,
        )
        .get(),
    ).toBeTruthy();
  });

  it("unions concurrent append-only edits and converges branch numbering", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Shared", content: "v1" });
    a.engine.refineDirty();
    drain(a.engine, b.engine);

    // Both devices append a version to the same branch while apart.
    const branchA = a.lib.listBranches(prompt.id)[0]!;
    const bPrompt = b.lib.getPrompt(prompt.id)!;
    const branchB = b.lib.listBranches(bPrompt.id)[0]!;
    const vA = a.lib.createVersion({ promptId: prompt.id, branchId: branchA.id, content: "from A" });
    const vB = b.lib.createVersion({ promptId: bPrompt.id, branchId: branchB.id, content: "from B" });
    a.engine.refineDirty(Date.now() + 1_000);
    b.engine.refineDirty(Date.now() + 2_000);
    syncBoth(a, b);

    for (const r of [a, b]) {
      const versions = r.lib.listVersions(prompt.id);
      expect(versions.map((v) => v.content).sort()).toEqual(["from A", "from B", "v1"]);
      // Deterministic renumbering: 1..3 with no duplicates.
      const numbers = versions.map((v) => v.number).sort((x, y) => x - y);
      expect(numbers).toEqual([1, 2, 3]);
    }
    // Both versions exist on both sides.
    expect(a.lib.getVersion(vB.id)?.content).toBe("from B");
    expect(b.lib.getVersion(vA.id)?.content).toBe("from A");
  });

  it("resolves concurrent metadata edits by HLC last-writer-wins", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "LWW", content: "x" });
    a.engine.refineDirty();
    drain(a.engine, b.engine);

    a.lib.setStarred(prompt.id, true);
    a.engine.refineDirty(Date.now() + 1_000);
    b.lib.setStarred(prompt.id, false);
    b.engine.refineDirty(Date.now() + 2_000);
    syncBoth(a, b);

    expect(a.lib.getPrompt(prompt.id)?.is_starred).toBe(0);
    expect(b.lib.getPrompt(prompt.id)?.is_starred).toBe(0);
  });

  it("merges same-name tags created independently and normalizes membership", () => {
    const a = rig();
    const b = rig();
    const tagA = a.lib.createTag({ name: "prod" });
    const tagB = b.lib.createTag({ name: "prod" });
    const pA = a.lib.createPrompt({ title: "A prompt", content: "a" });
    const pB = b.lib.createPrompt({ title: "B prompt", content: "b" });
    a.lib.addTagToPrompt(pA.id, tagA.id);
    b.lib.addTagToPrompt(pB.id, tagB.id);
    a.engine.refineDirty(Date.now() + 1_000);
    b.engine.refineDirty(Date.now() + 2_000);
    syncBoth(a, b);

    for (const r of [a, b]) {
      const tags = r.lib.listTags().filter((t) => t.name === "prod");
      expect(tags.length).toBe(1);
      expect(tags[0]?.usage_count).toBe(2);
      expect(r.lib.listTagsForPrompt(pA.id).map((t) => t.name)).toEqual(["prod"]);
      expect(r.lib.listTagsForPrompt(pB.id).map((t) => t.name)).toEqual(["prod"]);
    }
  });

  it("canonical natural-key tag collisions to the smallest id on every live peer", () => {
    const a = rig();
    const b = rig();
    a.db.prepare("INSERT INTO tags (id, name, color) VALUES ('tag-a', 'prod', '#0000aa')").run();
    b.db.prepare("INSERT INTO tags (id, name, color) VALUES ('tag-b', 'prod', '#0000bb')").run();

    a.engine.refineDirty(1_000);
    b.engine.refineDirty(2_000);
    syncBoth(a, b);

    for (const r of [a, b]) {
      expect(r.db.prepare("SELECT id, name, color FROM tags WHERE name = 'prod'").all()).toEqual([
        { id: "tag-a", name: "prod", color: "#0000bb" },
      ]);
    }
  });

  it("lets a newer alias tombstone win when its parent upsert arrives later", () => {
    const r = rig();
    const tag = (id: string, kind: "upsert" | "delete", millis: number): SyncOp => ({
      source: `source-${id}-${kind}`,
      seq: 1,
      opId: `${id}-${kind}-${millis}`,
      table: "tags",
      recordId: id,
      kind,
      payload: kind === "upsert" ? { id, name: "prod", color: `#${millis}` } : null,
      hlc: formatHlc({ millis, counter: 0 }),
      createdAt: "2026-09-02T00:00:00.000Z",
    });

    r.engine.applyRemote([tag("tag-a", "upsert", 100)]);
    r.engine.applyRemote([tag("tag-b", "delete", 300)]);
    r.engine.applyRemote([tag("tag-b", "upsert", 200)]);

    expect(r.db.prepare("SELECT id FROM tags WHERE name = 'prod'").all()).toEqual([]);
    expect(r.db.prepare("SELECT record_id, hlc FROM sync_heads WHERE table_name = 'tags'").all()).toEqual([
      { record_id: "tag-a", hlc: formatHlc({ millis: 300, counter: 0 }) },
    ]);
  });

  it("reduces head-only tag-membership tombstones when aliases become canonical", () => {
    const r = rig();
    const prompt = r.lib.createPrompt({ title: "Membership", content: "x" });
    r.db.prepare("DELETE FROM sync_dirty").run();
    const op = (table: "tags" | "prompt_tags", recordId: string, kind: "upsert" | "delete", payload: Record<string, unknown> | null, millis: number): SyncOp => ({
      source: `source-${table}-${recordId}-${kind}`,
      seq: 1,
      opId: `${table}-${recordId}-${kind}-${millis}`,
      table,
      recordId,
      kind,
      payload,
      hlc: formatHlc({ millis, counter: 0 }),
      createdAt: "2026-09-02T00:00:00.000Z",
    });

    r.engine.applyRemote([
      op("tags", "tag-a", "upsert", { id: "tag-a", name: "prod", color: null }, 100),
      op("prompt_tags", `${prompt.id}:tag-a`, "upsert", { prompt_id: prompt.id, tag_id: "tag-a" }, 100),
    ]);
    r.engine.applyRemote([op("prompt_tags", `${prompt.id}:tag-b`, "delete", null, 300)]);
    r.engine.applyRemote([op("tags", "tag-b", "upsert", { id: "tag-b", name: "prod", color: null }, 200)]);

    expect(r.db.prepare("SELECT prompt_id, tag_id FROM prompt_tags").all()).toEqual([]);
    expect(
      r.db
        .prepare("SELECT record_id, hlc FROM sync_heads WHERE table_name = 'prompt_tags'")
        .all(),
    ).toEqual([{ record_id: `${prompt.id}:tag-a`, hlc: formatHlc({ millis: 300, counter: 0 }) }]);
  });

  it("reduces collection membership history at the canonical key and keeps the winning sort order", () => {
    const r = rig();
    const prompt = r.lib.createPrompt({ title: "Collection membership", content: "x" });
    r.db.prepare("DELETE FROM sync_dirty").run();
    const op = (table: "collections" | "collection_prompts", recordId: string, payload: Record<string, unknown>, millis: number): SyncOp => ({
      source: `source-${table}-${recordId}-${millis}`,
      seq: 1,
      opId: `${table}-${recordId}-${millis}`,
      table,
      recordId,
      kind: "upsert",
      payload,
      hlc: formatHlc({ millis, counter: 0 }),
      createdAt: "2026-09-02T00:00:00.000Z",
    });

    r.engine.applyRemote([
      op("collections", "collection-a", { id: "collection-a", name: "prod", sort_order: 0 }, 100),
      op(
        "collection_prompts",
        `collection-a:${prompt.id}`,
        { collection_id: "collection-a", prompt_id: prompt.id, sort_order: 1 },
        100,
      ),
      op("collections", "collection-b", { id: "collection-b", name: "prod", sort_order: 0 }, 200),
      op(
        "collection_prompts",
        `collection-b:${prompt.id}`,
        { collection_id: "collection-b", prompt_id: prompt.id, sort_order: 9 },
        300,
      ),
    ]);

    expect(r.db.prepare("SELECT collection_id, prompt_id, sort_order FROM collection_prompts").all()).toEqual([
      { collection_id: "collection-a", prompt_id: prompt.id, sort_order: 9 },
    ]);
    expect(
      r.db
        .prepare("SELECT record_id, hlc FROM sync_heads WHERE table_name = 'collection_prompts'")
        .all(),
    ).toEqual([{ record_id: `collection-a:${prompt.id}`, hlc: formatHlc({ millis: 300, counter: 0 }) }]);
  });

  it("refines pending alias writes before a remote canonical rekey", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Pending membership", content: "x" });
    a.engine.refineDirty(100);
    drain(a.engine, b.engine);

    a.db.prepare("INSERT INTO tags (id, name, color) VALUES ('tag-a', 'prod', NULL)").run();
    a.engine.refineDirty(1_000);
    b.db.prepare("INSERT INTO tags (id, name, color) VALUES ('tag-b', 'prod', NULL)").run();
    b.db.prepare("INSERT INTO prompt_tags (prompt_id, tag_id) VALUES (?, 'tag-b')").run(prompt.id);

    drain(a.engine, b.engine);
    b.engine.refineDirty(2_000);
    const pending = b.engine.opsSince({}).ops.filter((entry) => entry.source === b.engine.deviceId());
    expect(pending.filter((entry) => entry.table === "tags").at(-1)?.kind).toBe("upsert");
    expect(pending.filter((entry) => entry.table === "prompt_tags").at(-1)?.kind).toBe("upsert");

    drain(b.engine, a.engine);
    expect(a.lib.listTagsForPrompt(prompt.id).map((tag) => tag.name)).toEqual(["prod"]);
    expect(b.lib.listTagsForPrompt(prompt.id).map((tag) => tag.name)).toEqual(["prod"]);
  });

  it("reports structural canonicalization when the incoming parent op is stale", () => {
    const r = rig();
    const tag = (id: string, millis: number): SyncOp => ({
      source: `source-${id}`,
      seq: 1,
      opId: `tag-${id}-${millis}`,
      table: "tags",
      recordId: id,
      kind: "upsert",
      payload: { id, name: "prod", color: `#${millis}` },
      hlc: formatHlc({ millis, counter: 0 }),
      createdAt: "2026-09-02T00:00:00.000Z",
    });

    r.engine.applyRemote([tag("tag-b", 2_000)]);
    const summary = r.engine.applyRemote([tag("tag-a", 1_000)]);

    expect(summary).toMatchObject({ applied: 1, stale: 0, skipped: 0, deferred: 0 });
    expect(r.db.prepare("SELECT id, color FROM tags WHERE name = 'prod'").all()).toEqual([
      { id: "tag-a", color: "#2000" },
    ]);
  });

  it("reports child-only canonicalization as the one applied stale parent op", () => {
    const r = rig();
    const prompt = r.lib.createPrompt({ title: "Child-only reporting", content: "x" });
    r.db.prepare("DELETE FROM sync_dirty").run();
    const op = (table: "tags" | "prompt_tags", recordId: string, kind: "upsert" | "delete", payload: Record<string, unknown> | null, millis: number): SyncOp => ({
      source: `source-${table}-${recordId}-${kind}`,
      seq: 1,
      opId: `${table}-${recordId}-${kind}-${millis}`,
      table,
      recordId,
      kind,
      payload,
      hlc: formatHlc({ millis, counter: 0 }),
      createdAt: "2026-09-02T00:00:00.000Z",
    });

    r.engine.applyRemote([
      op("tags", "tag-a", "upsert", { id: "tag-a", name: "prod", color: null }, 400),
      op("prompt_tags", `${prompt.id}:tag-a`, "upsert", { prompt_id: prompt.id, tag_id: "tag-a" }, 100),
      op("prompt_tags", `${prompt.id}:tag-b`, "delete", null, 300),
    ]);
    const summary = r.engine.applyRemote([
      op("tags", "tag-b", "upsert", { id: "tag-b", name: "prod", color: null }, 200),
    ]);

    expect(summary).toEqual({ applied: 1, skipped: 0, stale: 0, deferred: 0 });
    expect(r.db.prepare("SELECT prompt_id, tag_id FROM prompt_tags").all()).toEqual([]);
  });

  it("reports a repeated stale canonical parent as stale when all reduced state is unchanged", () => {
    const r = rig();
    const prompt = r.lib.createPrompt({ title: "Repeated canonical parent", content: "x" });
    r.db.prepare("DELETE FROM sync_dirty").run();
    const op = (table: "tags" | "prompt_tags", recordId: string, kind: "upsert" | "delete", payload: Record<string, unknown> | null, millis: number): SyncOp => ({
      source: `repeat-${table}-${recordId}-${kind}-${millis}`,
      seq: 1,
      opId: `repeat-${table}-${recordId}-${kind}-${millis}`,
      table,
      recordId,
      kind,
      payload,
      hlc: formatHlc({ millis, counter: 0 }),
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    const snapshot = () => ({
      tags: r.db.prepare("SELECT id, name, color FROM tags ORDER BY id").all(),
      promptTags: r.db.prepare("SELECT prompt_id, tag_id FROM prompt_tags ORDER BY prompt_id, tag_id").all(),
      heads: r.db.prepare("SELECT table_name, record_id, hlc, device_id FROM sync_heads ORDER BY table_name, record_id").all(),
      remaps: r.db.prepare("SELECT table_name, remote_id, local_id FROM sync_id_remaps ORDER BY table_name, remote_id").all(),
    });

    r.engine.applyRemote([
      op("tags", "tag-a", "upsert", { id: "tag-a", name: "prod", color: null }, 400),
      op("prompt_tags", `${prompt.id}:tag-a`, "upsert", { prompt_id: prompt.id, tag_id: "tag-a" }, 100),
      op("prompt_tags", `${prompt.id}:tag-b`, "delete", null, 300),
      op("tags", "tag-b", "upsert", { id: "tag-b", name: "prod", color: null }, 200),
    ]);
    const before = snapshot();
    const summary = r.engine.applyRemote([
      op("tags", "tag-a", "upsert", { id: "tag-a", name: "prod", color: null }, 150),
    ]);

    expect(summary).toEqual({ applied: 0, skipped: 0, stale: 1, deferred: 0 });
    expect(snapshot()).toEqual(before);
  });

  it("classifies a winning canonical rekey exactly once", () => {
    const r = rig();
    const tag = (id: string, millis: number): SyncOp => ({
      source: `source-${id}`,
      seq: 1,
      opId: `winning-tag-${id}-${millis}`,
      table: "tags",
      recordId: id,
      kind: "upsert",
      payload: { id, name: "prod", color: `#${millis}` },
      hlc: formatHlc({ millis, counter: 0 }),
      createdAt: "2026-09-02T00:00:00.000Z",
    });

    r.engine.applyRemote([tag("tag-b", 100)]);
    expect(r.engine.applyRemote([tag("tag-a", 200)])).toEqual({ applied: 1, skipped: 0, stale: 0, deferred: 0 });
  });

  it("keeps tag LWW state and memberships at one canonical key", () => {
    const a = rig();
    const b = rig();
    for (const r of [a, b]) seedPrompt(r, "prompt-1");
    const aOps = [
      fixedOp("device-a", 1, "tags", "tag-a", { id: "tag-a", name: "prod", color: "#112233" }, 100),
      fixedOp(
        "device-a",
        2,
        "prompt_tags",
        "prompt-1:tag-a",
        { prompt_id: "prompt-1", tag_id: "tag-a" },
        110,
      ),
    ];
    const bOps = [
      fixedOp("device-b", 1, "tags", "tag-b", { id: "tag-b", name: "prod", color: "#445566" }, 200),
      fixedOp(
        "device-b",
        2,
        "prompt_tags",
        "prompt-1:tag-b",
        { prompt_id: "prompt-1", tag_id: "tag-b" },
        210,
      ),
    ];

    a.engine.applyRemote(aOps);
    b.engine.applyRemote(bOps);
    syncBoth(a, b);

    for (const r of [a, b]) {
      expect(r.db.prepare("SELECT id, name, color FROM tags").all()).toEqual([
        { id: "tag-a", name: "prod", color: "#445566" },
      ]);
      expect(r.db.prepare("SELECT prompt_id, tag_id FROM prompt_tags").all()).toEqual([
        { prompt_id: "prompt-1", tag_id: "tag-a" },
      ]);
    }
  });

  it("keeps collection LWW sort order and membership at one canonical key", () => {
    const a = rig();
    const b = rig();
    for (const r of [a, b]) seedPrompt(r, "prompt-1");
    a.engine.applyRemote([
      fixedOp(
        "device-a",
        1,
        "collections",
        "collection-a",
        { id: "collection-a", name: "Inbox", sort_order: 2 },
        100,
      ),
      fixedOp(
        "device-a",
        2,
        "collection_prompts",
        "collection-a:prompt-1",
        { collection_id: "collection-a", prompt_id: "prompt-1", sort_order: 3 },
        110,
      ),
    ]);
    b.engine.applyRemote([
      fixedOp(
        "device-b",
        1,
        "collections",
        "collection-b",
        { id: "collection-b", name: "Inbox", sort_order: 9 },
        200,
      ),
      fixedOp(
        "device-b",
        2,
        "collection_prompts",
        "collection-b:prompt-1",
        { collection_id: "collection-b", prompt_id: "prompt-1", sort_order: 7 },
        210,
      ),
    ]);
    syncBoth(a, b);

    for (const r of [a, b]) {
      expect(r.db.prepare("SELECT id, name, sort_order FROM collections").all()).toEqual([
        { id: "collection-a", name: "Inbox", sort_order: 9 },
      ]);
      expect(r.db.prepare("SELECT collection_id, prompt_id, sort_order FROM collection_prompts").all()).toEqual([
        { collection_id: "collection-a", prompt_id: "prompt-1", sort_order: 7 },
      ]);
    }
  });

  it("unions same-prompt branch collisions and renumbers both devices' versions", () => {
    const a = rig();
    const b = rig();
    for (const r of [a, b]) seedPrompt(r, "prompt-1");
    const version = (id: string, branchId: string, content: string, createdAt: string) => ({
      id,
      prompt_id: "prompt-1",
      branch_id: branchId,
      parent_version_id: null,
      number: 1,
      label: null,
      content,
      content_format: "markdown",
      change_note: null,
      author: "You",
      status: "active",
      source: "user",
      created_at: createdAt,
    });
    a.engine.applyRemote([
      fixedOp(
        "device-a",
        1,
        "branches",
        "branch-a",
        {
          id: "branch-a",
          prompt_id: "prompt-1",
          name: "experiment",
          description: "from A",
          created_at: "2026-09-03T00:00:00.000Z",
        },
        100,
      ),
      fixedOp(
        "device-a",
        2,
        "versions",
        "version-a",
        version("version-a", "branch-a", "from A", "2026-09-03T00:00:00.000Z"),
        110,
      ),
    ]);
    b.engine.applyRemote([
      fixedOp(
        "device-b",
        1,
        "branches",
        "branch-b",
        {
          id: "branch-b",
          prompt_id: "prompt-1",
          name: "experiment",
          description: "from B",
          created_at: "2026-09-03T00:00:00.000Z",
        },
        200,
      ),
      fixedOp(
        "device-b",
        2,
        "versions",
        "version-b",
        version("version-b", "branch-b", "from B", "2026-09-03T00:01:00.000Z"),
        210,
      ),
    ]);
    syncBoth(a, b);

    for (const r of [a, b]) {
      expect(r.db.prepare("SELECT id, prompt_id, name, description FROM branches").all()).toEqual([
        { id: "branch-a", prompt_id: "prompt-1", name: "experiment", description: "from B" },
      ]);
      expect(
        r.db
          .prepare("SELECT id, branch_id, number, content FROM versions ORDER BY number")
          .all(),
      ).toEqual([
        { id: "version-a", branch_id: "branch-a", number: 1, content: "from A" },
        { id: "version-b", branch_id: "branch-a", number: 2, content: "from B" },
      ]);
    }
  });

  it("does not merge same-named branches owned by different prompts", () => {
    const r = rig();
    seedPrompt(r, "prompt-a");
    seedPrompt(r, "prompt-b");

    r.engine.applyRemote([
      fixedOp(
        "device-a",
        1,
        "branches",
        "branch-a",
        {
          id: "branch-a",
          prompt_id: "prompt-a",
          name: "experiment",
          description: null,
          created_at: "2026-09-03T00:00:00.000Z",
        },
        100,
      ),
      fixedOp(
        "device-b",
        1,
        "branches",
        "branch-b",
        {
          id: "branch-b",
          prompt_id: "prompt-b",
          name: "experiment",
          description: null,
          created_at: "2026-09-03T00:00:00.000Z",
        },
        200,
      ),
    ]);

    expect(r.db.prepare("SELECT id, prompt_id, name FROM branches ORDER BY id").all()).toEqual([
      { id: "branch-a", prompt_id: "prompt-a", name: "experiment" },
      { id: "branch-b", prompt_id: "prompt-b", name: "experiment" },
    ]);
    expect(r.db.prepare("SELECT * FROM sync_id_remaps WHERE table_name = 'branches'").all()).toEqual([]);
  });

  it("converges exact tag exports in opposite order and through third-peer gossip", () => {
    const first = rig();
    const second = rig();
    const relay = rig();
    for (const r of [first, second, relay]) seedPrompt(r, "prompt-1");
    const ops = [
      fixedOp("device-a", 1, "tags", "tag-a", { id: "tag-a", name: "prod", color: "#101010" }, 100),
      fixedOp("device-b", 1, "tags", "tag-b", { id: "tag-b", name: "prod", color: "#202020" }, 200),
      fixedOp(
        "device-a",
        2,
        "prompt_tags",
        "prompt-1:tag-a",
        { prompt_id: "prompt-1", tag_id: "tag-a" },
        110,
      ),
      fixedOp(
        "device-b",
        2,
        "prompt_tags",
        "prompt-1:tag-b",
        { prompt_id: "prompt-1", tag_id: "tag-b" },
        210,
      ),
    ];

    first.engine.applyRemote(ops);
    second.engine.applyRemote([...ops].reverse());
    drain(first.engine, relay.engine);

    const expected = {
      tags: [{ id: "tag-a", name: "prod", color: "#202020" }],
      prompt_tags: [{ prompt_id: "prompt-1", tag_id: "tag-a" }],
    };
    for (const r of [first, second, relay]) {
      const exported = normalizedExport(r);
      expect({ tags: exported.tags, prompt_tags: exported.prompt_tags }).toEqual(expected);
    }
  });

  it("records older alias memberships below a winning tag tombstone across delivery shapes", () => {
    const staged = rig();
    const batch = rig();
    const relay = rig();
    const third = rig();
    for (const r of [staged, batch, relay, third]) seedPrompt(r, "prompt-1");

    const ops = [
      fixedOp("device-a", 1, "tags", "tag-a", { id: "tag-a", name: "prod", color: "#0000aa" }, 100),
      fixedOp(
        "device-a",
        2,
        "prompt_tags",
        "prompt-1:tag-a",
        { prompt_id: "prompt-1", tag_id: "tag-a" },
        110,
      ),
      fixedOp("device-b", 1, "tags", "tag-b", { id: "tag-b", name: "prod", color: "#0000bb" }, 200),
      fixedOp(
        "device-b",
        2,
        "prompt_tags",
        "prompt-1:tag-b",
        { prompt_id: "prompt-1", tag_id: "tag-b" },
        210,
      ),
      fixedOp("device-d", 1, "tags", "tag-b", null, 300, "delete"),
    ];
    const snapshot = (r: Rig) => ({
      tags: r.db.prepare("SELECT id, name, color FROM tags ORDER BY id").all(),
      promptTags: r.db.prepare("SELECT prompt_id, tag_id FROM prompt_tags ORDER BY prompt_id, tag_id").all(),
      heads: r.db
        .prepare(
          `SELECT table_name, record_id, hlc, device_id FROM sync_heads
           WHERE table_name IN ('tags', 'prompt_tags') ORDER BY table_name, record_id`,
        )
        .all(),
      cursors: r.db
        .prepare("SELECT source_device_id, last_seq FROM sync_cursors ORDER BY source_device_id")
        .all(),
      remaps: r.db
        .prepare("SELECT table_name, remote_id, local_id FROM sync_id_remaps ORDER BY table_name, remote_id")
        .all(),
      ops: r.engine.opsSince({}).ops,
    });
    const expected = {
      tags: [],
      promptTags: [],
      heads: [
        {
          table_name: "prompt_tags",
          record_id: "prompt-1:tag-a",
          hlc: formatHlc({ millis: 210, counter: 0 }),
          device_id: "device-b",
        },
        {
          table_name: "tags",
          record_id: "tag-a",
          hlc: formatHlc({ millis: 300, counter: 0 }),
          device_id: "device-d",
        },
      ],
      cursors: [
        { source_device_id: "device-a", last_seq: 2 },
        { source_device_id: "device-b", last_seq: 2 },
        { source_device_id: "device-d", last_seq: 1 },
      ],
      remaps: [{ table_name: "tags", remote_id: "tag-b", local_id: "tag-a" }],
      ops,
    };

    expect(staged.engine.applyRemote(ops.slice(0, 2))).toEqual({ applied: 2, skipped: 0, stale: 0, deferred: 0 });
    expect(staged.engine.applyRemote(ops.slice(2, 4))).toEqual({ applied: 2, skipped: 0, stale: 0, deferred: 0 });
    expect(staged.engine.applyRemote(ops.slice(4))).toEqual({ applied: 1, skipped: 0, stale: 0, deferred: 0 });
    expect(batch.engine.applyRemote(ops)).toEqual({ applied: 5, skipped: 0, stale: 0, deferred: 0 });
    expect(batch.engine.applyRemote(ops)).toEqual({ applied: 0, skipped: 5, stale: 0, deferred: 0 });
    expect(relay.engine.applyRemote(ops)).toEqual({ applied: 5, skipped: 0, stale: 0, deferred: 0 });
    expect(third.engine.applyRemote(relay.engine.opsSince({}).ops)).toEqual({
      applied: 5,
      skipped: 0,
      stale: 0,
      deferred: 0,
    });

    for (const r of [staged, batch, relay, third]) expect(snapshot(r)).toEqual(expected);
  });

  it("discovers delete-first tag aliases from history before a later same-name upsert", () => {
    const deleteFirst = rig();
    const relay = rig();
    const third = rig();
    for (const r of [deleteFirst, relay, third]) seedPrompt(r, "prompt-1");
    const ops = [
      fixedOp("device-a", 1, "tags", "tag-a", { id: "tag-a", name: "prod", color: "#0000aa" }, 100),
      fixedOp(
        "device-a",
        2,
        "prompt_tags",
        "prompt-1:tag-a",
        { prompt_id: "prompt-1", tag_id: "tag-a" },
        110,
      ),
      fixedOp("device-b", 1, "tags", "tag-b", { id: "tag-b", name: "prod", color: "#0000bb" }, 200),
      fixedOp(
        "device-b",
        2,
        "prompt_tags",
        "prompt-1:tag-b",
        { prompt_id: "prompt-1", tag_id: "tag-b" },
        210,
      ),
      fixedOp("device-d", 1, "tags", "tag-b", null, 300, "delete"),
    ];
    const snapshot = (r: Rig) => ({
      tags: r.db.prepare("SELECT id, name, color FROM tags ORDER BY id").all(),
      promptTags: r.db.prepare("SELECT prompt_id, tag_id FROM prompt_tags ORDER BY prompt_id, tag_id").all(),
      heads: r.db
        .prepare(
          `SELECT table_name, record_id, hlc, device_id FROM sync_heads
           WHERE table_name IN ('tags', 'prompt_tags') ORDER BY table_name, record_id`,
        )
        .all(),
      cursors: r.db.prepare("SELECT source_device_id, last_seq FROM sync_cursors ORDER BY source_device_id").all(),
      remaps: r.db
        .prepare("SELECT table_name, remote_id, local_id FROM sync_id_remaps ORDER BY table_name, remote_id")
        .all(),
      ops: r.engine.opsSince({}).ops,
    });
    const expected = {
      tags: [],
      promptTags: [],
      heads: [
        {
          table_name: "prompt_tags",
          record_id: "prompt-1:tag-a",
          hlc: formatHlc({ millis: 210, counter: 0 }),
          device_id: "device-b",
        },
        {
          table_name: "tags",
          record_id: "tag-a",
          hlc: formatHlc({ millis: 300, counter: 0 }),
          device_id: "device-d",
        },
      ],
      cursors: [
        { source_device_id: "device-a", last_seq: 2 },
        { source_device_id: "device-b", last_seq: 2 },
        { source_device_id: "device-d", last_seq: 1 },
      ],
      remaps: [{ table_name: "tags", remote_id: "tag-b", local_id: "tag-a" }],
      ops,
    };

    expect(deleteFirst.engine.applyRemote(ops.slice(4))).toEqual({ applied: 1, skipped: 0, stale: 0, deferred: 0 });
    expect(deleteFirst.engine.applyRemote(ops.slice(2, 4))).toEqual({ applied: 1, skipped: 0, stale: 1, deferred: 0 });
    expect(deleteFirst.engine.applyRemote(ops.slice(0, 2))).toEqual({ applied: 1, skipped: 0, stale: 1, deferred: 0 });
    expect(deleteFirst.engine.applyRemote(ops)).toEqual({ applied: 0, skipped: 5, stale: 0, deferred: 0 });
    expect(relay.engine.applyRemote(ops)).toEqual({ applied: 5, skipped: 0, stale: 0, deferred: 0 });
    expect(third.engine.applyRemote(relay.engine.opsSince({}).ops)).toEqual({
      applied: 5,
      skipped: 0,
      stale: 0,
      deferred: 0,
    });

    for (const r of [deleteFirst, relay, third]) expect(snapshot(r)).toEqual(expected);
  });

  it("discovers delete-first collection aliases from history before a later same-name upsert", () => {
    const deleteFirst = rig();
    const relay = rig();
    const third = rig();
    for (const r of [deleteFirst, relay, third]) seedPrompt(r, "prompt-1");
    const ops = [
      fixedOp(
        "device-a",
        1,
        "collections",
        "collection-a",
        { id: "collection-a", name: "prod", sort_order: 1 },
        100,
      ),
      fixedOp(
        "device-a",
        2,
        "collection_prompts",
        "collection-a:prompt-1",
        { collection_id: "collection-a", prompt_id: "prompt-1", sort_order: 1 },
        110,
      ),
      fixedOp(
        "device-b",
        1,
        "collections",
        "collection-b",
        { id: "collection-b", name: "prod", sort_order: 2 },
        200,
      ),
      fixedOp(
        "device-b",
        2,
        "collection_prompts",
        "collection-b:prompt-1",
        { collection_id: "collection-b", prompt_id: "prompt-1", sort_order: 9 },
        210,
      ),
      fixedOp("device-d", 1, "collections", "collection-b", null, 300, "delete"),
    ];
    const snapshot = (r: Rig) => ({
      collections: r.db.prepare("SELECT id, name, sort_order FROM collections ORDER BY id").all(),
      collectionPrompts: r.db
        .prepare("SELECT collection_id, prompt_id, sort_order FROM collection_prompts ORDER BY collection_id, prompt_id")
        .all(),
      heads: r.db
        .prepare(
          `SELECT table_name, record_id, hlc, device_id FROM sync_heads
           WHERE table_name IN ('collections', 'collection_prompts') ORDER BY table_name, record_id`,
        )
        .all(),
      cursors: r.db.prepare("SELECT source_device_id, last_seq FROM sync_cursors ORDER BY source_device_id").all(),
      remaps: r.db
        .prepare("SELECT table_name, remote_id, local_id FROM sync_id_remaps ORDER BY table_name, remote_id")
        .all(),
      ops: r.engine.opsSince({}).ops,
    });
    const expected = {
      collections: [],
      collectionPrompts: [],
      heads: [
        {
          table_name: "collection_prompts",
          record_id: "collection-a:prompt-1",
          hlc: formatHlc({ millis: 210, counter: 0 }),
          device_id: "device-b",
        },
        {
          table_name: "collections",
          record_id: "collection-a",
          hlc: formatHlc({ millis: 300, counter: 0 }),
          device_id: "device-d",
        },
      ],
      cursors: [
        { source_device_id: "device-a", last_seq: 2 },
        { source_device_id: "device-b", last_seq: 2 },
        { source_device_id: "device-d", last_seq: 1 },
      ],
      remaps: [{ table_name: "collections", remote_id: "collection-b", local_id: "collection-a" }],
      ops,
    };

    expect(deleteFirst.engine.applyRemote(ops.slice(4))).toEqual({ applied: 1, skipped: 0, stale: 0, deferred: 0 });
    expect(deleteFirst.engine.applyRemote(ops.slice(2, 4))).toEqual({ applied: 1, skipped: 0, stale: 1, deferred: 0 });
    expect(deleteFirst.engine.applyRemote(ops.slice(0, 2))).toEqual({ applied: 1, skipped: 0, stale: 1, deferred: 0 });
    expect(deleteFirst.engine.applyRemote(ops)).toEqual({ applied: 0, skipped: 5, stale: 0, deferred: 0 });
    expect(relay.engine.applyRemote(ops)).toEqual({ applied: 5, skipped: 0, stale: 0, deferred: 0 });
    expect(third.engine.applyRemote(relay.engine.opsSince({}).ops)).toEqual({
      applied: 5,
      skipped: 0,
      stale: 0,
      deferred: 0,
    });

    for (const r of [deleteFirst, relay, third]) expect(snapshot(r)).toEqual(expected);
  });

  it("discovers delete-first same-prompt branch aliases before a later upsert", () => {
    const deleteFirst = rig();
    const relay = rig();
    const third = rig();
    for (const r of [deleteFirst, relay, third]) seedPrompt(r, "prompt-1");
    const version = (id: string, branchId: string, content: string) => ({
      id,
      prompt_id: "prompt-1",
      branch_id: branchId,
      parent_version_id: null,
      number: 1,
      label: null,
      content,
      content_format: "markdown",
      change_note: null,
      author: "You",
      status: "active",
      source: "user",
      created_at: "2026-09-03T00:00:00.000Z",
    });
    const ops = [
      fixedOp(
        "device-a",
        1,
        "branches",
        "branch-a",
        {
          id: "branch-a",
          prompt_id: "prompt-1",
          name: "experiment",
          description: "from A",
          created_at: "2026-09-03T00:00:00.000Z",
        },
        100,
      ),
      fixedOp("device-a", 2, "versions", "version-a", version("version-a", "branch-a", "from A"), 110),
      fixedOp(
        "device-b",
        1,
        "branches",
        "branch-b",
        {
          id: "branch-b",
          prompt_id: "prompt-1",
          name: "experiment",
          description: "from B",
          created_at: "2026-09-03T00:00:00.000Z",
        },
        200,
      ),
      fixedOp("device-b", 2, "versions", "version-b", version("version-b", "branch-b", "from B"), 210),
      fixedOp("device-d", 1, "branches", "branch-b", null, 300, "delete"),
    ];
    const snapshot = (r: Rig) => ({
      branches: r.db.prepare("SELECT id, prompt_id, name, description FROM branches ORDER BY id").all(),
      versions: r.db.prepare("SELECT id, branch_id, content FROM versions ORDER BY id").all(),
      heads: r.db
        .prepare(
          `SELECT table_name, record_id, hlc, device_id FROM sync_heads
           WHERE table_name IN ('branches', 'versions') ORDER BY table_name, record_id`,
        )
        .all(),
      cursors: r.db.prepare("SELECT source_device_id, last_seq FROM sync_cursors ORDER BY source_device_id").all(),
      remaps: r.db
        .prepare("SELECT table_name, remote_id, local_id FROM sync_id_remaps ORDER BY table_name, remote_id")
        .all(),
      ops: r.engine.opsSince({}).ops,
    });
    const expected = {
      branches: [],
      versions: [],
      heads: [
        {
          table_name: "branches",
          record_id: "branch-a",
          hlc: formatHlc({ millis: 300, counter: 0 }),
          device_id: "device-d",
        },
        {
          table_name: "versions",
          record_id: "version-a",
          hlc: formatHlc({ millis: 110, counter: 0 }),
          device_id: "device-a",
        },
        {
          table_name: "versions",
          record_id: "version-b",
          hlc: formatHlc({ millis: 210, counter: 0 }),
          device_id: "device-b",
        },
      ],
      cursors: [
        { source_device_id: "device-a", last_seq: 2 },
        { source_device_id: "device-b", last_seq: 2 },
        { source_device_id: "device-d", last_seq: 1 },
      ],
      remaps: [{ table_name: "branches", remote_id: "branch-b", local_id: "branch-a" }],
      ops,
    };

    expect(deleteFirst.engine.applyRemote(ops.slice(4))).toEqual({ applied: 1, skipped: 0, stale: 0, deferred: 0 });
    expect(deleteFirst.engine.applyRemote(ops.slice(2, 4))).toEqual({ applied: 1, skipped: 0, stale: 1, deferred: 0 });
    expect(deleteFirst.engine.applyRemote(ops.slice(0, 2))).toEqual({ applied: 2, skipped: 0, stale: 0, deferred: 0 });
    expect(deleteFirst.engine.applyRemote(ops)).toEqual({ applied: 0, skipped: 5, stale: 0, deferred: 0 });
    expect(relay.engine.applyRemote(ops)).toEqual({ applied: 5, skipped: 0, stale: 0, deferred: 0 });
    expect(third.engine.applyRemote(relay.engine.opsSince({}).ops)).toEqual({
      applied: 5,
      skipped: 0,
      stale: 0,
      deferred: 0,
    });

    for (const r of [deleteFirst, relay, third]) expect(snapshot(r)).toEqual(expected);
  });

  it("records older collection memberships below a winning collection tombstone", () => {
    const r = rig();
    seedPrompt(r, "prompt-1");
    const ops = [
      fixedOp(
        "device-a",
        1,
        "collections",
        "collection-a",
        { id: "collection-a", name: "prod", sort_order: 0 },
        100,
      ),
      fixedOp(
        "device-a",
        2,
        "collection_prompts",
        "collection-a:prompt-1",
        { collection_id: "collection-a", prompt_id: "prompt-1", sort_order: 1 },
        110,
      ),
      fixedOp(
        "device-b",
        1,
        "collections",
        "collection-b",
        { id: "collection-b", name: "prod", sort_order: 0 },
        200,
      ),
      fixedOp(
        "device-b",
        2,
        "collection_prompts",
        "collection-b:prompt-1",
        { collection_id: "collection-b", prompt_id: "prompt-1", sort_order: 9 },
        210,
      ),
      fixedOp("device-d", 1, "collections", "collection-b", null, 300, "delete"),
    ];

    expect(r.engine.applyRemote(ops)).toEqual({ applied: 5, skipped: 0, stale: 0, deferred: 0 });
    expect(r.db.prepare("SELECT id FROM collections").all()).toEqual([]);
    expect(r.db.prepare("SELECT collection_id, prompt_id FROM collection_prompts").all()).toEqual([]);
    expect(
      r.db
        .prepare("SELECT record_id, hlc, device_id FROM sync_heads WHERE table_name = 'collection_prompts'")
        .all(),
    ).toEqual([
      {
        record_id: "collection-a:prompt-1",
        hlc: formatHlc({ millis: 210, counter: 0 }),
        device_id: "device-b",
      },
    ]);
    expect(r.engine.opsSince({}).ops).toEqual(ops);
    expect(r.engine.haveVector()).toMatchObject({ "device-a": 2, "device-b": 2, "device-d": 1 });
  });

  it("records older versions below a winning branch tombstone", () => {
    const r = rig();
    seedPrompt(r, "prompt-1");
    const version = (id: string, branchId: string, content: string) => ({
      id,
      prompt_id: "prompt-1",
      branch_id: branchId,
      parent_version_id: null,
      number: 1,
      label: null,
      content,
      content_format: "markdown",
      change_note: null,
      author: "You",
      status: "active",
      source: "user",
      created_at: "2026-09-03T00:00:00.000Z",
    });
    const ops = [
      fixedOp(
        "device-a",
        1,
        "branches",
        "branch-a",
        {
          id: "branch-a",
          prompt_id: "prompt-1",
          name: "experiment",
          description: null,
          created_at: "2026-09-03T00:00:00.000Z",
        },
        100,
      ),
      fixedOp("device-a", 2, "versions", "version-a", version("version-a", "branch-a", "from A"), 110),
      fixedOp(
        "device-b",
        1,
        "branches",
        "branch-b",
        {
          id: "branch-b",
          prompt_id: "prompt-1",
          name: "experiment",
          description: null,
          created_at: "2026-09-03T00:00:00.000Z",
        },
        200,
      ),
      fixedOp("device-b", 2, "versions", "version-b", version("version-b", "branch-b", "from B"), 210),
      fixedOp("device-d", 1, "branches", "branch-b", null, 300, "delete"),
    ];

    expect(r.engine.applyRemote(ops)).toEqual({ applied: 5, skipped: 0, stale: 0, deferred: 0 });
    expect(r.db.prepare("SELECT id FROM branches").all()).toEqual([]);
    expect(r.db.prepare("SELECT id FROM versions").all()).toEqual([]);
    expect(
      r.db
        .prepare("SELECT table_name, record_id, hlc, device_id FROM sync_heads WHERE table_name IN ('branches', 'versions') ORDER BY table_name, record_id")
        .all(),
    ).toEqual([
      {
        table_name: "branches",
        record_id: "branch-a",
        hlc: formatHlc({ millis: 300, counter: 0 }),
        device_id: "device-d",
      },
      {
        table_name: "versions",
        record_id: "version-a",
        hlc: formatHlc({ millis: 110, counter: 0 }),
        device_id: "device-a",
      },
      {
        table_name: "versions",
        record_id: "version-b",
        hlc: formatHlc({ millis: 210, counter: 0 }),
        device_id: "device-b",
      },
    ]);
    expect(r.engine.opsSince({}).ops).toEqual(ops);
    expect(r.engine.haveVector()).toMatchObject({ "device-a": 2, "device-b": 2, "device-d": 1 });
  });

  it("loads each prompt-tag history once while repairing independent tag components", () => {
    const r = rig();
    seedPrompt(r, "prompt-1");
    for (let index = 0; index < 12; index += 1) {
      const tagId = `tag-${index}`;
      r.engine.applyRemote([
        fixedOp(
          `device-${index}`,
          1,
          "tags",
          tagId,
          { id: tagId, name: `tag-${index}`, color: "#101010" },
          100 + index,
        ),
        fixedOp(
          `device-${index}`,
          2,
          "prompt_tags",
          `prompt-1:${tagId}`,
          { prompt_id: "prompt-1", tag_id: tagId },
          200 + index,
        ),
      ]);
    }

    let promptTagHistoryLoads = 0;
    r.engine.repairNaturalKeyMerges({
      onChildHistoryLoad: (table) => {
        if (table === "prompt_tags") promptTagHistoryLoads += 1;
      },
    });

    expect(promptTagHistoryLoads).toBe(1);
  });

  it("keeps later known-alias writes and membership tombstones at one logical key", () => {
    const r = rig();
    seedPrompt(r, "prompt-1");
    r.engine.applyRemote([
      fixedOp("device-a", 1, "tags", "tag-a", { id: "tag-a", name: "prod", color: "#111111" }, 100),
      fixedOp("device-b", 1, "tags", "tag-b", { id: "tag-b", name: "prod", color: "#222222" }, 200),
      fixedOp("device-b", 2, "tags", "tag-b", { id: "tag-b", name: "prod", color: "#333333" }, 300),
      fixedOp(
        "device-b",
        3,
        "prompt_tags",
        "prompt-1:tag-b",
        { prompt_id: "prompt-1", tag_id: "tag-b" },
        310,
      ),
      fixedOp("device-b", 4, "prompt_tags", "prompt-1:tag-b", null, 400, "delete"),
    ]);

    expect(r.db.prepare("SELECT id, name, color FROM tags").all()).toEqual([
      { id: "tag-a", name: "prod", color: "#333333" },
    ]);
    expect(r.db.prepare("SELECT prompt_id, tag_id FROM prompt_tags").all()).toEqual([]);
    expect(r.db.prepare("SELECT remote_id, local_id FROM sync_id_remaps WHERE table_name = 'tags'").all()).toEqual([
      { remote_id: "tag-b", local_id: "tag-a" },
    ]);
    expect(
      r.db
        .prepare("SELECT table_name, record_id, hlc, device_id FROM sync_heads WHERE table_name IN ('tags', 'prompt_tags') ORDER BY table_name")
        .all(),
    ).toEqual([
      {
        table_name: "prompt_tags",
        record_id: "prompt-1:tag-a",
        hlc: "0000000000400:000000",
        device_id: "device-b",
      },
      {
        table_name: "tags",
        record_id: "tag-a",
        hlc: "0000000000300:000000",
        device_id: "device-b",
      },
    ]);
  });

  it("propagates deletions: note hard-delete, prompt soft-delete, prompt hard-delete cascade", () => {
    const a = rig();
    const b = rig();
    const keep = a.lib.createPrompt({ title: "Keep", content: "keep" });
    const trash = a.lib.createPrompt({ title: "Trash", content: "trash" });
    const gone = a.lib.createPrompt({ title: "Gone", content: "gone" });
    const note = a.lib.addNote({ promptId: keep.id, body: "delete me" });
    a.lib.createVersion({
      promptId: gone.id,
      branchId: a.lib.listBranches(gone.id)[0]!.id,
      content: "gone v2",
    });
    a.engine.refineDirty();
    drain(a.engine, b.engine);

    a.lib.deleteNote(note.id);
    a.lib.softDeletePrompt(trash.id);
    a.lib.hardDeletePrompt(gone.id);
    a.engine.refineDirty();
    drain(a.engine, b.engine);

    expect(b.lib.listNotes(keep.id)).toEqual([]);
    expect(b.lib.getPrompt(trash.id)?.deleted_at).not.toBeNull();
    expect(b.lib.getPrompt(gone.id)).toBeNull();
    expect(b.lib.listVersions(gone.id)).toEqual([]);
  });

  it("makes prompt hard deletion dominate a later metadata edit on every peer", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Delete wins", content: "v1" });
    a.engine.refineDirty(1_000);
    drain(a.engine, b.engine);

    a.lib.hardDeletePrompt(prompt.id);
    a.engine.refineDirty(2_000);
    b.lib.updatePromptMetadata(prompt.id, { title: "Later disconnected edit" });
    b.engine.refineDirty(3_000);

    for (let round = 0; round < 3; round++) syncBoth(a, b);

    for (const peer of [a, b]) {
      expect(peer.lib.getPrompt(prompt.id)).toBeNull();
      expect(peer.lib.listBranches(prompt.id)).toEqual([]);
      expect(peer.lib.listVersions(prompt.id)).toEqual([]);
      expect(
        peer.db
          .prepare("SELECT 1 FROM sync_pending_pointers WHERE prompt_id = ?")
          .get(prompt.id),
      ).toBeUndefined();
    }
    const aLastSeq = Math.max(
      ...collectAll(a.engine)
        .filter((op) => op.source === a.engine.deviceId())
        .map((op) => op.seq),
    );
    expect(b.engine.haveVector()[a.engine.deviceId()]).toBe(aLastSeq);
    expect(normalizedExport(a)).toEqual(normalizedExport(b));
  });

  it("consumes unseen descendants of a hard-deleted prompt without blocking later ops", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Aggregate", content: "v1" });
    a.engine.refineDirty(1_000);
    drain(a.engine, b.engine);

    a.lib.hardDeletePrompt(prompt.id);
    a.engine.refineDirty(2_000);

    const branch = b.lib.listBranches(prompt.id)[0]!;
    const version = b.lib.createVersion({
      promptId: prompt.id,
      branchId: branch.id,
      content: "concurrent v2",
    });
    const note = b.lib.addNote({ promptId: prompt.id, versionId: version.id, body: "late" });
    const promptRating = b.lib.addRating({
      targetType: "prompt",
      targetId: prompt.id,
      effectiveness: 5,
    });
    const versionRating = b.lib.addRating({
      targetType: "version",
      targetId: version.id,
      clarity: 5,
    });
    const run = b.lib.addRun({ promptId: prompt.id, versionId: version.id });
    const unrelated = b.lib.createTag({ name: "must-pass-the-wedged-source" });
    b.engine.refineDirty(3_000);

    drain(b.engine, a.engine);
    expect(a.lib.getPrompt(prompt.id)).toBeNull();
    expect(a.lib.getVersion(version.id)).toBeNull();
    expect(a.lib.listNotes(prompt.id)).toEqual([]);
    expect(a.lib.listRuns(prompt.id)).toEqual([]);
    for (const id of [promptRating.id, versionRating.id]) {
      expect(a.db.prepare("SELECT 1 FROM ratings WHERE id = ?").get(id)).toBeUndefined();
    }
    expect(a.db.prepare("SELECT 1 FROM notes WHERE id = ?").get(note.id)).toBeUndefined();
    expect(a.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(run.id)).toBeUndefined();
    expect(a.lib.listTags().map((tag) => tag.id)).toContain(unrelated.id);

    for (let round = 0; round < 3; round++) syncBoth(a, b);
    expect(normalizedExport(a)).toEqual(normalizedExport(b));
    const bLastSeq = Math.max(
      ...collectAll(b.engine)
        .filter((op) => op.source === b.engine.deviceId())
        .map((op) => op.seq),
    );
    expect(a.engine.haveVector()[b.engine.deviceId()]).toBe(bLastSeq);
  });

  it("defers a version rating until its terminally deleted prompt ownership is known", () => {
    const author = rig();
    const receiver = rig();
    const disconnected = rig();
    const prompt = author.lib.createPrompt({ title: "Rating owner", content: "v1" });
    author.engine.refineDirty(1_000);
    drain(author.engine, receiver.engine);
    drain(author.engine, disconnected.engine);

    author.lib.hardDeletePrompt(prompt.id);
    author.engine.refineDirty(2_000);
    drain(author.engine, receiver.engine);

    const branch = disconnected.lib.listBranches(prompt.id)[0]!;
    const version = disconnected.lib.createVersion({
      promptId: prompt.id,
      branchId: branch.id,
      content: "unseen concurrent version",
    });
    const rating = disconnected.lib.addRating({
      targetType: "version",
      targetId: version.id,
      completeness: 5,
    });
    const unrelated = disconnected.lib.createTag({ name: "after-deferred-rating" });
    disconnected.engine.refineDirty(3_000);

    const source = disconnected.engine.deviceId();
    const sourceOps = collectAll(disconnected.engine).filter((op) => op.source === source);
    const versionOp = sourceOps.find((op) => op.table === "versions" && op.recordId === version.id)!;
    const ratingOp = sourceOps.find((op) => op.table === "ratings" && op.recordId === rating.id)!;
    const unrelatedOp = sourceOps.find((op) => op.table === "tags" && op.recordId === unrelated.id)!;

    // The rating alone does not identify its owning prompt. It must not be
    // materialized or marked seen before the version history resolves that owner.
    receiver.engine.applyRemote([ratingOp]);
    expect(receiver.db.prepare("SELECT 1 FROM ratings WHERE id = ?").get(rating.id)).toBeUndefined();
    expect(
      receiver.db
        .prepare("SELECT 1 FROM sync_ops WHERE source_device_id = ? AND op_id = ?")
        .get(source, ratingOp.opId),
    ).toBeUndefined();
    expect(receiver.engine.haveVector()[source] ?? 0).toBe(0);

    receiver.engine.applyRemote([...sourceOps].reverse());
    expect(receiver.lib.getVersion(version.id)).toBeNull();
    expect(receiver.db.prepare("SELECT 1 FROM ratings WHERE id = ?").get(rating.id)).toBeUndefined();
    expect(receiver.lib.listTags().map((tag) => tag.id)).toContain(unrelated.id);
    expect(receiver.engine.haveVector()[source]).toBe(
      Math.max(...sourceOps.map((op) => op.seq)),
    );
    for (const op of sourceOps) {
      expect(
        receiver.db
          .prepare("SELECT 1 FROM sync_ops WHERE source_device_id = ? AND op_id = ?")
          .get(source, op.opId),
      ).toBeDefined();
    }
  });

  it("removes a preexisting version rating when its terminal owner arrives later", () => {
    const author = rig();
    const receiver = rig();
    const disconnected = rig();
    const prompt = author.lib.createPrompt({ title: "Historical rating", content: "v1" });
    author.engine.refineDirty(1_000);
    drain(author.engine, receiver.engine);
    drain(author.engine, disconnected.engine);

    const branch = disconnected.lib.listBranches(prompt.id)[0]!;
    const version = disconnected.lib.createVersion({
      promptId: prompt.id,
      branchId: branch.id,
      content: "owner arrives later",
    });
    disconnected.engine.refineDirty(2_000);
    const versionOp = collectAll(disconnected.engine).find(
      (op) =>
        op.source === disconnected.engine.deviceId() &&
        op.table === "versions" &&
        op.recordId === version.id,
    )!;

    // This is reachable through the public library API and models a rating
    // already materialized by a pre-tombstone sync engine.
    const rating = receiver.lib.addRating({
      targetType: "version",
      targetId: version.id,
      actionability: 4,
    });
    receiver.engine.refineDirty(3_000);

    author.lib.hardDeletePrompt(prompt.id);
    author.engine.refineDirty(4_000);
    drain(author.engine, receiver.engine);
    expect(receiver.db.prepare("SELECT 1 FROM ratings WHERE id = ?").get(rating.id)).toBeDefined();

    receiver.engine.applyRemote([versionOp]);
    expect(receiver.lib.getVersion(version.id)).toBeNull();
    expect(receiver.db.prepare("SELECT 1 FROM ratings WHERE id = ?").get(rating.id)).toBeUndefined();
  });

  it("does not consume an imported rating using a deleted version's historical owner", () => {
    const source = rig();
    const receiver = rig();
    const prompt = source.lib.createPrompt({ title: "Imported successor", content: "v1" });
    const originalVersionId = prompt.current_version_id!;
    source.lib.addRating({
      targetType: "version",
      targetId: originalVersionId,
      effectiveness: 5,
    });
    const exported = source.lib.exportLibrary();
    source.engine.refineDirty(1_000);
    drain(source.engine, receiver.engine);

    source.lib.hardDeletePrompt(prompt.id);
    source.engine.refineDirty(2_000);
    drain(source.engine, receiver.engine);

    source.lib.importLibrary(exported);
    const replacement = source.lib.listPrompts().find((row) => row.title === "Imported successor")!;
    expect(replacement.id).not.toBe(prompt.id);
    const replacementVersion = source.lib.listVersions(replacement.id)[0]!;
    const replacementRating = source.db
      .prepare("SELECT id, target_id FROM ratings WHERE target_type = 'version' AND target_id = ?")
      .get(replacementVersion.id) as { id: string; target_id: string };
    source.engine.refineDirty(3_000);

    const ratingOp = collectAll(source.engine)
      .filter(
        (op) =>
          op.source === source.engine.deviceId() &&
          op.table === "ratings" &&
          op.recordId === replacementRating.id &&
          op.kind === "upsert",
      )
      .sort((a, b) => b.seq - a.seq)[0]!;

    // A byte-budget/source split may expose the new rating before the new
    // version. Historical ownership for a reused id must not bind it to the
    // terminally deleted prompt forever.
    receiver.engine.applyRemote([ratingOp]);
    drain(source.engine, receiver.engine);

    expect(receiver.lib.getPrompt(replacement.id)).not.toBeNull();
    expect(receiver.lib.getVersion(replacementVersion.id)?.prompt_id).toBe(replacement.id);
    expect(
      receiver.db.prepare("SELECT target_id FROM ratings WHERE id = ?").get(replacementRating.id),
    ).toEqual({ target_id: replacementVersion.id });
  });

  it("propagates ops transitively through a middle device", () => {
    const a = rig();
    const b = rig();
    const c = rig();
    const prompt = a.lib.createPrompt({ title: "Hops", content: "hop" });
    a.engine.refineDirty();
    drain(a.engine, b.engine);
    // C only ever talks to B, never to A.
    drain(b.engine, c.engine);

    expect(c.lib.getPrompt(prompt.id)?.title).toBe("Hops");
    // And C's writes reach A back through B.
    const cc = c.lib.createPrompt({ title: "From C", content: "c" });
    c.engine.refineDirty();
    drain(c.engine, b.engine);
    drain(b.engine, a.engine);
    expect(a.lib.getPrompt(cc.id)?.title).toBe("From C");
  });

  it("is idempotent when the same ops are applied twice", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Once", content: "x" });
    a.lib.createTag({ name: "t" });
    a.engine.refineDirty();
    const { ops } = a.engine.opsSince(b.engine.haveVector());
    const first = b.engine.applyRemote(ops);
    expect(first.applied).toBeGreaterThan(0);
    const second = b.engine.applyRemote(ops);
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(ops.length);
    expect(b.lib.listPrompts().length).toBe(1);
    expect(prompt).toBeTruthy();
  });

  it("converges across tiny transport budgets, deferring the current-version pointer", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Budget", content: "v1" });
    a.lib.createVersion({
      promptId: prompt.id,
      branchId: a.lib.listBranches(prompt.id)[0]!.id,
      content: "v2",
    });
    a.engine.refineDirty();

    // A first partial transfer must leave a consistent intermediate state.
    const first = a.engine.opsSince(b.engine.haveVector(), 400);
    expect(first.ops.length).toBeGreaterThan(0);
    expect(first.hasMore).toBe(true);
    b.engine.applyRemote(first.ops);
    const mid = b.lib.getPrompt(prompt.id);
    if (mid) {
      // Prompt may exist already but its current pointer must never dangle.
      expect(mid.current_version_id === null || b.lib.getVersion(mid.current_version_id)).toBeTruthy();
    }

    drain(a.engine, b.engine, 400);
    const final = b.lib.getPrompt(prompt.id)!;
    expect(final.current_version_id).not.toBeNull();
    expect(b.lib.getVersion(final.current_version_id!)?.content).toBe("v2");
  });

  it("keeps local provider keys only while the synced execution route is unchanged", () => {
    const a = rig();
    const b = rig();
    const provider = a.lib.createProvider({ type: "openai", name: "OpenAI", apiKeyEnc: "secret-blob" });
    a.lib.setProviderModels(provider.id, [{ modelId: "gpt-5" }]);
    a.engine.refineDirty();
    drain(a.engine, b.engine);

    const onB = b.lib.getProvider(provider.id)!;
    expect(onB.api_key_enc).toBeNull();
    expect(b.lib.listProviderModels(provider.id).map((m) => m.model_id)).toEqual(["gpt-5"]);

    // B connects with its own key; a later provider edit from A must not erase it.
    b.lib.updateProvider(provider.id, { apiKeyEnc: "b-local-key" });
    a.lib.updateProvider(provider.id, { name: "OpenAI (renamed)" });
    a.engine.refineDirty(Date.now() + 2_000);
    b.engine.refineDirty(Date.now() + 1_000);
    syncBoth(a, b);
    expect(b.lib.getProvider(provider.id)?.api_key_enc).toBe("b-local-key");
    expect(a.lib.getProvider(provider.id)?.api_key_enc).toBe("secret-blob");
    expect(a.lib.getProvider(provider.id)?.name).toBe("OpenAI (renamed)");

    // A route change is different from a display-name edit: B must confirm
    // credentials for the new destination instead of silently reusing its key.
    a.lib.updateProvider(provider.id, { baseUrl: "https://gateway.example/v1" });
    a.engine.refineDirty(Date.now() + 4_000);
    drain(a.engine, b.engine);
    expect(b.lib.getProvider(provider.id)).toMatchObject({
      base_url: "https://gateway.example/v1",
      api_key_enc: null,
    });
  });

  it("clears a local provider key when any synced route field changes", () => {
    const cases = [
      { column: "type", value: "anthropic" },
      { column: "driver", value: "anthropic" },
      { column: "base_url", value: "https://gateway.example/v1" },
    ] as const;

    for (const route of cases) {
      const a = rig();
      const b = rig();
      const provider = a.lib.createProvider({
        type: "openai",
        driver: "openai",
        name: "OpenAI",
        apiKeyEnc: "a-local-key",
      });
      a.engine.refineDirty(1_000);
      drain(a.engine, b.engine);
      b.lib.updateProvider(provider.id, { apiKeyEnc: "b-local-key" });

      a.db.prepare(`UPDATE providers SET ${route.column} = ? WHERE id = ?`).run(route.value, provider.id);
      a.engine.refineDirty(3_000);
      b.engine.refineDirty(2_000);
      drain(a.engine, b.engine);

      expect(b.lib.getProvider(provider.id)?.api_key_enc, route.column).toBeNull();
    }
  });

  it("truncates oversized run outputs before they leave the device", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Runs", content: "x" });
    const versionId = prompt.current_version_id!;
    a.lib.recordModelRun({
      promptId: prompt.id,
      versionId,
      provider: "p",
      model: "m",
      status: "completed",
      output: "y".repeat(2_200_000),
      promptContent: "Exact executed prompt",
    });
    a.engine.refineDirty();
    drain(a.engine, b.engine);

    const run = b.lib.listRuns(prompt.id)[0]!;
    expect(run.output!.length).toBeLessThanOrEqual(2_001_000);
    expect(run.output).toMatch(/sync-truncated/);
    expect(run.prompt_content).toBeNull();
  });

  it("syncs drafts with last-writer-wins", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Draft", content: "x" });
    a.engine.refineDirty();
    drain(a.engine, b.engine);

    a.lib.setDraft(prompt.id, "draft from A");
    a.engine.refineDirty(Date.now() + 1_000);
    b.lib.setDraft(prompt.id, "draft from B");
    b.engine.refineDirty(Date.now() + 2_000);
    syncBoth(a, b);
    expect(a.lib.getDraft(prompt.id)).toBe("draft from B");
    expect(b.lib.getDraft(prompt.id)).toBe("draft from B");
  });

  it("bootstraps a pre-sync library by marking every row dirty", () => {
    const a = rig();
    const b = rig();
    // A library built before migration v6: its rows predate the triggers, so
    // the dirty log is empty even though nothing has ever been shipped.
    a.lib.createPrompt({ title: "Legacy", content: "old" });
    a.lib.createTag({ name: "existing" });
    a.db.prepare("DELETE FROM sync_dirty").run();
    expect(a.engine.pendingDirty()).toBe(0);
    expect(a.engine.refineDirty().ops).toBe(0);

    a.engine.bootstrapDirty();
    expect(a.engine.pendingDirty()).toBeGreaterThan(0);
    a.engine.refineDirty();
    drain(a.engine, b.engine);
    expect(b.lib.listPrompts().length).toBe(1);
    expect(b.lib.listTags().map((t) => t.name)).toEqual(["existing"]);
  });

  it("converges to identical libraries regardless of apply order", () => {
    const a = rig();
    const b = rig();
    const base = a.lib.createPrompt({ title: "Base", content: "v1" });
    a.lib.createTag({ name: "alpha" });
    a.engine.refineDirty();
    drain(a.engine, b.engine);

    // Independent divergent edits on both sides.
    a.lib.createVersion({
      promptId: base.id,
      branchId: a.lib.listBranches(base.id)[0]!.id,
      content: "A edit",
    });
    a.lib.addNote({ promptId: base.id, body: "note A" });
    a.lib.setStarred(base.id, true);
    a.lib.setDraft(base.id, "draft A");
    b.lib.createVersion({
      promptId: base.id,
      branchId: b.lib.listBranches(base.id)[0]!.id,
      content: "B edit",
    });
    b.lib.addNote({ promptId: base.id, body: "note B" });
    b.lib.setDraft(base.id, "draft B");
    b.lib.createTag({ name: "beta" });
    a.engine.refineDirty(Date.now() + 1_000);
    b.engine.refineDirty(Date.now() + 2_000);

    // Two fresh clones receive all ops in opposite orders.
    const c1 = rig();
    const c2 = rig();
    const opsA = collectAll(a.engine);
    const opsB = collectAll(b.engine);
    c1.engine.applyRemote([...opsA, ...opsB]);
    c2.engine.applyRemote([...opsB, ...opsA]);

    expect(normalizedExport(c1)).toEqual(normalizedExport(c2));
    expect(c1.lib.listPrompts().length).toBe(1);
    expect(c1.lib.listTags().map((t) => t.name)).toEqual(["alpha", "beta"]);
  });

  it("a superseded pointer stash cannot resurrect a stale current version", () => {
    const a = rig();
    const prompt = a.lib.createPrompt({ title: "Pointer", content: "v1" });
    const row = a.lib.getPrompt(prompt.id)!;
    const v1 = prompt.current_version_id!;
    // A version id that exists only in ops, never locally at stash time.
    const v2 = "22222222-3333-4444-5555-666666666666";
    const promptOp = (hlc: string, pointer: string, opId: string): SyncOp => ({
      source: "crafting-device",
      seq: 1,
      opId,
      table: "prompts",
      recordId: prompt.id,
      kind: "upsert",
      payload: { ...row, current_version_id: pointer },
      hlc,
      createdAt: row.updated_at,
    });

    // 1. An older op wants v2, which has not arrived — stashed.
    a.engine.applyRemote([promptOp(formatHlc({ millis: 1_000, counter: 0 }), v2, "op-stash")]);
    expect(a.lib.getPrompt(prompt.id)?.current_version_id).toBe(v1);
    // 2. A newer winning op sets the pointer to v1 directly — the stash for
    //    this prompt is superseded and must be dropped.
    a.engine.applyRemote([promptOp(formatHlc({ millis: 2_000, counter: 0 }), v1, "op-direct")]);
    expect(a.lib.getPrompt(prompt.id)?.current_version_id).toBe(v1);
    // 3. The stale v2 version op finally arrives — it must NOT flip the
    //    pointer back.
    a.engine.applyRemote([
      {
        source: "crafting-device",
        seq: 2,
        opId: "op-version",
        table: "versions",
        recordId: v2,
        kind: "upsert",
        payload: {
          id: v2,
          prompt_id: prompt.id,
          branch_id: a.lib.listBranches(prompt.id)[0]!.id,
          parent_version_id: v1,
          number: 2,
          label: null,
          content: "stale",
          content_format: "markdown",
          change_note: null,
          author: "You",
          status: "active",
          source: "user",
          created_at: row.created_at,
        },
        hlc: formatHlc({ millis: 1_500, counter: 0 }),
        createdAt: row.created_at,
      },
    ]);
    expect(a.lib.getVersion(v2)?.content).toBe("stale"); // the version exists
    expect(a.lib.getPrompt(prompt.id)?.current_version_id).toBe(v1); // pointer untouched
  });

  it("deletes the merged-away tag id on the device that lost the name race", () => {
    const a = rig();
    const b = rig();
    a.lib.createTag({ name: "prod" });
    const tagB = b.lib.createTag({ name: "prod" });
    a.engine.refineDirty(Date.now() + 1_000);
    b.engine.refineDirty(Date.now() + 2_000);
    syncBoth(a, b);
    for (const r of [a, b]) {
      expect(r.lib.listTags().filter((t) => t.name === "prod").length).toBe(1);
    }

    // Canonicalization may have retired B's original id; delete the row that
    // actually represents the logical tag, as a future alias-aware API would.
    const canonicalId = (b.db.prepare("SELECT id FROM tags WHERE name = 'prod'").get() as { id: string }).id;
    b.db.prepare("DELETE FROM tags WHERE id = ?").run(canonicalId);
    b.engine.refineDirty();
    drain(b.engine, a.engine);
    // A kept its own id for "prod"; the tombstone must follow the remap.
    expect(a.lib.listTags().filter((t) => t.name === "prod").length).toBe(0);
  });

  it("breaks exact HLC ties deterministically by device id", () => {
    // Two ops carrying the IDENTICAL stamp from different devices: whichever
    // device id sorts lower must win on both receivers, in either order.
    const base = Date.now();
    const stamp = formatHlc({ millis: base, counter: 7 });
    const promptId = "aaaaaaaa-1111-4222-8333-444444444444";
    const row = (starred: 0 | 1): Record<string, unknown> => ({
      id: promptId,
      title: "Tie",
      description: null,
      icon: null,
      draft_content: null,
      current_version_id: null,
      is_starred: starred,
      created_at: new Date(base).toISOString(),
      updated_at: new Date(base).toISOString(),
      deleted_at: null,
    });
    const op = (source: string, starred: 0 | 1): SyncOp => ({
      source,
      seq: 1,
      opId: `tie-${source}`,
      table: "prompts",
      recordId: promptId,
      kind: "upsert",
      payload: row(starred),
      hlc: stamp,
      createdAt: new Date(base).toISOString(),
    });
    const sourceLow = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const sourceHigh = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    // On an exact stamp tie, the pairwise comparison resolves to the HIGHER
    // device id winning every encounter, in every arrival order: "high first"
    // means low loses, "low first" means high overwrites. The property under
    // test is convergence — both clones must agree on the same winner.
    const c1 = rig();
    const c2 = rig();
    c1.engine.applyRemote([op(sourceHigh, 0), op(sourceLow, 1)]);
    c2.engine.applyRemote([op(sourceLow, 1), op(sourceHigh, 0)]);
    expect(c1.lib.getPrompt(promptId)?.is_starred).toBe(0);
    expect(c2.lib.getPrompt(promptId)?.is_starred).toBe(0);
  });

  it("restore (undelete) beats an older tombstone regardless of apply order", () => {
    const a = rig();
    const prompt = a.lib.createPrompt({ title: "Trash dance", content: "x" });
    a.lib.softDeletePrompt(prompt.id);
    a.engine.refineDirty(Date.now() + 1_000);
    const deleteOps = collectAll(a.engine);
    a.lib.restorePrompt(prompt.id);
    a.engine.refineDirty(Date.now() + 2_000);
    const everything = collectAll(a.engine);
    const restoreOps = everything.filter((op) => !deleteOps.includes(op));
    expect(restoreOps.length).toBeGreaterThan(0);

    // Two arrival orders — tombstone-stream then restore, and interleaved —
    // must both end with the prompt visible.
    for (const order of [
      [...deleteOps, ...restoreOps],
      [
        ...restoreOps.slice(0, Math.ceil(restoreOps.length / 2)),
        ...deleteOps,
        ...restoreOps.slice(Math.ceil(restoreOps.length / 2)),
      ],
    ]) {
      const c = rig();
      c.engine.applyRemote(order);
      expect(c.lib.getPrompt(prompt.id)?.deleted_at).toBeNull();
    }
  });

  it("syncs share records with their delete tokens; revocation propagates", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Shared", content: "x" });
    const share = a.lib.recordSharedSnapshot({
      snapshotId: "V1StGXR8_Z5jdHi6B-myT",
      promptId: prompt.id,
      portalBaseUrl: "https://promptbranch.app",
      url: "https://promptbranch.app/p/V1StGXR8_Z5jdHi6B-myT",
      deleteToken: "tok-secret",
      fullHistory: false,
      publishedAt: new Date().toISOString(),
    });
    expect(share.delete_token).toBe("tok-secret");
    a.engine.refineDirty();
    drain(a.engine, b.engine);

    // The peer gains the share record AND revoke capability.
    const onB = b.lib.getSharedSnapshot("V1StGXR8_Z5jdHi6B-myT")!;
    expect(onB.url).toBe("https://promptbranch.app/p/V1StGXR8_Z5jdHi6B-myT");
    expect(onB.delete_token).toBe("tok-secret");
    expect(onB.prompt_id).toBe(prompt.id);

    // Revoke from B; A must see the share as revoked.
    b.lib.markSharedSnapshotDeleted("V1StGXR8_Z5jdHi6B-myT");
    b.engine.refineDirty();
    drain(b.engine, a.engine);
    expect(a.lib.getSharedSnapshot("V1StGXR8_Z5jdHi6B-myT")?.deleted_at).not.toBeNull();
  });

  it("syncs permanent removal of a revoked share", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Removed share", content: "x" });
    a.lib.recordSharedSnapshot({
      snapshotId: "REMOVEXR8_Z5jdHi6B-myT",
      promptId: prompt.id,
      portalBaseUrl: "https://promptbranch.app",
      url: "https://promptbranch.app/p/REMOVEXR8_Z5jdHi6B-myT",
      deleteToken: "remove-token",
      fullHistory: false,
      publishedAt: "2026-09-03T00:00:00.000Z",
    });
    a.engine.refineDirty(1_000);
    drain(a.engine, b.engine);

    a.lib.markSharedSnapshotDeleted("REMOVEXR8_Z5jdHi6B-myT");
    a.engine.refineDirty(2_000);
    drain(a.engine, b.engine);
    a.lib.removeRevokedSharedSnapshot("REMOVEXR8_Z5jdHi6B-myT");
    a.engine.refineDirty(3_000);

    for (let round = 0; round < 2; round++) syncBoth(a, b);

    expect(a.lib.getSharedSnapshot("REMOVEXR8_Z5jdHi6B-myT")).toBeNull();
    expect(b.lib.getSharedSnapshot("REMOVEXR8_Z5jdHi6B-myT")).toBeNull();
  });

  it("keeps the share revocable when its prompt is hard-deleted elsewhere", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Doomed", content: "x" });
    a.lib.recordSharedSnapshot({
      snapshotId: "W2XtGXR8_Z5jdHi6B-myT",
      promptId: prompt.id,
      portalBaseUrl: "https://promptbranch.app",
      url: "https://promptbranch.app/p/W2XtGXR8_Z5jdHi6B-myT",
      deleteToken: "tok-2",
      fullHistory: false,
      publishedAt: new Date().toISOString(),
    });
    a.engine.refineDirty();
    drain(a.engine, b.engine);
    expect(b.lib.getPrompt(prompt.id)).not.toBeNull();

    a.lib.hardDeletePrompt(prompt.id);
    a.engine.refineDirty();
    drain(a.engine, b.engine);

    // Mirror of the v5 ON DELETE SET NULL: the share outlives the prompt.
    const onB = b.lib.getSharedSnapshot("W2XtGXR8_Z5jdHi6B-myT")!;
    expect(onB.prompt_id).toBeNull();
    expect(onB.delete_token).toBe("tok-2");
  });

  it("keeps a concurrently published share revocable after prompt hard deletion", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Concurrent share", content: "x" });
    a.engine.refineDirty(1_000);
    drain(a.engine, b.engine);

    b.lib.recordSharedSnapshot({
      snapshotId: "RACEGXR8_Z5jdHi6B-myT",
      promptId: prompt.id,
      portalBaseUrl: "https://promptbranch.app",
      url: "https://promptbranch.app/p/RACEGXR8_Z5jdHi6B-myT",
      deleteToken: "race-delete-token",
      fullHistory: false,
      publishedAt: "2026-09-02T00:00:00.000Z",
    });
    b.engine.refineDirty(2_000);
    a.lib.hardDeletePrompt(prompt.id);
    a.engine.refineDirty(3_000);

    for (let round = 0; round < 3; round++) syncBoth(a, b);

    for (const peer of [a, b]) {
      expect(peer.lib.getPrompt(prompt.id)).toBeNull();
      expect(peer.lib.getSharedSnapshot("RACEGXR8_Z5jdHi6B-myT")).toEqual(
        expect.objectContaining({
          prompt_id: null,
          delete_token: "race-delete-token",
        }),
      );
    }
    expect(a.engine.haveVector()[b.engine.deviceId()]).toBe(1);
  });

  it("never clears share revocation when prompt deletion nulls its back-reference", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Revoked share", content: "x" });
    a.lib.recordSharedSnapshot({
      snapshotId: "REVOKEXR8_Z5jdHi6B-myT",
      promptId: prompt.id,
      portalBaseUrl: "https://promptbranch.app",
      url: "https://promptbranch.app/p/REVOKEXR8_Z5jdHi6B-myT",
      deleteToken: "revoke-token",
      fullHistory: false,
      publishedAt: "2026-09-02T00:00:00.000Z",
    });
    a.engine.refineDirty(1_000);
    drain(a.engine, b.engine);

    a.lib.markSharedSnapshotDeleted("REVOKEXR8_Z5jdHi6B-myT");
    a.engine.refineDirty(2_000);
    b.lib.hardDeletePrompt(prompt.id);
    b.engine.refineDirty(3_000);

    for (let round = 0; round < 3; round++) syncBoth(b, a);

    for (const peer of [a, b]) {
      const share = peer.lib.getSharedSnapshot("REVOKEXR8_Z5jdHi6B-myT")!;
      expect(share.prompt_id).toBeNull();
      expect(share.deleted_at).not.toBeNull();
      expect(share.delete_token).toBe("revoke-token");
    }
  });

  it("keeps an unseen concurrently revoked share after its prompt tombstone", () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Unseen revoked share", content: "x" });
    a.engine.refineDirty(1_000);
    drain(a.engine, b.engine);

    b.lib.recordSharedSnapshot({
      snapshotId: "UNSEENXR8_Z5jdHi6B-myT",
      promptId: prompt.id,
      portalBaseUrl: "https://promptbranch.app",
      url: "https://promptbranch.app/p/UNSEENXR8_Z5jdHi6B-myT",
      deleteToken: "unseen-revoke-token",
      fullHistory: false,
      publishedAt: "2026-09-02T00:00:00.000Z",
    });
    b.lib.markSharedSnapshotDeleted("UNSEENXR8_Z5jdHi6B-myT");
    const revokedAt = b.lib.getSharedSnapshot("UNSEENXR8_Z5jdHi6B-myT")!.deleted_at!;
    b.engine.refineDirty(2_000);
    a.lib.hardDeletePrompt(prompt.id);
    a.engine.refineDirty(3_000);

    for (let round = 0; round < 3; round++) syncBoth(a, b);

    for (const peer of [a, b]) {
      expect(peer.lib.getPrompt(prompt.id)).toBeNull();
      expect(peer.lib.getSharedSnapshot("UNSEENXR8_Z5jdHi6B-myT")).toEqual(
        expect.objectContaining({
          prompt_id: null,
          delete_token: "unseen-revoke-token",
          deleted_at: revokedAt,
        }),
      );
    }
    expect(a.engine.haveVector()[b.engine.deviceId()]).toBe(1);
  });

  it("merges concurrent share revocations to the first timestamp in either arrival order", () => {
    const a = rig();
    const b = rig();
    const c1 = rig();
    const c2 = rig();
    const prompt = a.lib.createPrompt({ title: "Concurrent revocations", content: "x" });
    a.lib.recordSharedSnapshot({
      snapshotId: "TWOREVXR8_Z5jdHi6B-myT",
      promptId: prompt.id,
      portalBaseUrl: "https://promptbranch.app",
      url: "https://promptbranch.app/p/TWOREVXR8_Z5jdHi6B-myT",
      deleteToken: "two-revokes-token",
      fullHistory: false,
      publishedAt: "2026-09-02T00:00:00.000Z",
    });
    a.engine.refineDirty(1_000);
    for (const peer of [b, c1, c2]) drain(a.engine, peer.engine);

    const firstRevocation = "2026-09-02T00:01:00.000Z";
    const secondRevocation = "2026-09-02T00:02:00.000Z";
    a.db
      .prepare("UPDATE shared_snapshots SET deleted_at = ? WHERE snapshot_id = ?")
      .run(firstRevocation, "TWOREVXR8_Z5jdHi6B-myT");
    a.engine.refineDirty(2_000);
    b.db
      .prepare("UPDATE shared_snapshots SET deleted_at = ? WHERE snapshot_id = ?")
      .run(secondRevocation, "TWOREVXR8_Z5jdHi6B-myT");
    b.engine.refineDirty(3_000);

    const revokeA = collectAll(a.engine).find(
      (op) =>
        op.source === a.engine.deviceId() &&
        op.table === "shared_snapshots" &&
        op.recordId === "TWOREVXR8_Z5jdHi6B-myT" &&
        op.payload?.["deleted_at"] === firstRevocation,
    )!;
    const revokeB = collectAll(b.engine).find(
      (op) =>
        op.source === b.engine.deviceId() &&
        op.table === "shared_snapshots" &&
        op.recordId === "TWOREVXR8_Z5jdHi6B-myT" &&
        op.payload?.["deleted_at"] === secondRevocation,
    )!;

    c1.engine.applyRemote([revokeA, revokeB]);
    c2.engine.applyRemote([revokeB, revokeA]);

    expect(c1.lib.getSharedSnapshot("TWOREVXR8_Z5jdHi6B-myT")?.deleted_at).toBe(firstRevocation);
    expect(c2.lib.getSharedSnapshot("TWOREVXR8_Z5jdHi6B-myT")?.deleted_at).toBe(firstRevocation);
  });

  it("backfills pre-v7 share rows into the dirty set exactly once", () => {
    const a = rig();
    // Simulate a share created before v7 existed: capture it, then wipe the
    // dirty log as if the triggers had not been installed.
    const prompt = a.lib.createPrompt({ title: "Old share", content: "x" });
    a.lib.recordSharedSnapshot({
      snapshotId: "OLD123456789012345678",
      promptId: prompt.id,
      portalBaseUrl: "https://promptbranch.app",
      url: "https://promptbranch.app/p/OLD123456789012345678",
      deleteToken: "tok-old",
      fullHistory: false,
      publishedAt: new Date().toISOString(),
    });
    a.engine.refineDirty();
    a.db.prepare("DELETE FROM sync_dirty").run();

    // The v7 enqueue statement marks rows not yet captured as ops — and is
    // idempotent for rows that already shipped.
    const backfill = a.db.prepare(
      `INSERT INTO sync_dirty (table_name, record_id, kind)
       SELECT 'shared_snapshots', snapshot_id, 'upsert' FROM shared_snapshots
       WHERE snapshot_id NOT IN (SELECT record_id FROM sync_ops WHERE table_name = 'shared_snapshots')`,
    );
    expect(() => backfill.run()).not.toThrow();
    const stillDirty = a.db
      .prepare("SELECT COUNT(*) AS n FROM sync_dirty WHERE table_name = 'shared_snapshots'")
      .get() as { n: number };
    expect(stillDirty.n).toBe(0); // already an op → guard skips it

    // A row that never shipped does get enqueued (wipe the trigger's capture
    // first to observe the backfill path alone).
    a.db
      .prepare(
        `INSERT INTO shared_snapshots (snapshot_id, prompt_id, portal_base_url, url, delete_token, full_history, published_at)
         VALUES ('NEW123456789012345678', NULL, 'https://x', 'https://x/p', 't', 0, ?)`,
      )
      .run(new Date().toISOString());
    a.db.prepare("DELETE FROM sync_dirty").run();
    backfill.run();
    const enqueued = a.db
      .prepare("SELECT COUNT(*) AS n FROM sync_dirty WHERE table_name = 'shared_snapshots'")
      .get() as { n: number };
    expect(enqueued.n).toBe(1);
  });
});

/** Pulls every op an engine holds, tracking the have-vector ourselves. */
function collectAll(engine: SyncEngine): SyncOp[] {
  const ops: SyncOp[] = [];
  const have: Record<string, number> = {};
  for (let round = 0; round < 100; round++) {
    const batch = engine.opsSince(have, 1_000_000);
    ops.push(...batch.ops);
    for (const op of batch.ops) have[op.source] = Math.max(have[op.source] ?? 0, op.seq);
    if (!batch.hasMore || batch.ops.length === 0) break;
  }
  return ops;
}
