import { describe, expect, it, vi } from "vitest";
import { openMemoryDatabase, PromptLibrary } from "@promptbranch/core";
import {
  OFFICIAL_PORTAL_BASE_URL,
  type PublishResponse,
  type SnapshotResponse,
} from "@promptbranch/share";
import {
  deleteShare,
  getPortalBaseUrl,
  importSnapshot,
  importSnapshotPreview,
  previewShare,
  publishShare,
  setPortalBaseUrl,
  type ShareServiceDeps,
} from "./share.js";
import { toSharePublishResult } from "./mappers.js";

const SNAPSHOT_ID = "V1StGXR8_Z5jdHi6B-myT";
const FIXED_NOW = new Date("2026-08-26T12:00:00.000Z");

function setup() {
  const db = openMemoryDatabase();
  const lib = new PromptLibrary(db);
  const prompt = lib.createPrompt({
    title: "Code review",
    description: "Reviews diffs",
    content: "Review this diff.",
    changeNote: "first",
  });
  const branchId = lib.listBranches(prompt.id)[0]!.id;
  // createVersion moves the current pointer: v2 becomes the shared content.
  lib.createVersion({
    promptId: prompt.id,
    branchId,
    content: "Review this diff carefully.",
    changeNote: "tighter",
  });
  const tag = lib.createTag({ name: "review" });
  lib.addTagToPrompt(prompt.id, tag.id);
  return { db, lib, prompt };
}

function makeDeps(lib: PromptLibrary, overrides: Partial<ShareServiceDeps> = {}): ShareServiceDeps {
  return { lib, appVersion: "0.1.0-test", now: () => FIXED_NOW, ...overrides };
}

const publishOk: PublishResponse = {
  id: SNAPSHOT_ID,
  url: `https://promptbranch.app/p/${SNAPSHOT_ID}`,
  deleteToken: "tok-123",
};

describe("previewShare", () => {
  it("uses the current editor content when the saved version is empty", () => {
    const lib = new PromptLibrary(openMemoryDatabase());
    const prompt = lib.createPrompt({ title: "Draft prompt", content: "" });
    const input = {
      promptId: prompt.id,
      includeHistory: false,
      content: "Use the content currently visible in the editor.",
    };

    const preview = previewShare(makeDeps(lib), input);

    expect(preview.payload.content).toBe("Use the content currently visible in the editor.");
  });

  it("rejects a genuinely blank prompt before portal schema validation", () => {
    const lib = new PromptLibrary(openMemoryDatabase());
    const prompt = lib.createPrompt({ title: "Blank prompt", content: "" });

    expect(() =>
      previewShare(makeDeps(lib), { promptId: prompt.id, includeHistory: false, content: "   " }),
    ).toThrow("Prompt content is empty — add content before sharing");
  });

  it("builds a current-version payload from the prompt (default scope)", () => {
    const { lib, prompt } = setup();
    const { payload, findings } = previewShare(
      makeDeps(lib),
      { promptId: prompt.id, includeHistory: false },
    );
    expect(payload).toEqual({
      formatVersion: 1,
      title: "Code review",
      description: "Reviews diffs",
      content: "Review this diff carefully.",
      tags: ["review"],
      publishedAt: "2026-08-26T12:00:00.000Z",
      appVersion: "0.1.0-test",
    });
    expect(findings).toEqual([]);
  });

  it("includes oldest-first branch history with change notes when opted in", () => {
    const { lib, prompt } = setup();
    const { payload } = previewShare(makeDeps(lib), { promptId: prompt.id, includeHistory: true });
    expect(payload.history).toEqual([
      { version: 1, content: "Review this diff.", changeNote: "first" },
      { version: 2, content: "Review this diff carefully.", changeNote: "tighter" },
    ]);
  });

  it("a publisher description override beats the prompt description", () => {
    const { lib, prompt } = setup();
    const { payload } = previewShare(makeDeps(lib), {
      promptId: prompt.id,
      includeHistory: false,
      description: "For the community",
    });
    expect(payload.description).toBe("For the community");
  });

  it("flags secrets found anywhere in the exact payload", () => {
    const { lib } = setup();
    const leaky = lib.createPrompt({
      title: "leaky",
      content: `Use this key: sk-${"a".repeat(30)}`,
    });
    const { findings } = previewShare(makeDeps(lib), {
      promptId: leaky.id,
      includeHistory: false,
    });
    expect(findings.some((f) => f.severity === "high" && f.rule === "openai-api-key")).toBe(true);
  });

  it("throws for unknown prompts", () => {
    const { lib } = setup();
    expect(() =>
      previewShare(makeDeps(lib), { promptId: "missing", includeHistory: false }),
    ).toThrow(/Prompt not found/);
  });
});

describe("publishShare", () => {
  it("blocks on high-severity findings before any network call", async () => {
    const { lib } = setup();
    const leaky = lib.createPrompt({ title: "leaky", content: `sk-${"a".repeat(30)}` });
    const publishImpl = vi.fn();
    await expect(
      publishShare(makeDeps(lib, { publishImpl }), {
        promptId: leaky.id,
        includeHistory: false,
      }),
    ).rejects.toThrow(/blocked/i);
    expect(publishImpl).not.toHaveBeenCalled();
    expect(lib.listSharedSnapshots()).toEqual([]);
  });

  it("publishes and records the share with the delete token", async () => {
    const { lib, prompt } = setup();
    const publishImpl: ShareServiceDeps["publishImpl"] = async (baseUrl, payload) => {
      expect(baseUrl).toBe(OFFICIAL_PORTAL_BASE_URL);
      expect(payload.title).toBe("Code review");
      return { ok: true, value: publishOk };
    };
    const result = await publishShare(makeDeps(lib, { publishImpl }), {
      promptId: prompt.id,
      includeHistory: true,
    });
    expect(result).toEqual(publishOk);
    const records = lib.listSharedSnapshots();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      snapshot_id: SNAPSHOT_ID,
      prompt_id: prompt.id,
      portal_base_url: OFFICIAL_PORTAL_BASE_URL,
      delete_token: "tok-123",
      full_history: 1,
      published_at: "2026-08-26T12:00:00.000Z",
    });
  });

  it("publishes against a configured self-hosted portal", async () => {
    const { lib, prompt } = setup();
    const deps = makeDeps(lib);
    setPortalBaseUrl(deps, "http://192.168.1.20:3000/");
    let seenBase = "";
    const publishImpl: ShareServiceDeps["publishImpl"] = async (baseUrl) => {
      seenBase = baseUrl;
      return { ok: true, value: publishOk };
    };
    await publishShare({ ...deps, publishImpl }, { promptId: prompt.id, includeHistory: false });
    expect(seenBase).toBe("http://192.168.1.20:3000");
  });

  it("surfaces client errors and records nothing", async () => {
    const { lib, prompt } = setup();
    const publishImpl: ShareServiceDeps["publishImpl"] = async () => ({
      ok: false,
      error: { kind: "rate-limited", retryAfterSeconds: 30 },
    });
    await expect(
      publishShare(makeDeps(lib, { publishImpl }), {
        promptId: prompt.id,
        includeHistory: false,
      }),
    ).rejects.toThrow(/30s/);
    expect(lib.listSharedSnapshots()).toEqual([]);
  });

  it("links a re-publish to the previous share via parentId", async () => {
    const { lib, prompt } = setup();
    const seenParents: Array<string | undefined> = [];
    let call = 0;
    const publishImpl: ShareServiceDeps["publishImpl"] = async (_baseUrl, payload) => {
      seenParents.push(payload.parentId);
      call += 1;
      const id = call === 1 ? SNAPSHOT_ID : "AbCdEfGhIjKlMnOpQrStU";
      return { ok: true, value: { ...publishOk, id, url: `https://promptbranch.app/p/${id}` } };
    };
    const deps = makeDeps(lib, { publishImpl });
    await publishShare(deps, { promptId: prompt.id, includeHistory: false });
    await publishShare(deps, { promptId: prompt.id, includeHistory: false });
    expect(seenParents).toEqual([undefined, SNAPSHOT_ID]);
  });

  it("does not link to revoked shares or shares on another portal", async () => {
    const { lib, prompt } = setup();
    lib.recordSharedSnapshot({
      snapshotId: SNAPSHOT_ID,
      promptId: prompt.id,
      portalBaseUrl: OFFICIAL_PORTAL_BASE_URL,
      url: publishOk.url,
      deleteToken: "tok-123",
      fullHistory: false,
      publishedAt: "2026-08-26T12:00:00.000Z",
    });
    lib.markSharedSnapshotDeleted(SNAPSHOT_ID);
    lib.recordSharedSnapshot({
      snapshotId: "AbCdEfGhIjKlMnOpQrStU",
      promptId: prompt.id,
      portalBaseUrl: "http://192.168.1.20:3000",
      url: `http://192.168.1.20:3000/p/AbCdEfGhIjKlMnOpQrStU`,
      deleteToken: "tok-456",
      fullHistory: false,
      publishedAt: "2026-08-26T12:00:00.000Z",
    });
    const publishImpl: ShareServiceDeps["publishImpl"] = async (_baseUrl, payload) => {
      expect(payload.parentId).toBeUndefined();
      return {
        ok: true,
        value: { ...publishOk, id: "zzzzyyyyxxxxwwwwvvvvu", url: `${OFFICIAL_PORTAL_BASE_URL}/p/zzzzyyyyxxxxwwwwvvvvu` },
      };
    };
    await publishShare(makeDeps(lib, { publishImpl }), {
      promptId: prompt.id,
      includeHistory: false,
    });
  });

  it("retries once without parentId when the portal 400s (stale lineage)", async () => {
    const { lib, prompt } = setup();
    lib.recordSharedSnapshot({
      snapshotId: SNAPSHOT_ID,
      promptId: prompt.id,
      portalBaseUrl: OFFICIAL_PORTAL_BASE_URL,
      url: publishOk.url,
      deleteToken: "tok-123",
      fullHistory: false,
      publishedAt: "2026-08-26T12:00:00.000Z",
    });
    const seenParents: Array<string | undefined> = [];
    const publishImpl: ShareServiceDeps["publishImpl"] = async (_baseUrl, payload) => {
      seenParents.push(payload.parentId);
      if (seenParents.length === 1) {
        return { ok: false, error: { kind: "http", status: 400, message: "unknown parentId" } };
      }
      return {
        ok: true,
        value: { ...publishOk, id: "AbCdEfGhIjKlMnOpQrStU", url: `${OFFICIAL_PORTAL_BASE_URL}/p/AbCdEfGhIjKlMnOpQrStU` },
      };
    };
    const result = await publishShare(makeDeps(lib, { publishImpl }), {
      promptId: prompt.id,
      includeHistory: false,
    });
    expect(result.id).toBe("AbCdEfGhIjKlMnOpQrStU");
    expect(seenParents).toEqual([SNAPSHOT_ID, undefined]);
    expect(lib.listSharedSnapshots()).toHaveLength(2);
  });

  it("does not retry a 400 when there is no parentId to drop", async () => {
    const { lib, prompt } = setup();
    const publishImpl: ShareServiceDeps["publishImpl"] = vi.fn(async () => ({
      ok: false as const,
      error: { kind: "http" as const, status: 400, message: "invalid snapshot" },
    }));
    await expect(
      publishShare(makeDeps(lib, { publishImpl }), {
        promptId: prompt.id,
        includeHistory: false,
      }),
    ).rejects.toThrow(/400/);
    expect(publishImpl).toHaveBeenCalledTimes(1);
  });
});

describe("toSharePublishResult (the IPC boundary strip)", () => {
  it("the value returned toward the renderer has no deleteToken key", () => {
    const result = toSharePublishResult(publishOk);
    expect(result).toEqual({ id: SNAPSHOT_ID, url: publishOk.url });
    expect("deleteToken" in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["id", "url"]);
  });
});

describe("portal base URL setting", () => {
  it("defaults to the official instance, stores an override, resets on empty", () => {
    const { lib } = setup();
    const deps = makeDeps(lib);
    expect(getPortalBaseUrl(deps)).toBe(OFFICIAL_PORTAL_BASE_URL);
    expect(setPortalBaseUrl(deps, "https://portal.example.com/")).toBe("https://portal.example.com");
    expect(getPortalBaseUrl(deps)).toBe("https://portal.example.com");
    expect(setPortalBaseUrl(deps, "")).toBe(OFFICIAL_PORTAL_BASE_URL);
    expect(getPortalBaseUrl(deps)).toBe(OFFICIAL_PORTAL_BASE_URL);
  });

  it("rejects non-http(s) and unparseable URLs", () => {
    const { lib } = setup();
    const deps = makeDeps(lib);
    expect(() => setPortalBaseUrl(deps, "ftp://x")).toThrow(/http\(s\)/);
    expect(() => setPortalBaseUrl(deps, "not a url")).toThrow(/http\(s\)/);
  });
});

describe("deleteShare", () => {
  function seededShare(lib: PromptLibrary, promptId: string) {
    lib.recordSharedSnapshot({
      snapshotId: SNAPSHOT_ID,
      promptId,
      portalBaseUrl: "https://promptbranch.app",
      url: publishOk.url,
      deleteToken: "tok-123",
      fullHistory: false,
      publishedAt: "2026-08-26T12:00:00.000Z",
    });
  }

  it("deletes on the portal with the stored token and marks the row", async () => {
    const { lib, prompt } = setup();
    seededShare(lib, prompt.id);
    const deleteImpl: ShareServiceDeps["deleteImpl"] = async (baseUrl, id, token) => {
      expect(id).toBe(SNAPSHOT_ID);
      expect(token).toBe("tok-123");
      return { ok: true, value: { deleted: true } };
    };
    await deleteShare(makeDeps(lib, { deleteImpl }), SNAPSHOT_ID);
    expect(lib.getSharedSnapshot(SNAPSHOT_ID)!.deleted_at).not.toBeNull();
  });

  it("marks the row when the portal says not-found (nothing left to revoke)", async () => {
    const { lib, prompt } = setup();
    seededShare(lib, prompt.id);
    const deleteImpl: ShareServiceDeps["deleteImpl"] = async () => ({
      ok: false,
      error: { kind: "not-found" },
    });
    await deleteShare(makeDeps(lib, { deleteImpl }), SNAPSHOT_ID);
    expect(lib.getSharedSnapshot(SNAPSHOT_ID)!.deleted_at).not.toBeNull();
  });

  it("is a no-op for already-revoked shares and throws for unknown ids", async () => {
    const { lib, prompt } = setup();
    seededShare(lib, prompt.id);
    lib.markSharedSnapshotDeleted(SNAPSHOT_ID);
    const deleteImpl = vi.fn();
    await deleteShare(makeDeps(lib, { deleteImpl }), SNAPSHOT_ID);
    expect(deleteImpl).not.toHaveBeenCalled();
    await expect(deleteShare(makeDeps(lib), "missing")).rejects.toThrow(/Unknown shared snapshot/);
  });

  it("propagates portal failures without marking the row", async () => {
    const { lib, prompt } = setup();
    seededShare(lib, prompt.id);
    const deleteImpl: ShareServiceDeps["deleteImpl"] = async () => ({
      ok: false,
      error: { kind: "http", status: 403, message: "forbidden" },
    });
    await expect(deleteShare(makeDeps(lib, { deleteImpl }), SNAPSHOT_ID)).rejects.toThrow(/403/);
    expect(lib.getSharedSnapshot(SNAPSHOT_ID)!.deleted_at).toBeNull();
  });
});

const importPreviewResponse: SnapshotResponse = {
  id: SNAPSHOT_ID,
  url: `https://portal.example.com/p/${SNAPSHOT_ID}`,
  publishedAt: "2026-08-25T12:00:00.000Z",
  snapshot: {
    formatVersion: 1,
    title: "security-audit",
    description: "Audit code",
    content: "You are a security auditor.",
    tags: ["review", "security"],
    history: [{ version: 1, content: "draft", changeNote: "first" }],
    publishedAt: "2026-08-25T12:00:00.000Z",
  },
};

describe("importSnapshotPreview", () => {
  it("fetches from the portal named by the URL, not the configured one", async () => {
    const { lib } = setup();
    let seenBase = "";
    const fetchImpl: ShareServiceDeps["fetchImpl"] = async (baseUrl) => {
      seenBase = baseUrl;
      return { ok: true, value: importPreviewResponse };
    };
    const result = await importSnapshotPreview(
      makeDeps(lib, { fetchImpl }),
      `https://portal.example.com/p/${SNAPSHOT_ID}`,
    );
    expect(seenBase).toBe("https://portal.example.com");
    expect(result.snapshot.title).toBe("security-audit");
  });

  it("surfaces gone/not-found as errors", async () => {
    const { lib } = setup();
    const fetchImpl: ShareServiceDeps["fetchImpl"] = async () => ({
      ok: false,
      error: { kind: "gone" },
    });
    await expect(importSnapshotPreview(makeDeps(lib, { fetchImpl }), SNAPSHOT_ID)).rejects.toThrow(
      /deleted/,
    );
  });

  it("rejects non-http(s) URLs without fetching", async () => {
    const { lib } = setup();
    const fetchImpl = vi.fn();
    await expect(
      importSnapshotPreview(makeDeps(lib, { fetchImpl }), `ftp://portal.example.com/p/${SNAPSHOT_ID}`),
    ).rejects.toThrow(/http\(s\)/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("importSnapshot", () => {
  it("creates a new prompt with tags, provenance note and change note", () => {
    const { lib } = setup();
    // "review" already exists (from setup) — it must be reused, not duplicated.
    const { promptId, title } = importSnapshot(makeDeps(lib), importPreviewResponse);
    expect(title).toBe("security-audit");
    const prompt = lib.getPrompt(promptId)!;
    expect(prompt.description).toBe("Audit code");
    expect(lib.listTags().map((t) => t.name).sort()).toEqual(["review", "security"]);
    expect(lib.listTagsForPrompt(promptId).map((t) => t.name)).toEqual(["review", "security"]);
    const v1 = lib.listVersions(promptId)[0]!;
    expect(v1.content).toBe("You are a security auditor.");
    expect(v1.change_note).toBe(`Imported from ${importPreviewResponse.url}`);
    expect(lib.listNotes(promptId).map((n) => n.body)).toEqual([
      `Imported from ${importPreviewResponse.url}`,
    ]);
  });

  it("suffixes the title on conflict", () => {
    const { lib } = setup();
    lib.createPrompt({ title: "security-audit", content: "existing" });
    const { title } = importSnapshot(makeDeps(lib), importPreviewResponse);
    expect(title).toBe("security-audit (imported)");
  });
});
