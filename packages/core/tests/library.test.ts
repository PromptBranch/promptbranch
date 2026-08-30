import { beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, PromptLibrary, type Database } from "../src/index.js";

let db: Database;
let lib: PromptLibrary;

beforeEach(() => {
  db = openMemoryDatabase();
  lib = new PromptLibrary(db);
});

describe("prompts", () => {
  it("creates a prompt with main branch, version 1 and current pointer set", () => {
    const prompt = lib.createPrompt({ title: "Hello", description: "Greeting", content: "Say hi" });

    const branches = lib.listBranches(prompt.id);
    expect(branches).toHaveLength(1);
    expect(branches[0]!.name).toBe("main");

    const versions = lib.listVersions(prompt.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.number).toBe(1);
    expect(versions[0]!.content).toBe("Say hi");
    expect(versions[0]!.branch_name).toBe("main");

    expect(prompt.current_version_id).toBe(versions[0]!.id);
    expect(prompt.is_starred).toBe(0);
    expect(prompt.deleted_at).toBeNull();
  });

  it("updates metadata and refreshes updated_at", () => {
    const prompt = lib.createPrompt({ title: "Old", content: "x" });
    const updated = lib.updatePromptMetadata(prompt.id, { title: "New", description: "desc" });
    expect(updated.title).toBe("New");
    expect(updated.description).toBe("desc");
    expect(updated.updated_at >= prompt.updated_at).toBe(true);
    expect(() => lib.updatePromptMetadata(prompt.id, { title: "  " })).toThrow();
  });

  it("lists prompts with filters and sorting", () => {
    const a = lib.createPrompt({ title: "Alpha", content: "a" });
    const b = lib.createPrompt({ title: "Beta", content: "b" });
    lib.setStarred(b.id, true);

    expect(lib.listPrompts().map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(lib.listPrompts({ starred: true }).map((p) => p.id)).toEqual([b.id]);
    expect(lib.listPrompts({ sort: "title" }).map((p) => p.title)).toEqual(["Alpha", "Beta"]);

    lib.softDeletePrompt(a.id);
    expect(lib.listPrompts().map((p) => p.id)).toEqual([b.id]);
    expect(lib.listPrompts({ includeDeleted: true })).toHaveLength(2);
    lib.restorePrompt(a.id);
    expect(lib.listPrompts()).toHaveLength(2);
  });

  it("hard-deletes a prompt and its children", () => {
    const prompt = lib.createPrompt({ title: "Doomed", content: "x" });
    const tag = lib.createTag({ name: "t1" });
    lib.addTagToPrompt(prompt.id, tag.id);
    lib.addNote({ promptId: prompt.id, body: "note" });

    lib.hardDeletePrompt(prompt.id);
    expect(lib.getPrompt(prompt.id)).toBeNull();
    expect(lib.listVersions(prompt.id)).toHaveLength(0);
    expect(lib.listNotes(prompt.id)).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM prompt_tags WHERE prompt_id = ?").get(prompt.id))
      .toMatchObject({ c: 0 });
    expect(lib.search("Doomed")).toHaveLength(0);
  });

  it("stores and clears a draft", () => {
    const prompt = lib.createPrompt({ title: "P", content: "x" });
    expect(lib.getDraft(prompt.id)).toBeNull();
    lib.setDraft(prompt.id, "work in progress");
    expect(lib.getDraft(prompt.id)).toBe("work in progress");
    lib.setDraft(prompt.id, null);
    expect(lib.getDraft(prompt.id)).toBeNull();
  });
});

describe("versions", () => {
  it("auto-increments per-branch numbers, updates current pointer and stores change notes", () => {
    const prompt = lib.createPrompt({ title: "P", content: "v1 content" });
    const main = lib.listBranches(prompt.id)[0]!;

    const v2 = lib.createVersion({
      promptId: prompt.id,
      branchId: main.id,
      content: "v2 content",
      changeNote: "tightened wording",
    });
    expect(v2.number).toBe(2);
    expect(v2.change_note).toBe("tightened wording");
    expect(v2.parent_version_id).toBe(prompt.current_version_id);

    const v3 = lib.createVersion({ promptId: prompt.id, branchId: main.id, content: "v3 content" });
    expect(v3.number).toBe(3);
    expect(v3.parent_version_id).toBe(v2.id);
    expect(lib.getPrompt(prompt.id)!.current_version_id).toBe(v3.id);
    expect(lib.getBranchHead(main.id)!.id).toBe(v3.id);
  });

  it("restores an older version as current", () => {
    const prompt = lib.createPrompt({ title: "P", content: "first" });
    const main = lib.listBranches(prompt.id)[0]!;
    const v1Id = prompt.current_version_id!;
    const v2 = lib.createVersion({ promptId: prompt.id, branchId: main.id, content: "second" });
    expect(lib.getPrompt(prompt.id)!.current_version_id).toBe(v2.id);

    const restored = lib.setCurrentVersion(prompt.id, v1Id);
    expect(restored.current_version_id).toBe(v1Id);
  });

  it("rejects versions on a branch belonging to another prompt", () => {
    const a = lib.createPrompt({ title: "A", content: "x" });
    const b = lib.createPrompt({ title: "B", content: "y" });
    const branchOfB = lib.listBranches(b.id)[0]!;
    expect(() =>
      lib.createVersion({ promptId: a.id, branchId: branchOfB.id, content: "nope" }),
    ).toThrow();
  });
});

describe("branches", () => {
  it("creates a branch copying content with parent_version_id set", () => {
    const prompt = lib.createPrompt({ title: "P", content: "base content" });
    const { branch, version } = lib.createBranch({
      promptId: prompt.id,
      name: "experiment",
      fromVersionId: prompt.current_version_id!,
    });

    expect(branch.prompt_id).toBe(prompt.id);
    expect(version.number).toBe(1);
    expect(version.branch_id).toBe(branch.id);
    expect(version.content).toBe("base content");
    expect(version.parent_version_id).toBe(prompt.current_version_id);
    expect(lib.listBranches(prompt.id).map((b) => b.name).sort()).toEqual(["experiment", "main"]);
  });

  it("numbers versions independently per branch", () => {
    const prompt = lib.createPrompt({ title: "P", content: "base" });
    const { branch } = lib.createBranch({
      promptId: prompt.id,
      name: "alt",
      fromVersionId: prompt.current_version_id!,
    });
    const v = lib.createVersion({ promptId: prompt.id, branchId: branch.id, content: "alt v2" });
    expect(v.number).toBe(2);
  });

  it("rejects duplicate branch names on the same prompt", () => {
    const prompt = lib.createPrompt({ title: "P", content: "base" });
    lib.createBranch({ promptId: prompt.id, name: "alt", fromVersionId: prompt.current_version_id! });
    expect(() =>
      lib.createBranch({ promptId: prompt.id, name: "alt", fromVersionId: prompt.current_version_id! }),
    ).toThrow(/already exists/);
  });

  it("parents new versions on the branch head, independently of main", () => {
    const prompt = lib.createPrompt({ title: "P", content: "base" });
    const main = lib.listBranches(prompt.id)[0]!;
    const { branch, version: branchV1 } = lib.createBranch({
      promptId: prompt.id,
      name: "alt",
      fromVersionId: prompt.current_version_id!,
    });

    // Saving on the branch chains off the branch head, not main's.
    const branchV2 = lib.createVersion({ promptId: prompt.id, branchId: branch.id, content: "alt v2" });
    expect(branchV2.number).toBe(2);
    expect(branchV2.parent_version_id).toBe(branchV1.id);

    // ...and saving on main still chains off main's head.
    const mainV2 = lib.createVersion({ promptId: prompt.id, branchId: main.id, content: "main v2" });
    expect(mainV2.number).toBe(2);
    expect(mainV2.parent_version_id).toBe(prompt.current_version_id);
    expect(lib.getBranchHead(branch.id)!.id).toBe(branchV2.id);
    expect(lib.getBranchHead(main.id)!.id).toBe(mainV2.id);
  });
});

describe("tags and collections", () => {
  it("adds/removes tags and reports usage counts", () => {
    const p1 = lib.createPrompt({ title: "P1", content: "x" });
    const p2 = lib.createPrompt({ title: "P2", content: "y" });
    const tag = lib.createTag({ name: "coding", color: "#f00" });
    const other = lib.createTag({ name: "writing" });

    lib.addTagToPrompt(p1.id, tag.id);
    lib.addTagToPrompt(p2.id, tag.id);
    lib.addTagToPrompt(p1.id, tag.id); // idempotent

    let tags = lib.listTags();
    expect(tags.find((t) => t.id === tag.id)!.usage_count).toBe(2);
    expect(tags.find((t) => t.id === other.id)!.usage_count).toBe(0);

    lib.setPromptTags(p2.id, [other.id]);
    tags = lib.listTags();
    expect(tags.find((t) => t.id === tag.id)!.usage_count).toBe(1);
    expect(tags.find((t) => t.id === other.id)!.usage_count).toBe(1);

    lib.removeTagFromPrompt(p1.id, tag.id);
    expect(lib.listTags().find((t) => t.id === tag.id)!.usage_count).toBe(0);
    expect(lib.listPrompts({ tagIds: [other.id] }).map((p) => p.id)).toEqual([p2.id]);
  });

  it("manages collection membership and counts", () => {
    const p1 = lib.createPrompt({ title: "P1", content: "x" });
    const p2 = lib.createPrompt({ title: "P2", content: "y" });
    const collection = lib.createCollection({ name: "Favorites" });

    lib.addPromptToCollection(collection.id, p1.id);
    lib.addPromptToCollection(collection.id, p2.id);
    lib.addPromptToCollection(collection.id, p1.id); // idempotent

    expect(lib.listCollections()[0]!.prompt_count).toBe(2);
    expect(lib.listPrompts({ collectionId: collection.id })).toHaveLength(2);

    lib.removePromptFromCollection(collection.id, p1.id);
    expect(lib.listCollections()[0]!.prompt_count).toBe(1);
  });
});

describe("ratings", () => {
  it("rejects out-of-range and empty scores", () => {
    const prompt = lib.createPrompt({ title: "P", content: "x" });
    expect(() =>
      lib.addRating({ targetType: "prompt", targetId: prompt.id, effectiveness: 6 }),
    ).toThrow(/between 1 and 5/);
    expect(() =>
      lib.addRating({ targetType: "prompt", targetId: prompt.id, clarity: 0 }),
    ).toThrow(/between 1 and 5/);
    expect(() => lib.addRating({ targetType: "prompt", targetId: prompt.id })).toThrow(
      /at least one dimension/,
    );
  });

  it("returns latest rating and per-dimension averages", () => {
    const prompt = lib.createPrompt({ title: "P", content: "x" });
    lib.addRating({ targetType: "prompt", targetId: prompt.id, effectiveness: 4, clarity: 2 });
    const second = lib.addRating({
      targetType: "prompt",
      targetId: prompt.id,
      effectiveness: 2,
      completeness: 5,
    });

    const latest = lib.getLatestRating("prompt", prompt.id);
    expect(latest!.id).toBe(second.id);

    const avg = lib.getAverageRatings("prompt", prompt.id);
    expect(avg.count).toBe(2);
    expect(avg.effectiveness).toBeCloseTo(3);
    expect(avg.clarity).toBeCloseTo(2);
    expect(avg.completeness).toBeCloseTo(5);
    expect(avg.actionability).toBeNull();
    expect(avg.overall).toBeCloseTo((4 + 2 + 2 + 5) / 4);
  });

  it("rates versions too", () => {
    const prompt = lib.createPrompt({ title: "P", content: "x" });
    const versionId = prompt.current_version_id!;
    lib.addRating({ targetType: "version", targetId: versionId, actionability: 5 });
    expect(lib.getLatestRating("version", versionId)!.actionability).toBe(5);
  });

  it("summarizes version ratings per prompt", () => {
    const prompt = lib.createPrompt({ title: "P", content: "x" });
    const main = lib.listBranches(prompt.id)[0]!;
    const v1Id = prompt.current_version_id!;
    const v2 = lib.createVersion({ promptId: prompt.id, branchId: main.id, content: "v2" });

    lib.addRating({ targetType: "version", targetId: v1Id, effectiveness: 4, clarity: 2 });
    lib.addRating({ targetType: "version", targetId: v1Id, effectiveness: 2 });
    lib.addRating({ targetType: "version", targetId: v2.id, completeness: 5 });

    const summaries = lib.getVersionRatingSummaries(prompt.id);
    expect(summaries).toHaveLength(2);
    const s1 = summaries.find((s) => s.version_id === v1Id)!;
    expect(s1.count).toBe(2);
    expect(s1.effectiveness).toBeCloseTo(3);
    expect(s1.overall).toBeCloseTo((4 + 2 + 2) / 3);
    const s2 = summaries.find((s) => s.version_id === v2.id)!;
    expect(s2.overall).toBeCloseTo(5);

    // Ratings on other prompts' versions don't leak in.
    const other = lib.createPrompt({ title: "Q", content: "y" });
    lib.addRating({ targetType: "version", targetId: other.current_version_id!, clarity: 1 });
    expect(lib.getVersionRatingSummaries(prompt.id)).toHaveLength(2);
  });

  it("sorts and filters prompts by average prompt-level rating", () => {
    const low = lib.createPrompt({ title: "Low", content: "x" });
    const high = lib.createPrompt({ title: "High", content: "y" });
    const unrated = lib.createPrompt({ title: "Unrated", content: "z" });

    lib.addRating({ targetType: "prompt", targetId: low.id, effectiveness: 2 });
    lib.addRating({ targetType: "prompt", targetId: high.id, effectiveness: 5, clarity: 4 });

    const sorted = lib.listPrompts({ sort: "rating" });
    expect(sorted.map((p) => p.title)).toEqual(["High", "Low", "Unrated"]);

    expect(lib.listPrompts({ minRating: 4 }).map((p) => p.title)).toEqual(["High"]);
    expect(lib.listPrompts({ minRating: 2 }).map((p) => p.title).sort()).toEqual(["High", "Low"]);
    expect(lib.listPrompts({ sort: "rating", minRating: 4 }).map((p) => p.title)).toEqual(["High"]);

    // Version-targeted ratings must not affect prompt-level filtering.
    lib.addRating({ targetType: "version", targetId: unrated.current_version_id!, effectiveness: 5 });
    expect(lib.listPrompts({ minRating: 4 }).map((p) => p.title)).toEqual(["High"]);
  });
});

describe("runs", () => {
  it("records and lists runs with metrics", () => {
    const prompt = lib.createPrompt({ title: "P", content: "x" });
    const versionId = prompt.current_version_id!;

    const run = lib.addRun({
      promptId: prompt.id,
      versionId,
      tool: "chatgpt",
      model: "gpt-5",
      outcomeRating: 4,
      resultSummary: "worked well",
      metrics: { latencyMs: 820, tokens: 342 },
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(run.tool).toBe("chatgpt");
    expect(JSON.parse(run.metrics_json!)).toEqual({ latencyMs: 820, tokens: 342 });

    lib.addRun({ promptId: prompt.id, versionId });
    const runs = lib.listRuns(prompt.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.tool).toBe("manual"); // newest first

    expect(() => lib.addRun({ promptId: prompt.id, versionId, outcomeRating: 9 })).toThrow();
  });

  it("deletes runs", () => {
    const prompt = lib.createPrompt({ title: "P", content: "x" });
    const versionId = prompt.current_version_id!;
    const run = lib.addRun({ promptId: prompt.id, versionId, tool: "manual" });
    const keep = lib.addRun({ promptId: prompt.id, versionId, tool: "kimi-cli" });

    lib.deleteRun(run.id);
    expect(lib.listRuns(prompt.id).map((r) => r.id)).toEqual([keep.id]);
    expect(() => lib.deleteRun(run.id)).toThrow(/Run not found/);
  });

  it("merges metrics patches without clobbering existing keys", () => {
    const prompt = lib.createPrompt({ title: "P", content: "x" });
    const versionId = prompt.current_version_id!;
    const run = lib.addRun({
      promptId: prompt.id,
      versionId,
      metrics: { usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.001 },
    });

    const updated = lib.updateRunMetrics(run.id, { judgeRationale: "solid answer" });
    expect(JSON.parse(updated.metrics_json!)).toEqual({
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.001,
      judgeRationale: "solid answer",
    });

    // A run without metrics starts from an empty object; unknown ids throw.
    const bare = lib.addRun({ promptId: prompt.id, versionId });
    expect(JSON.parse(lib.updateRunMetrics(bare.id, { a: 1 }).metrics_json!)).toEqual({ a: 1 });
    expect(() => lib.updateRunMetrics("nope", { a: 1 })).toThrow(/Run not found/);
  });

  it("rejects metrics patches touching reserved execution keys", () => {
    const prompt = lib.createPrompt({ title: "P", content: "x" });
    const versionId = prompt.current_version_id!;
    const run = lib.addRun({
      promptId: prompt.id,
      versionId,
      metrics: { usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.001 },
    });

    expect(() => lib.updateRunMetrics(run.id, { usage: { inputTokens: 1, outputTokens: 1 } })).toThrow(
      /reserved/,
    );
    expect(() => lib.updateRunMetrics(run.id, { costUsd: 0 })).toThrow(/reserved/);
    // A patch mixing a reserved key with a legal one is rejected as a whole.
    expect(() => lib.updateRunMetrics(run.id, { judgeRationale: "ok", costUsd: 9 })).toThrow(/reserved/);
    // The rejection is atomic — the stored blob is untouched.
    const stored = lib.listRuns(prompt.id).find((r) => r.id === run.id)!;
    expect(JSON.parse(stored.metrics_json!)).toEqual({
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.001,
    });
  });

  it("lists the runs of one run group in creation order", () => {
    const prompt = lib.createPrompt({ title: "P", content: "x" });
    const versionId = prompt.current_version_id!;
    const first = lib.recordModelRun({
      promptId: prompt.id,
      versionId,
      provider: "prov",
      model: "m1",
      status: "completed",
      output: "one",
      runGroupId: "rg-1",
    });
    const second = lib.recordModelRun({
      promptId: prompt.id,
      versionId,
      provider: "prov",
      model: "m2",
      status: "error",
      error: "boom",
      runGroupId: "rg-1",
    });
    lib.addRun({ promptId: prompt.id, versionId, tool: "manual" }); // no group

    expect(lib.listRunGroupRuns("rg-1").map((r) => r.id)).toEqual([first.id, second.id]);
    expect(lib.listRunGroupRuns("rg-unknown")).toEqual([]);
  });
});

describe("notes", () => {
  it("adds and lists notes, optionally scoped to a version", () => {
    const prompt = lib.createPrompt({ title: "P", content: "x" });
    const versionId = prompt.current_version_id!;
    lib.addNote({ promptId: prompt.id, body: "general note" });
    lib.addNote({ promptId: prompt.id, versionId, body: "version note" });

    expect(lib.listNotes(prompt.id)).toHaveLength(2);
    expect(lib.listNotes(prompt.id, versionId)).toHaveLength(1);
    expect(lib.listNotes(prompt.id, versionId)[0]!.body).toBe("version note");
  });
});
