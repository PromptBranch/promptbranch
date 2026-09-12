import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  openMemoryDatabase,
  PromptLibrary,
  type Database,
  type SearchResult,
} from "@promptbranch/core";
import {
  assertQuickPaletteSelectionCurrent,
  QuickPaletteError,
  quickPaletteFailure,
  renderQuickPalette,
  resolveQuickPalette,
  searchQuickPalette,
} from "./quick-palette-library.js";

let db: Database;
let library: PromptLibrary;

beforeEach(() => {
  db = openMemoryDatabase();
  library = new PromptLibrary(db);
});

function setUpdatedAt(promptId: string, timestamp: string): void {
  db.prepare("UPDATE prompts SET updated_at = ? WHERE id = ?").run(timestamp, promptId);
}

describe("searchQuickPalette", () => {
  it("returns at most 20 eligible prompts with starred prompts first and stable recency", () => {
    const prompts = Array.from({ length: 22 }, (_, index) => {
      const prompt = library.createPrompt({ title: `Prompt ${index}`, content: `Content ${index}` });
      setUpdatedAt(prompt.id, `2026-09-12T12:${String(index).padStart(2, "0")}:00.000Z`);
      return prompt;
    });
    library.setStarred(prompts[3]!.id, true);
    library.setStarred(prompts[7]!.id, true);

    const results = searchQuickPalette(library, "");

    expect(results).toHaveLength(20);
    expect(results.slice(0, 2).map((item) => item.promptId)).toEqual([
      prompts[7]!.id,
      prompts[3]!.id,
    ]);
    expect(results.slice(2, 5).map((item) => item.promptId)).toEqual([
      prompts[21]!.id,
      prompts[20]!.id,
      prompts[19]!.id,
    ]);
  });

  it("deduplicates search hits and marks only older active-version matches as history", () => {
    const prompt = library.createPrompt({
      title: "Historic needle helper",
      content: "historic needle in version one",
    });
    const originalVersionId = prompt.current_version_id!;
    const branch = library.listBranches(prompt.id)[0]!;
    const current = library.createVersion({
      promptId: prompt.id,
      branchId: branch.id,
      content: "current saved text",
    });

    const historyOnly = searchQuickPalette(library, "version one");
    const metadataAndHistory = searchQuickPalette(library, "historic needle");
    const currentOnly = searchQuickPalette(library, "current saved");

    expect(historyOnly).toMatchObject([
      {
        promptId: prompt.id,
        currentVersionId: current.id,
        matchedHistory: true,
      },
    ]);
    expect(metadataAndHistory).toHaveLength(1);
    expect(metadataAndHistory[0]).toMatchObject({
      promptId: prompt.id,
      currentVersionId: current.id,
      matchedHistory: false,
    });
    expect(currentOnly[0]).toMatchObject({
      promptId: prompt.id,
      currentVersionId: current.id,
      matchedHistory: false,
    });
    expect(originalVersionId).not.toBe(current.id);
  });

  it("does not expose drafts, pending suggestions, or deleted prompts through search", () => {
    const prompt = library.createPrompt({ title: "Eligible", content: "saved baseline" });
    library.setDraft(prompt.id, "draftonlysecret");
    library.suggestVariation({
      promptId: prompt.id,
      baseVersionId: prompt.current_version_id!,
      newContent: "pendingonlysecret",
      rationale: "candidate",
    });
    const deleted = library.createPrompt({ title: "Deleted", content: "deletedonlysecret" });
    library.softDeletePrompt(deleted.id);

    expect(searchQuickPalette(library, "draftonlysecret")).toEqual([]);
    expect(searchQuickPalette(library, "pendingonlysecret")).toEqual([]);
    expect(searchQuickPalette(library, "deletedonlysecret")).toEqual([]);
  });

  it("ignores stale, inactive, and foreign hit-version metadata", () => {
    const first = library.createPrompt({ title: "First", content: "first" });
    const second = library.createPrompt({ title: "Second", content: "second" });
    const pending = library.suggestVariation({
      promptId: first.id,
      baseVersionId: first.current_version_id!,
      newContent: "pending",
      rationale: "candidate",
    }).version;
    const fakeHits: SearchResult[] = [
      { promptId: first.id, versionId: "missing", title: "First", snippet: "", rank: 1 },
      { promptId: first.id, versionId: pending.id, title: "First", snippet: "", rank: 2 },
      {
        promptId: first.id,
        versionId: second.current_version_id,
        title: "First",
        snippet: "",
        rank: 3,
      },
    ];
    vi.spyOn(library, "search").mockReturnValue(fakeHits);

    expect(searchQuickPalette(library, "anything")).toEqual([]);
  });
});

describe("resolveQuickPalette", () => {
  it("resolves exact current saved content and core variable names", () => {
    const prompt = library.createPrompt({
      title: "Greeting",
      content: "Hello {{ name }} — {{count}} / {{name}}",
    });

    expect(resolveQuickPalette(library, prompt.id)).toMatchObject({
      promptId: prompt.id,
      title: "Greeting",
      versionId: prompt.current_version_id,
      versionLabel: "v1",
      templateContent: "Hello {{ name }} — {{count}} / {{name}}",
      requiredVariables: ["name", "count"],
    });
  });

  it("rejects missing, soft-deleted, and current-inactive prompts", () => {
    const deleted = library.createPrompt({ title: "Deleted", content: "x" });
    library.softDeletePrompt(deleted.id);
    const inactive = library.createPrompt({ title: "Inactive", content: "x" });
    db.prepare("UPDATE versions SET status = 'rejected' WHERE id = ?").run(inactive.current_version_id);

    for (const promptId of ["missing", deleted.id, inactive.id]) {
      expect(() => resolveQuickPalette(library, promptId)).toThrowError(
        expect.objectContaining({ code: "not-found" }),
      );
    }
  });

  it("distinguishes a moved current pointer from removed or foreign versions", () => {
    const prompt = library.createPrompt({ title: "Changing", content: "v1" });
    const selected = resolveQuickPalette(library, prompt.id);
    const branch = library.listBranches(prompt.id)[0]!;
    library.createVersion({ promptId: prompt.id, branchId: branch.id, content: "v2" });

    expect(() =>
      assertQuickPaletteSelectionCurrent(library, {
        promptId: prompt.id,
        versionId: selected.versionId,
      }),
    ).toThrowError(expect.objectContaining({ code: "revision-changed" }));
    expect(() =>
      assertQuickPaletteSelectionCurrent(library, {
        promptId: prompt.id,
        versionId: "missing-version",
      }),
    ).toThrowError(expect.objectContaining({ code: "not-found" }));

    const other = library.createPrompt({ title: "Other", content: "other" });
    expect(() =>
      assertQuickPaletteSelectionCurrent(library, {
        promptId: prompt.id,
        versionId: other.current_version_id!,
      }),
    ).toThrowError(expect.objectContaining({ code: "not-found" }));
  });
});

describe("renderQuickPalette", () => {
  it("reports missing values without rendering or inventing variable semantics", () => {
    const prompt = library.createPrompt({ title: "Greeting", content: "{{name}} / {{count}}" });

    expect(
      renderQuickPalette(library, {
        sessionId: "session-1",
        promptId: prompt.id,
        versionId: prompt.current_version_id!,
        variables: { count: 0 },
      }),
    ).toEqual({ status: "needs-input", missingVariables: ["name"] });
  });

  it("preserves multiline Unicode, dollars, backslashes, repeats, and literal braces exactly", () => {
    const prompt = library.createPrompt({
      title: "Exact",
      content: "שלום {{name}}\n{{value}} | {{value}} | {{literal}} | {{path}}",
    });

    expect(
      renderQuickPalette(library, {
        sessionId: "session-1",
        promptId: prompt.id,
        versionId: prompt.current_version_id!,
        variables: {
          name: "עולם 🌙",
          value: "$1\nsecond line",
          literal: "{{do_not_expand}}",
          path: "C:\\tmp\\$draft",
        },
      }),
    ).toEqual({
      status: "ready",
      content:
        "שלום עולם 🌙\n$1\nsecond line | $1\nsecond line | {{do_not_expand}} | C:\\tmp\\$draft",
    });
  });

  it("renders a no-variable prompt unchanged", () => {
    const prompt = library.createPrompt({ title: "Plain", content: "No variables here.\n" });

    expect(
      renderQuickPalette(library, {
        sessionId: "session-1",
        promptId: prompt.id,
        versionId: prompt.current_version_id!,
        variables: {},
      }),
    ).toEqual({ status: "ready", content: "No variables here.\n" });
  });

  it("rejects unknown keys, too many variables, and oversized values or output", () => {
    const prompt = library.createPrompt({ title: "Limited", content: "{{known}}" });
    const render = (variables: Record<string, string | number | boolean>) =>
      renderQuickPalette(library, {
        sessionId: "session-1",
        promptId: prompt.id,
        versionId: prompt.current_version_id!,
        variables,
      });

    expect(() => render({ known: "ok", unknown: "no" })).toThrowError(
      expect.objectContaining({ code: "invalid-input" }),
    );
    expect(() => render({ known: "x".repeat(100_001) })).toThrowError(
      expect.objectContaining({ code: "invalid-input" }),
    );

    const tooMany = library.createPrompt({
      title: "Many",
      content: Array.from({ length: 101 }, (_, index) => `{{v${index}}}`).join(""),
    });
    expect(() => resolveQuickPalette(library, tooMany.id)).toThrowError(
      expect.objectContaining({ code: "invalid-input" }),
    );

    const repeated = library.createPrompt({
      title: "Large",
      content: "{{value}}".repeat(11),
    });
    expect(() =>
      renderQuickPalette(library, {
        sessionId: "session-1",
        promptId: repeated.id,
        versionId: repeated.current_version_id!,
        variables: { value: "x".repeat(100_000) },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });
});

describe("quickPaletteFailure", () => {
  it("preserves expected palette codes and normalizes unknown failures", () => {
    expect(quickPaletteFailure(new QuickPaletteError("revision-changed", "Refresh"))).toEqual({
      ok: false,
      code: "revision-changed",
      message: "Refresh",
    });
    expect(quickPaletteFailure(new Error("database failed"))).toEqual({
      ok: false,
      code: "invalid-input",
      message: "Unable to complete the prompt palette request.",
    });
  });
});
