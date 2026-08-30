import { beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, PromptLibrary, type Database } from "../src/index.js";

let db: Database;
let lib: PromptLibrary;

beforeEach(() => {
  db = openMemoryDatabase();
  lib = new PromptLibrary(db);
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
