import { beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, PromptLibrary, type Database } from "../src/index.js";

let db: Database;
let lib: PromptLibrary;

beforeEach(() => {
  db = openMemoryDatabase();
  lib = new PromptLibrary(db);
});

function seed() {
  const prompt = lib.createPrompt({ title: "Review prompt", content: "Review this code." });
  const base = lib.getVersion(prompt.current_version_id!)!;
  return { prompt, base };
}

describe("hard delete orphan ratings", () => {
  it("deletes ratings targeting the prompt and its versions", () => {
    const { prompt, base } = seed();
    lib.addRating({ targetType: "prompt", targetId: prompt.id, effectiveness: 4 });
    lib.addRating({ targetType: "version", targetId: base.id, clarity: 5 });

    lib.hardDeletePrompt(prompt.id);

    const remaining = db.prepare("SELECT COUNT(*) AS c FROM ratings").get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});

describe("suggestVariation", () => {
  it("creates an agent branch with a pending first version", () => {
    const { prompt, base } = seed();
    const { branch, version } = lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: base.id,
      newContent: "Review this code ruthlessly.",
      rationale: "Stricter tone improved outcomes",
    });

    expect(branch.name).toMatch(/^agent-\d{8}-[0-9a-f-]{8}$/);
    expect(branch.prompt_id).toBe(prompt.id);
    expect(version.status).toBe("pending");
    expect(version.source).toBe("agent");
    expect(version.author).toBe("Agent");
    expect(version.number).toBe(1);
    expect(version.parent_version_id).toBe(base.id);
    expect(version.change_note).toBe("Stricter tone improved outcomes");

    // The current pointer and prompt updated_at are untouched.
    const after = lib.getPrompt(prompt.id)!;
    expect(after.current_version_id).toBe(base.id);
    expect(after.updated_at).toBe(prompt.updated_at);
  });

  it("accepts an explicit branch name and rejects duplicates", () => {
    const { prompt, base } = seed();
    lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: base.id,
      newContent: "x",
      rationale: "r",
      branchName: "my-variation",
    });
    expect(lib.listBranches(prompt.id).map((b) => b.name)).toContain("my-variation");
    expect(() =>
      lib.suggestVariation({
        promptId: prompt.id,
        baseVersionId: base.id,
        newContent: "y",
        rationale: "r",
        branchName: "my-variation",
      }),
    ).toThrow(/already exists/);
  });

  it("validates input", () => {
    const { prompt, base } = seed();
    expect(() =>
      lib.suggestVariation({ promptId: prompt.id, baseVersionId: base.id, newContent: "  ", rationale: "r" }),
    ).toThrow(/content/i);
    expect(() =>
      lib.suggestVariation({ promptId: prompt.id, baseVersionId: base.id, newContent: "x", rationale: " " }),
    ).toThrow(/rationale/i);
    expect(() =>
      lib.suggestVariation({ promptId: prompt.id, baseVersionId: "nope", newContent: "x", rationale: "r" }),
    ).toThrow(/not found/);
  });
});

describe("pending version exclusion", () => {
  it("is excluded from listVersions by default and included with includePending", () => {
    const { prompt, base } = seed();
    lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: base.id,
      newContent: "pending content",
      rationale: "r",
    });
    expect(lib.listVersions(prompt.id)).toHaveLength(1);
    expect(lib.listVersions(prompt.id, { includePending: true })).toHaveLength(2);
  });

  it("is excluded from branch-head computation (parent selection in createVersion)", () => {
    const { prompt, base } = seed();
    const { branch } = lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: base.id,
      newContent: "pending v1",
      rationale: "r",
    });
    // Head of the agent branch ignores the pending v1…
    expect(lib.getBranchHead(branch.id)).toBeNull();
    // …so a new user version on that branch is parented as if it were empty.
    const v = lib.createVersion({
      promptId: prompt.id,
      branchId: branch.id,
      content: "user v1",
      changeNote: "manual",
    });
    expect(v.number).toBe(1);
    expect(v.parent_version_id).toBeNull();
    // Main branch head is unaffected.
    expect(lib.getBranchHead(base.branch_id)?.id).toBe(base.id);
  });

  it("is excluded from FTS search until approved", () => {
    const { prompt, base } = seed();
    const { version } = lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: base.id,
      newContent: "xyzzy unique token",
      rationale: "r",
    });
    expect(lib.search("xyzzy")).toHaveLength(0);
    lib.approveSuggestion(version.id);
    expect(lib.search("xyzzy")).toHaveLength(1);
  });

  it("cannot be set as current while pending", () => {
    const { prompt, base } = seed();
    const { version } = lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: base.id,
      newContent: "pending",
      rationale: "r",
    });
    expect(() => lib.setCurrentVersion(prompt.id, version.id)).toThrow(/pending/);
  });
});

describe("suggestion lifecycle", () => {
  it("listSuggestions returns pending versions newest first with prompt/branch context", () => {
    const a = lib.createPrompt({ title: "Alpha", content: "a" });
    const b = lib.createPrompt({ title: "Beta", content: "b" });
    const first = lib.suggestVariation({
      promptId: a.id,
      baseVersionId: a.current_version_id!,
      newContent: "a2",
      rationale: "first",
    });
    const second = lib.suggestVariation({
      promptId: b.id,
      baseVersionId: b.current_version_id!,
      newContent: "b2",
      rationale: "second",
    });

    const items = lib.listSuggestions();
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe(second.version.id);
    expect(items[1]!.id).toBe(first.version.id);
    expect(items[0]!.prompt_title).toBe("Beta");
    expect(items[1]!.prompt_title).toBe("Alpha");
    expect(items[0]!.branch_name).toBe(second.branch.name);
  });

  it("approve activates, optionally sets current, and rejects double-approval", () => {
    const { prompt, base } = seed();
    const { version } = lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: base.id,
      newContent: "better",
      rationale: "r",
    });

    const approved = lib.approveSuggestion(version.id);
    expect(approved.status).toBe("active");
    // Not current unless requested.
    expect(lib.getPrompt(prompt.id)!.current_version_id).toBe(base.id);
    expect(lib.listVersions(prompt.id)).toHaveLength(2);
    expect(() => lib.approveSuggestion(version.id)).toThrow(/active/);
    expect(() => lib.rejectSuggestion(version.id)).toThrow(/active/);
  });

  it("approve with setAsCurrent moves the current pointer", () => {
    const { prompt, base } = seed();
    const { version } = lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: base.id,
      newContent: "better",
      rationale: "r",
    });
    lib.approveSuggestion(version.id, { setAsCurrent: true });
    expect(lib.getPrompt(prompt.id)!.current_version_id).toBe(version.id);
  });

  it("reject marks the suggestion rejected and keeps it out of default listings", () => {
    const { prompt, base } = seed();
    const { version } = lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: base.id,
      newContent: "worse",
      rationale: "r",
    });
    const rejected = lib.rejectSuggestion(version.id);
    expect(rejected.status).toBe("rejected");
    expect(lib.listSuggestions()).toHaveLength(0);
    expect(lib.listVersions(prompt.id)).toHaveLength(1);
    expect(lib.listVersions(prompt.id, { includePending: true })).toHaveLength(2);
    expect(() => lib.setCurrentVersion(prompt.id, version.id)).toThrow(/rejected/);
    expect(() => lib.rejectSuggestion(version.id)).toThrow(/rejected/);
  });

  it("suggested branches behave like normal branches after approval", () => {
    const { prompt, base } = seed();
    const { branch, version } = lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: base.id,
      newContent: "better",
      rationale: "r",
    });
    lib.approveSuggestion(version.id);
    // The approved version is now the branch head; new versions stack on it.
    const next = lib.createVersion({
      promptId: prompt.id,
      branchId: branch.id,
      content: "even better",
      changeNote: "iterate",
    });
    expect(next.number).toBe(2);
    expect(next.parent_version_id).toBe(version.id);
  });
});
