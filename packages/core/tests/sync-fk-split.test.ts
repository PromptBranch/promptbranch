import { describe, expect, it } from "vitest";
import { openMemoryDatabase, PromptLibrary, SyncEngine, type SyncOp } from "../src/index.js";
import { formatHlc } from "../src/sync/hlc.js";

function rig() {
  const db = openMemoryDatabase();
  return { lib: new PromptLibrary(db), engine: new SyncEngine(db) };
}

/** Every op an engine holds, as a receiver would pull them. */
function collectAll(engine: SyncEngine): SyncOp[] {
  const ops: SyncOp[] = [];
  const have: Record<string, number> = {};
  for (let round = 0; round < 100; round++) {
    const batch = engine.opsSince(have, 10_000_000);
    ops.push(...batch.ops);
    for (const op of batch.ops) have[op.source] = Math.max(have[op.source] ?? 0, op.seq);
    if (!batch.hasMore || batch.ops.length === 0) break;
  }
  return ops;
}

describe("apply with out-of-order foreign keys across sources", () => {
  it("does not explode when a junction arrives before its tag", () => {
    const a = rig();
    const b = rig();
    // A authors a tag; B pulls it, then attaches it to its own prompt.
    const tag = a.lib.createTag({ name: "prod" });
    a.engine.refineDirty();
    const bPull = collectAll(a.engine);
    b.engine.applyRemote(bPull);
    const promptB = b.lib.createPrompt({ title: "B prompt", content: "x" });
    b.lib.addTagToPrompt(promptB.id, tag.id);
    b.engine.refineDirty();

    // C first receives only B's junction op — exactly what a byte-budget
    // split between the two sources produces.
    const bOps = collectAll(b.engine);
    const junction = bOps.filter((op) => op.source === b.engine.deviceId() && op.table === "prompt_tags");
    const foreignTag = bOps.filter((op) => op.source === a.engine.deviceId() && op.table === "tags");
    const prompts = bOps.filter((op) => op.table === "prompts");
    expect(junction.length).toBe(1);
    expect(foreignTag.length).toBe(1);

    const c = rig();
    // The batch must not throw; the orphaned junction is deferred for now.
    const first = c.engine.applyRemote([...prompts, ...junction]);
    expect(first.applied + first.skipped + first.stale + first.deferred).toBe(prompts.length + junction.length);
    expect(first.deferred).toBe(1);

    // Once the tag arrives (next pull round), everything lands.
    const second = c.engine.applyRemote([...foreignTag, ...junction]);
    expect(second.applied).toBeGreaterThan(0);
    expect(c.lib.listTagsForPrompt(promptB.id).map((t) => t.name)).toEqual(["prod"]);
  });

  it("defers only foreign-key failures — CHECK violations stay loud", () => {
    const c = rig();
    const prompt = c.lib.createPrompt({ title: "Checks", content: "x" });
    const versionId = prompt.current_version_id!;
    const runOp: SyncOp = {
      source: "skewed-peer",
      seq: 1,
      opId: "bad-check",
      table: "runs",
      recordId: "11111111-2222-4333-8444-555555555555",
      kind: "upsert",
      payload: {
        id: "11111111-2222-4333-8444-555555555555",
        prompt_id: prompt.id,
        version_id: versionId,
        tool: "manual",
        model: null,
        provider: null,
        status: "completed",
        output: null,
        error: null,
        latency_ms: null,
        run_group_id: null,
        outcome_rating: 9, // violates CHECK (outcome_rating >= 1 AND <= 5)
        result_summary: null,
        metrics_json: null,
        started_at: null,
        created_at: new Date().toISOString(),
      },
      hlc: formatHlc({ millis: Date.now(), counter: 0 }),
      createdAt: new Date().toISOString(),
    };
    // A constraint error that is NOT an FK failure must not be swallowed:
    // deferring it would wedge this source's tail forever.
    expect(() => c.engine.applyRemote([runOp])).toThrow();
    // The preflight intentionally refined the local prompt aggregate, but the
    // rejected remote poison op itself was never recorded.
    expect(collectAll(c.engine).filter((entry) => entry.source === "skewed-peer")).toEqual([]);
  });

  it("reports both SQLite and semantic deferrals when a batch is split", () => {
    const receiver = rig();
    const prompt = receiver.lib.createPrompt({ title: "Mixed deferrals", content: "x" });
    const createdAt = "2026-09-02T00:00:00.000Z";
    const orphanJunction: SyncOp = {
      source: "mixed-peer",
      seq: 1,
      opId: "missing-tag",
      table: "prompt_tags",
      recordId: `${prompt.id}:missing-tag`,
      kind: "upsert",
      payload: { prompt_id: prompt.id, tag_id: "missing-tag" },
      hlc: formatHlc({ millis: 1_000, counter: 0 }),
      createdAt,
    };
    const unknownVersionRating: SyncOp = {
      source: "mixed-peer",
      seq: 2,
      opId: "unknown-version-rating",
      table: "ratings",
      recordId: "unknown-version-rating",
      kind: "upsert",
      payload: {
        id: "unknown-version-rating",
        target_type: "version",
        target_id: "unknown-version",
        effectiveness: null,
        clarity: 5,
        completeness: null,
        actionability: null,
        created_at: createdAt,
      },
      hlc: formatHlc({ millis: 1_000, counter: 1 }),
      createdAt,
    };

    const summary = receiver.engine.applyRemote([orphanJunction, unknownVersionRating]);

    expect(summary).toEqual({ applied: 0, skipped: 0, stale: 0, deferred: 2 });
    expect(receiver.engine.haveVector()["mixed-peer"] ?? 0).toBe(0);
  });

  it("propagates non-SQLite failures loudly (malformed composite record key)", () => {
    const c = rig();
    // prompt_tags has a two-part key; a one-part key cannot decode.
    const op: SyncOp = {
      source: "s",
      seq: 1,
      opId: "malformed",
      table: "prompt_tags",
      recordId: "just-one-segment",
      kind: "delete",
      payload: null,
      hlc: formatHlc({ millis: Date.now(), counter: 0 }),
      createdAt: new Date().toISOString(),
    };
    expect(() => c.engine.applyRemote([op])).toThrow(/Malformed record key/);
  });

  it("rowLimit caps each source per round and reports hasMore", () => {
    const c = rig();
    for (let i = 0; i < 5; i++) c.lib.createTag({ name: `tag-${i}` });
    c.engine.refineDirty();
    const first = c.engine.opsSince({}, 10_000_000, 2);
    expect(first.ops.length).toBe(2);
    expect(first.hasMore).toBe(true);
    const drained = collectAll(c.engine);
    expect(drained.length).toBeGreaterThanOrEqual(5);
  });

  it("rejects schema-drifted payloads loudly before they touch the transaction", () => {
    const promptId = "aaaaaaaa-1111-4222-8333-444444444444";
    const base = Date.now();
    const drifted: SyncOp = {
      source: "skewed-peer",
      seq: 1,
      opId: "drifted",
      table: "prompts",
      recordId: promptId,
      kind: "upsert",
      payload: {
        id: promptId,
        title: "Drift",
        description: null,
        icon: null,
        draft_content: null,
        current_version_id: null,
        is_starred: 0,
        created_at: new Date(base).toISOString(),
        updated_at: new Date(base).toISOString(),
        deleted_at: null,
        // A column this schema version does not know — future peer.
        emoji_reaction: "🔥",
      },
      hlc: formatHlc({ millis: base, counter: 0 }),
      createdAt: new Date(base).toISOString(),
    };
    expect(() => rig().engine.applyRemote([drifted])).toThrow(/unknown column "emoji_reaction"/);

    // And a payload missing part of a composite key is rejected by name too.
    const missingPk: SyncOp = {
      source: "skewed-peer",
      seq: 2,
      opId: "missing-pk",
      table: "prompt_tags",
      recordId: "pid:",
      kind: "upsert",
      payload: { prompt_id: "pid" },
      hlc: formatHlc({ millis: base, counter: 1 }),
      createdAt: new Date(base).toISOString(),
    };
    expect(() => rig().engine.applyRemote([missingPk])).toThrow(/missing pk column "tag_id"/);
  });
});
