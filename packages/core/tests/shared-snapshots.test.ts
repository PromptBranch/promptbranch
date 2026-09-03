import { describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, openMemoryDatabase, PromptLibrary } from "../src/index.js";

function setup() {
  const db = openMemoryDatabase();
  const lib = new PromptLibrary(db);
  return { db, lib };
}

/** Prompt with two versions on main ("first" → "second"). */
function seedPrompt(lib: PromptLibrary) {
  const prompt = lib.createPrompt({ title: "Code review", content: "v1 content", changeNote: "first" });
  const branchId = lib.listBranches(prompt.id)[0]!.id;
  lib.createVersion({ promptId: prompt.id, branchId, content: "v2 content", changeNote: "second" });
  return prompt;
}

const RECORD = {
  snapshotId: "V1StGXR8_Z5jdHi6B-myT",
  portalBaseUrl: "https://promptbranch.app",
  url: "https://promptbranch.app/p/V1StGXR8_Z5jdHi6B-myT",
  deleteToken: "tok-123",
  fullHistory: true,
  publishedAt: "2026-08-26T12:00:00.000Z",
};

describe("migration v5: shared_snapshots", () => {
  it("creates the table at schema version 5", () => {
    const { db } = setup();
    // openMemoryDatabase applies all migrations; v5's table must exist at 5+.
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shared_snapshots'")
      .get();
    expect(table).toBeTruthy();
  });
});

describe("recordSharedSnapshot / getSharedSnapshot", () => {
  it("round-trips a share record, delete token stored locally", () => {
    const { lib } = setup();
    const prompt = seedPrompt(lib);
    const record = lib.recordSharedSnapshot({ ...RECORD, promptId: prompt.id });
    expect(record.full_history).toBe(1);
    expect(record.deleted_at).toBeNull();
    const fetched = lib.getSharedSnapshot(RECORD.snapshotId);
    expect(fetched?.delete_token).toBe("tok-123");
    expect(fetched?.portal_base_url).toBe("https://promptbranch.app");
    expect(lib.getSharedSnapshot("missing")).toBeNull();
  });

  it("rejects records for unknown prompts", () => {
    const { lib } = setup();
    expect(() => lib.recordSharedSnapshot({ ...RECORD, promptId: "missing" })).toThrow(
      /Prompt not found/,
    );
  });
});

describe("listSharedSnapshots", () => {
  it("lists newest first, filterable by prompt, deleted rows included", () => {
    const { lib } = setup();
    const prompt = seedPrompt(lib);
    const other = lib.createPrompt({ title: "Other", content: "x" });
    lib.recordSharedSnapshot({ ...RECORD, promptId: prompt.id });
    lib.recordSharedSnapshot({
      ...RECORD,
      snapshotId: "AAAAAAAAAAAAAAAAAAAAA",
      promptId: prompt.id,
      publishedAt: "2026-08-27T12:00:00.000Z",
    });
    lib.recordSharedSnapshot({
      ...RECORD,
      snapshotId: "BBBBBBBBBBBBBBBBBBBBB",
      promptId: other.id,
      publishedAt: "2026-08-25T12:00:00.000Z",
    });
    lib.markSharedSnapshotDeleted(RECORD.snapshotId);

    const all = lib.listSharedSnapshots();
    expect(all.map((r) => r.snapshot_id)).toEqual([
      "AAAAAAAAAAAAAAAAAAAAA",
      RECORD.snapshotId,
      "BBBBBBBBBBBBBBBBBBBBB",
    ]);
    const forPrompt = lib.listSharedSnapshots(prompt.id);
    expect(forPrompt).toHaveLength(2);
    expect(forPrompt[1]!.deleted_at).not.toBeNull();
  });
});

describe("hardDeletePrompt with a published prompt", () => {
  it("keeps the share record (prompt_id set null) so the share stays revocable", () => {
    const { lib } = setup();
    const prompt = seedPrompt(lib);
    lib.recordSharedSnapshot({ ...RECORD, promptId: prompt.id });

    lib.hardDeletePrompt(prompt.id);

    const surviving = lib.getSharedSnapshot(RECORD.snapshotId);
    expect(surviving).not.toBeNull();
    expect(surviving!.prompt_id).toBeNull();
    // Still listed: the UI shows it (with the "(deleted prompt)" title fallback)
    // and the delete token is intact for a later revoke.
    expect(surviving!.delete_token).toBe("tok-123");
    expect(lib.listSharedSnapshots().map((r) => r.snapshot_id)).toEqual([RECORD.snapshotId]);
    expect(lib.listSharedSnapshots(prompt.id)).toEqual([]);
  });
});

describe("markSharedSnapshotDeleted", () => {
  it("sets deleted_at once and stays idempotent", () => {
    const { lib } = setup();
    const prompt = seedPrompt(lib);
    lib.recordSharedSnapshot({ ...RECORD, promptId: prompt.id });
    lib.markSharedSnapshotDeleted(RECORD.snapshotId);
    const first = lib.getSharedSnapshot(RECORD.snapshotId)!.deleted_at;
    expect(first).not.toBeNull();
    lib.markSharedSnapshotDeleted(RECORD.snapshotId);
    expect(lib.getSharedSnapshot(RECORD.snapshotId)!.deleted_at).toBe(first);
  });
});

describe("removeRevokedSharedSnapshot", () => {
  it("permanently removes a revoked share record", () => {
    const { lib } = setup();
    const prompt = seedPrompt(lib);
    lib.recordSharedSnapshot({ ...RECORD, promptId: prompt.id });
    lib.markSharedSnapshotDeleted(RECORD.snapshotId);

    lib.removeRevokedSharedSnapshot(RECORD.snapshotId);

    expect(lib.getSharedSnapshot(RECORD.snapshotId)).toBeNull();
  });

  it("refuses to remove an active share and preserves its revoke token", () => {
    const { lib } = setup();
    const prompt = seedPrompt(lib);
    lib.recordSharedSnapshot({ ...RECORD, promptId: prompt.id });

    expect(() => lib.removeRevokedSharedSnapshot(RECORD.snapshotId)).toThrow(/revoke/i);
    expect(lib.getSharedSnapshot(RECORD.snapshotId)?.delete_token).toBe(RECORD.deleteToken);
  });
});

describe("getSetting / setSetting", () => {
  it("returns null for missing keys, stores and overwrites values", () => {
    const { lib } = setup();
    expect(lib.getSetting("portal_base_url")).toBeNull();
    lib.setSetting("portal_base_url", "http://192.168.1.20:3000");
    expect(lib.getSetting("portal_base_url")).toBe("http://192.168.1.20:3000");
    lib.setSetting("portal_base_url", "");
    expect(lib.getSetting("portal_base_url")).toBe("");
  });
});

describe("listTagsForPrompt", () => {
  it("returns attached tags ordered by name", () => {
    const { lib } = setup();
    const prompt = seedPrompt(lib);
    const zebra = lib.createTag({ name: "zebra" });
    const alpha = lib.createTag({ name: "alpha" });
    lib.addTagToPrompt(prompt.id, zebra.id);
    lib.addTagToPrompt(prompt.id, alpha.id);
    expect(lib.listTagsForPrompt(prompt.id).map((t) => t.name)).toEqual(["alpha", "zebra"]);
    expect(lib.listTagsForPrompt(lib.createPrompt({ title: "bare", content: "x" }).id)).toEqual([]);
  });
});

describe("listDefaultBranchVersions", () => {
  it("returns active main-branch versions oldest first, excluding other branches and pending suggestions", () => {
    const { lib } = setup();
    const prompt = seedPrompt(lib); // main v1 + v2
    const v1 = lib.listVersions(prompt.id)[0]!;
    lib.createBranch({ promptId: prompt.id, name: "concise", fromVersionId: v1.id });
    lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: v1.id,
      newContent: "agent draft",
      rationale: "test",
    });

    const versions = lib.listDefaultBranchVersions(prompt.id);
    expect(versions.map((v) => v.number)).toEqual([1, 2]);
    expect(versions.map((v) => v.change_note)).toEqual(["first", "second"]);
  });

  it("falls back to the earliest branch when none is named main", () => {
    const { db, lib } = setup();
    const prompt = lib.createPrompt({ title: "t", content: "v1" });
    db.prepare("UPDATE branches SET name = 'primary' WHERE prompt_id = ?").run(prompt.id);
    expect(lib.listDefaultBranchVersions(prompt.id)).toHaveLength(1);
  });
});
