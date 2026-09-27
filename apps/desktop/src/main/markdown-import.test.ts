import { describe, expect, it, vi } from "vitest";
import { openMemoryDatabase, PromptLibrary } from "@promptbranch/core";
import { markdownConfirmSchema } from "../shared/ipc.js";
import {
  assertAuthorizedMainFrame,
  MarkdownImportService,
  type MarkdownImportDeps,
} from "./markdown-import.js";
import type { PublicMarkdownResult } from "./public-markdown.js";

const CONTENT = "# Review prompt\n\nPreserve these bytes.\r\n";
const FETCHED: PublicMarkdownResult = {
  sourceUrl: "https://example.com/prompts/review.md",
  finalUrl: "https://cdn.example.net/prompts/review-final.md",
  content: CONTENT,
  suggestedTitle: "review-final",
};
const SENDER_ID = 77;

function setup(overrides: Partial<MarkdownImportDeps> = {}) {
  const db = openMemoryDatabase();
  const lib = new PromptLibrary(db);
  let time = 1_000;
  let nextId = 0;
  const fetchMarkdown = vi.fn(async (url: string) => ({ ...FETCHED, sourceUrl: url }));
  const service = new MarkdownImportService({
    lib,
    fetchMarkdown,
    now: () => time,
    createId: () => `preview-${++nextId}`,
    ...overrides,
  });
  return {
    db,
    lib,
    service,
    fetchMarkdown,
    setTime: (value: number) => {
      time = value;
    },
  };
}

describe("MarkdownImportService", () => {
  it("keeps a preview in memory and writes nothing until confirmation", async () => {
    const { db, lib, service } = setup();
    try {
      const preview = await service.preview(FETCHED.sourceUrl, SENDER_ID);

      expect(preview).toMatchObject({
        sourceUrl: FETCHED.sourceUrl,
        finalUrl: FETCHED.finalUrl,
        suggestedTitle: "review-final",
        content: CONTENT,
      });
      expect(lib.listPrompts()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("discards a preview without writing and rejects confirmation afterward", async () => {
    const { db, lib, service } = setup();
    try {
      const preview = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      service.discard(preview.previewId, SENDER_ID);

      expect(lib.listPrompts()).toHaveLength(0);
      expect(() => service.confirm(preview.previewId, "Review", SENDER_ID)).toThrow();
    } finally {
      db.close();
    }
  });

  it("does not write when fetching fails", async () => {
    const fetchMarkdown = vi.fn(async () => {
      throw new Error("download failed");
    });
    const { db, lib, service } = setup({ fetchMarkdown });
    try {
      await expect(service.preview(FETCHED.sourceUrl, SENDER_ID)).rejects.toThrow(/download failed/);
      expect(lib.listPrompts()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("imports the exact previewed content as active v1 with source provenance", async () => {
    const { db, lib, service } = setup();
    try {
      const preview = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      const result = await service.confirm(preview.previewId, preview.suggestedTitle, SENDER_ID);
      const prompt = lib.getPrompt(result.promptId)!;
      const version = lib.getVersion(prompt.current_version_id!)!;
      const notes = lib.listNotes(prompt.id);

      expect(result.title).toBe("review-final");
      expect(prompt.title).toBe("review-final");
      expect(version.number).toBe(1);
      expect(version.status).toBe("active");
      expect(version.content).toBe(CONTENT);
      expect(version.change_note).toBe("Imported from Markdown URL");
      expect(notes).toHaveLength(1);
      expect(notes[0]?.body).toContain(`Source: ${FETCHED.sourceUrl}`);
      expect(notes[0]?.body).toContain(`Final URL: ${FETCHED.finalUrl}`);
      expect(notes[0]?.body).not.toContain("deleteToken");
    } finally {
      db.close();
    }
  });

  it("keeps the fetched bytes if the remote Markdown changes before confirmation", async () => {
    let remoteContent = CONTENT;
    const fetchMarkdown = vi.fn(async (url: string) => ({ ...FETCHED, sourceUrl: url, content: remoteContent }));
    const { db, lib, service } = setup({ fetchMarkdown });
    try {
      const preview = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      remoteContent = "# Changed remotely";
      await service.confirm(preview.previewId, "Reviewed snapshot", SENDER_ID);

      const prompt = lib.listPrompts()[0]!;
      const version = lib.getVersion(prompt.current_version_id!)!;
      expect(version.content).toBe(CONTENT);
      expect(fetchMarkdown).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it("suggests an available imported suffix but permits a deliberately chosen duplicate title", async () => {
    const fetchMarkdown = vi.fn(async (url: string) => ({
      ...FETCHED,
      sourceUrl: url,
      suggestedTitle: "Team review",
    }));
    const { db, lib, service } = setup({ fetchMarkdown });
    try {
      const existing = lib.createPrompt({ title: "Team review", content: "existing" });
      const preview = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      expect(preview.suggestedTitle).toBe("Team review (imported)");

      const duplicatePreview = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      const duplicateResult = await service.confirm(duplicatePreview.previewId, existing.title, SENDER_ID);
      expect(duplicateResult.promptId).not.toBe(existing.id);
      expect(lib.listPrompts().filter((prompt) => prompt.title === existing.title)).toHaveLength(2);
      expect(() => service.confirm(preview.previewId, "Review", SENDER_ID)).toThrow();
    } finally {
      db.close();
    }
  });

  it("suggests a bounded imported title when the filename title conflicts", async () => {
    const longTitle = "x".repeat(200);
    const fetchMarkdown = vi.fn(async (url: string) => ({
      ...FETCHED,
      sourceUrl: url,
      suggestedTitle: longTitle,
    }));
    const { db, lib, service } = setup({ fetchMarkdown });
    try {
      lib.createPrompt({ title: longTitle, content: "existing" });
      const preview = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      expect(preview.suggestedTitle.length).toBeLessThanOrEqual(200);
      expect(preview.suggestedTitle).not.toBe(longTitle);
    } finally {
      db.close();
    }
  });

  it("binds preview IDs to the requesting sender", async () => {
    const { db, lib, service } = setup();
    try {
      const preview = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      expect(() => service.confirm(preview.previewId, "Review", SENDER_ID + 1)).toThrow();
      service.discard(preview.previewId, SENDER_ID + 1);
      expect(lib.listPrompts()).toHaveLength(0);
      await service.confirm(preview.previewId, "Review", SENDER_ID);
      expect(lib.listPrompts()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("rejects expired, forged, and already consumed preview IDs", async () => {
    const { db, lib, service, setTime } = setup();
    try {
      expect(() => service.confirm("forged-token", "Review", SENDER_ID)).toThrow();
      const expired = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      setTime(1_000 + 10 * 60 * 1_000 + 1);
      expect(() => service.confirm(expired.previewId, "Review", SENDER_ID)).toThrow(/expired/i);

      setTime(2_000_000);
      const consumed = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      await service.confirm(consumed.previewId, "Review", SENDER_ID);
      expect(() => service.confirm(consumed.previewId, "Again", SENDER_ID)).toThrow();
      expect(lib.listPrompts()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("invalidates the previous ID when a sender requests a newer preview", async () => {
    const { db, lib, service } = setup();
    try {
      const first = await service.preview("https://example.com/first.md", SENDER_ID);
      const second = await service.preview("https://example.com/second.md", SENDER_ID);

      expect(() => service.confirm(first.previewId, "First", SENDER_ID)).toThrow();
      await service.confirm(second.previewId, "Second", SENDER_ID);
      expect(lib.listPrompts()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("ignores an older fetch that finishes after a newer preview request", async () => {
    let finishFirst!: (result: PublicMarkdownResult) => void;
    const fetchMarkdown = vi
      .fn()
      .mockImplementationOnce(
        (url: string) =>
          new Promise<PublicMarkdownResult>((resolve) => {
            finishFirst = (result) => resolve({ ...result, sourceUrl: url });
          }),
      )
      .mockImplementationOnce(async (url: string) => ({ ...FETCHED, sourceUrl: url }));
    const { db, lib, service } = setup({ fetchMarkdown });
    try {
      const firstRequest = service.preview("https://example.com/first.md", SENDER_ID);
      const second = await service.preview("https://example.com/second.md", SENDER_ID);
      finishFirst(FETCHED);
      await expect(firstRequest).rejects.toThrow(/replaced/i);
      await service.confirm(second.previewId, "Second", SENDER_ID);
      expect(lib.listPrompts()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("discards a sender session and any in-flight preview on window close", async () => {
    let finishFetch!: (result: PublicMarkdownResult) => void;
    const fetchMarkdown = vi.fn(
      (url: string) =>
        new Promise<PublicMarkdownResult>((resolve) => {
          finishFetch = (result) => resolve({ ...result, sourceUrl: url });
        }),
    );
    const { db, lib, service } = setup({ fetchMarkdown });
    try {
      const pending = service.preview(FETCHED.sourceUrl, SENDER_ID);
      service.discardSender(SENDER_ID);
      finishFetch(FETCHED);
      await expect(pending).rejects.toThrow(/replaced/i);
      expect(lib.listPrompts()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("restores a preview token after a recoverable library write error", async () => {
    const { db, lib, service } = setup();
    const createPrompt = vi.spyOn(lib, "createPrompt").mockImplementationOnce(() => {
      throw new Error("temporary write error");
    });
    try {
      const preview = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      expect(() => service.confirm(preview.previewId, "Review", SENDER_ID)).toThrow(
        "temporary write error",
      );
      await service.confirm(preview.previewId, "Review", SENDER_ID);
      expect(lib.listPrompts()).toHaveLength(1);
    } finally {
      createPrompt.mockRestore();
      db.close();
    }
  });

  it("accepts only a nonblank title of at most 200 characters", async () => {
    const { db, lib, service } = setup();
    try {
      const preview = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      expect(() => service.confirm(preview.previewId, "   ", SENDER_ID)).toThrow();
      expect(() => service.confirm(preview.previewId, "x".repeat(201), SENDER_ID)).toThrow();
      expect(lib.listPrompts()).toHaveLength(0);
      await service.confirm(preview.previewId, "Allowed", SENDER_ID);
    } finally {
      db.close();
    }
  });

  it("creates only one prompt for repeated or concurrent confirmation", async () => {
    const { db, lib, service } = setup();
    try {
      const preview = await service.preview(FETCHED.sourceUrl, SENDER_ID);
      const results = await Promise.allSettled([
        Promise.resolve().then(() => service.confirm(preview.previewId, "Review", SENDER_ID)),
        Promise.resolve().then(() => service.confirm(preview.previewId, "Review", SENDER_ID)),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(lib.listPrompts()).toHaveLength(1);
      expect(() => service.confirm(preview.previewId, "Review", SENDER_ID)).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("assertAuthorizedMainFrame", () => {
  it("accepts only the main window's main frame and returns its sender ID", () => {
    const mainFrame = {};
    const mainContents = { id: 11, mainFrame };

    expect(
      assertAuthorizedMainFrame(
        { sender: mainContents, senderFrame: mainFrame },
        { webContents: mainContents },
      ),
    ).toBe(11);
  });

  it("rejects a quick-palette sender, a subframe, and a missing main window", () => {
    const mainFrame = {};
    const mainContents = { id: 11, mainFrame };
    const quickPaletteContents = { id: 12, mainFrame: {} };
    const window = { webContents: mainContents };

    expect(() =>
      assertAuthorizedMainFrame(
        { sender: quickPaletteContents, senderFrame: quickPaletteContents.mainFrame },
        window,
      ),
    ).toThrow(/main window/i);
    expect(() =>
      assertAuthorizedMainFrame({ sender: mainContents, senderFrame: {} }, window),
    ).toThrow(/main frame/i);
    expect(() =>
      assertAuthorizedMainFrame({ sender: mainContents, senderFrame: mainFrame }, null),
    ).toThrow(/main window/i);
  });
});

describe("Markdown import IPC confirmation contract", () => {
  it("accepts only a preview token and title, never renderer-supplied content or URLs", () => {
    const valid = {
      previewId: "550e8400-e29b-41d4-a716-446655440000",
      title: "Reviewed prompt",
    };

    expect(markdownConfirmSchema.parse(valid)).toEqual(valid);
    expect(
      markdownConfirmSchema.safeParse({ ...valid, content: "renderer replacement" }).success,
    ).toBe(false);
    expect(
      markdownConfirmSchema.safeParse({ ...valid, sourceUrl: "https://attacker.example/" }).success,
    ).toBe(false);
  });
});
