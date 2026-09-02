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

  it("never ships provider API keys and never clobbers a local key", () => {
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

    // B hard-deletes its (locally-winning) tag row — a future delete API.
    b.db.prepare("DELETE FROM tags WHERE id = ?").run(tagB.id);
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
