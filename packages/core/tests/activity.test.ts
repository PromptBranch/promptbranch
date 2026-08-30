import { beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, PromptLibrary, type Database } from "../src/index.js";

let db: Database;
let lib: PromptLibrary;

beforeEach(() => {
  db = openMemoryDatabase();
  lib = new PromptLibrary(db);
});

describe("listRecentActivity", () => {
  it("returns versions across prompts, newest first, with prompt title and branch name", () => {
    const a = lib.createPrompt({ title: "Alpha", content: "a1" });
    const b = lib.createPrompt({ title: "Beta", content: "b1" });
    const branch = lib.listBranches(a.id)[0]!;
    lib.createVersion({ promptId: a.id, branchId: branch.id, content: "a2", changeNote: "tightened" });

    const feed = lib.listRecentActivity(10);
    expect(feed).toHaveLength(3);
    expect(feed[0]!.prompt_title).toBe("Alpha");
    expect(feed[0]!.number).toBe(2);
    expect(feed[0]!.branch_name).toBe("main");
    expect(feed[0]!.change_note).toBe("tightened");
    expect(feed.map((item) => item.prompt_title)).toEqual(["Alpha", "Beta", "Alpha"]);
  });

  it("respects the limit", () => {
    for (let i = 0; i < 5; i += 1) lib.createPrompt({ title: `P${i}`, content: "x" });
    expect(lib.listRecentActivity(3)).toHaveLength(3);
  });

  it("includes versions of soft-deleted prompts", () => {
    const p = lib.createPrompt({ title: "Gone", content: "x" });
    lib.softDeletePrompt(p.id);
    expect(lib.listRecentActivity(10)).toHaveLength(1);
  });
});

describe("notes deletion", () => {
  it("deletes a note and reindexes", () => {
    const p = lib.createPrompt({ title: "Noted", content: "x" });
    const note = lib.addNote({ promptId: p.id, body: "remember this" });
    expect(lib.listNotes(p.id)).toHaveLength(1);
    lib.deleteNote(note.id);
    expect(lib.listNotes(p.id)).toHaveLength(0);
    expect(lib.search("remember")).toHaveLength(0);
  });

  it("throws for an unknown note", () => {
    expect(() => lib.deleteNote("nope")).toThrow();
  });
});

describe("listCollectionIdsForPrompt", () => {
  it("returns the collections a prompt belongs to", () => {
    const p = lib.createPrompt({ title: "C", content: "x" });
    const c1 = lib.createCollection({ name: "One" });
    const c2 = lib.createCollection({ name: "Two" });
    lib.addPromptToCollection(c1.id, p.id);
    lib.addPromptToCollection(c2.id, p.id);
    expect(lib.listCollectionIdsForPrompt(p.id).sort()).toEqual([c1.id, c2.id].sort());
    lib.removePromptFromCollection(c1.id, p.id);
    expect(lib.listCollectionIdsForPrompt(p.id)).toEqual([c2.id]);
  });
});

describe("listPrompts filters", () => {
  it("deletedOnly returns only trashed prompts", () => {
    const a = lib.createPrompt({ title: "Keep", content: "x" });
    const b = lib.createPrompt({ title: "Trash", content: "x" });
    lib.softDeletePrompt(b.id);
    expect(lib.listPrompts({ deletedOnly: true }).map((p) => p.id)).toEqual([b.id]);
    expect(lib.listPrompts({ deletedOnly: true, sort: "title" })[0]!.id).toBe(b.id);
    lib.restorePrompt(b.id);
    expect(lib.listPrompts({ deletedOnly: true })).toHaveLength(0);
    expect(a.id).toBeTruthy();
  });

  it("minRating filters by average prompt rating", () => {
    const low = lib.createPrompt({ title: "Low", content: "x" });
    const high = lib.createPrompt({ title: "High", content: "x" });
    lib.addRating({ targetType: "prompt", targetId: low.id, effectiveness: 2 });
    lib.addRating({ targetType: "prompt", targetId: high.id, effectiveness: 5, clarity: 4 });

    expect(lib.listPrompts({ minRating: 3 }).map((p) => p.id)).toEqual([high.id]);
    expect(lib.listPrompts({ minRating: 1 }).map((p) => p.id).sort()).toEqual([low.id, high.id].sort());
    expect(lib.listPrompts({ minRating: 3, sort: "rating" })).toHaveLength(1);
  });
});
