import { beforeEach, describe, expect, it } from "vitest";
import {
  openMemoryDatabase,
  PromptLibrary,
  resolvePrompt,
  resolveVersion,
  type Database,
} from "../src/index.js";

let db: Database;
let lib: PromptLibrary;

beforeEach(() => {
  db = openMemoryDatabase();
  lib = new PromptLibrary(db);
});

describe("resolvePrompt", () => {
  it("resolves by exact id", () => {
    const prompt = lib.createPrompt({ title: "Security audit", content: "x" });
    expect(resolvePrompt(lib, prompt.id).id).toBe(prompt.id);
  });

  it("resolves by exact title, then case-insensitively, then by unique substring", () => {
    lib.createPrompt({ title: "Security audit", content: "x" });
    expect(resolvePrompt(lib, "Security audit").title).toBe("Security audit");
    expect(resolvePrompt(lib, "security audit").title).toBe("Security audit");
    expect(resolvePrompt(lib, "AUDIT").title).toBe("Security audit");
  });

  it("prefers exact title over substring matches", () => {
    lib.createPrompt({ title: "audit", content: "x" });
    lib.createPrompt({ title: "Security audit", content: "y" });
    expect(resolvePrompt(lib, "audit").title).toBe("audit");
  });

  it("throws listing close matches when a substring is ambiguous", () => {
    lib.createPrompt({ title: "Security audit v1", content: "x" });
    lib.createPrompt({ title: "Security audit v2", content: "y" });
    expect(() => resolvePrompt(lib, "security audit")).toThrow(/ambiguous/);
    expect(() => resolvePrompt(lib, "security audit")).toThrow(/Security audit v1/);
    expect(() => resolvePrompt(lib, "security audit")).toThrow(/Security audit v2/);
  });

  it("throws when nothing matches", () => {
    lib.createPrompt({ title: "Something", content: "x" });
    expect(() => resolvePrompt(lib, "missing")).toThrow(/No prompt matches/);
  });

  it("ignores soft-deleted prompts", () => {
    const prompt = lib.createPrompt({ title: "Trashed", content: "x" });
    lib.softDeletePrompt(prompt.id);
    expect(() => resolvePrompt(lib, "Trashed")).toThrow(/No prompt matches/);
    expect(() => resolvePrompt(lib, prompt.id)).toThrow(/No prompt matches/);
  });

  it("rejects empty input", () => {
    expect(() => resolvePrompt(lib, "  ")).toThrow(/must not be empty/);
  });
});

describe("resolveVersion", () => {
  function seed() {
    const prompt = lib.createPrompt({ title: "P", content: "v1 content" });
    const v1 = lib.getVersion(prompt.current_version_id!)!;
    const v2 = lib.createVersion({ promptId: prompt.id, branchId: v1.branch_id, content: "v2 content" });
    const { branch, version: branchV1 } = lib.createBranch({
      promptId: prompt.id,
      name: "concise",
      fromVersionId: v2.id,
    });
    return { prompt, v1, v2, branch, branchV1 };
  }

  it("defaults to the current version", () => {
    const { prompt, v2 } = seed();
    const r = resolveVersion(lib, prompt.id);
    expect(r.version.id).toBe(v2.id);
    expect(r.label).toBe("v2");
    expect(r.branchName).toBe("main");
  });

  it("resolves by version number on the current branch", () => {
    const { prompt, v1 } = seed();
    expect(resolveVersion(lib, prompt.id, { version: 1 }).version.id).toBe(v1.id);
  });

  it("resolves branch heads and numbered versions on a named branch", () => {
    const { prompt, branchV1 } = seed();
    const head = resolveVersion(lib, prompt.id, { branch: "concise" });
    expect(head.version.id).toBe(branchV1.id);
    expect(head.label).toBe("concise v1");
    expect(resolveVersion(lib, prompt.id, { branch: "CONCISE", version: 1 }).version.id).toBe(branchV1.id);
  });

  it("resolves an active version by immutable id and scopes it to the prompt", () => {
    const { prompt, v1 } = seed();
    const other = lib.createPrompt({ title: "Other", content: "other" });

    expect(resolveVersion(lib, prompt.id, { versionId: v1.id }).version.id).toBe(v1.id);
    expect(() =>
      resolveVersion(lib, prompt.id, { versionId: other.current_version_id! }),
    ).toThrow(/No active version with id/);
  });

  it("rejects an immutable id combined with a mutable selector", () => {
    const { prompt, v1 } = seed();

    expect(() => resolveVersion(lib, prompt.id, { versionId: v1.id, version: 1 })).toThrow(
      /cannot be combined/i,
    );
    expect(() => resolveVersion(lib, prompt.id, { versionId: v1.id, branch: "main" })).toThrow(
      /cannot be combined/i,
    );
  });

  it("never returns pending suggestions", () => {
    const { prompt, v2 } = seed();
    lib.suggestVariation({
      promptId: prompt.id,
      baseVersionId: v2.id,
      newContent: "pending",
      rationale: "r",
      branchName: "agent-branch",
    });
    expect(() => resolveVersion(lib, prompt.id, { branch: "agent-branch" })).toThrow(/No branch/);
    expect(resolveVersion(lib, prompt.id).version.id).toBe(v2.id);
  });

  it("errors on unknown version numbers and branches", () => {
    const { prompt } = seed();
    expect(() => resolveVersion(lib, prompt.id, { version: 99 })).toThrow(/No version v99/);
    expect(() => resolveVersion(lib, prompt.id, { branch: "nope" })).toThrow(/No branch "nope"/);
  });
});
