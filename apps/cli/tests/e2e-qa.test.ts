import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, PromptLibrary } from "@promptbranch/core";

/** Release-QA journeys through the built CLI, with a fresh process per call. */
const CLI = path.join(import.meta.dirname, "..", "dist", "index.js");

let tmpDir: string;
let dbPath: string;
let primaryPromptId: string;
let primaryVersionId: string;
let otherVersionId: string;

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, PROMPTBRANCH_DB: dbPath },
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? 1 };
}

function runJson<T>(args: string[]): T {
  const result = run([...args, "--json"]);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptbranch-cli-e2e-qa-"));
  dbPath = path.join(tmpDir, "library.db");

  const { db } = openDatabase(dbPath);
  const lib = new PromptLibrary(db);
  const security = lib.createTag({ name: "security" });
  const production = lib.createCollection({ name: "Production" });

  const primary = lib.createPrompt({
    title: "Security audit 🔐",
    description: "Meticulous application-security review",
    content: "Review {{target}} carefully. Include Unicode evidence: שלום.",
    changeNote: "initial",
    tagIds: [security.id],
  });
  primaryPromptId = primary.id;
  lib.addPromptToCollection(production.id, primary.id);
  const main = lib.listBranches(primary.id)[0]!;
  const v2 = lib.createVersion({
    promptId: primary.id,
    branchId: main.id,
    content: "Review {{target}} ruthlessly. Include Unicode evidence: שלום.",
    changeNote: "stronger review",
  });
  primaryVersionId = v2.id;
  lib.createBranch({
    promptId: primary.id,
    name: "concise",
    fromVersionId: lib.listVersions(primary.id)[0]!.id,
  });
  lib.setCurrentVersion(primary.id, v2.id);
  lib.addNote({ promptId: primary.id, body: "Focus on deserialization boundaries." });

  const other = lib.createPrompt({
    title: "Security audit legacy",
    content: "Review legacy code for obsolete cryptography.",
  });
  otherVersionId = lib.listVersions(other.id)[0]!.id;

  for (let index = 1; index <= 23; index++) {
    const prompt = lib.createPrompt({
      title: `Fixture prompt ${String(index).padStart(2, "0")}`,
      description: index % 2 === 0 ? "Even fixture" : "Odd fixture",
      content: `Fixture body ${index} with boundary marker batch-${index}.`,
    });
    if (index <= 4) lib.addPromptToCollection(production.id, prompt.id, index);
  }
  db.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("promptbranch CLI release QA", () => {
  it("lists a realistic library and combines tag and collection filters", () => {
    const all = runJson<Array<{ title: string }>>(["list"]);
    expect(all).toHaveLength(25);

    const production = runJson<Array<{ title: string }>>(["list", "--collection", "production"]);
    expect(production).toHaveLength(5);
    expect(production.map((row) => row.title)).toContain("Security audit 🔐");

    const filtered = runJson<Array<{ id: string; title: string }>>([
      "list",
      "--tag",
      "SECURITY",
      "--collection",
      "Production",
    ]);
    expect(filtered).toEqual([{ id: primaryPromptId, title: "Security audit 🔐", currentVersionLabel: "v2", updatedAt: expect.any(String) }]);
  });

  it("resolves ids and case-insensitive titles while honoring version and branch", () => {
    const current = runJson<Record<string, unknown>>(["get", primaryPromptId]);
    expect(current).toMatchObject({ versionLabel: "v2", branch: "main", content: expect.stringContaining("ruthlessly") });

    const old = runJson<Record<string, unknown>>(["get", "SECURITY AUDIT 🔐", "--version", "1"]);
    expect(old).toMatchObject({ versionLabel: "v1", branch: "main", content: expect.stringContaining("carefully") });

    const branch = runJson<Record<string, unknown>>(["get", primaryPromptId, "--branch", "CONCISE"]);
    expect(branch).toMatchObject({ versionLabel: "concise v1", branch: "concise" });
  });

  it("reports ambiguous references with actionable candidates", () => {
    const result = run(["get", "security audit"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"security audit" is ambiguous');
    expect(result.stderr).toContain("Security audit 🔐");
    expect(result.stderr).toContain("Security audit legacy");
    expect(result.stderr).not.toMatch(/\n\s+at\s/);
  });

  it("searches version and note content with a hard result limit", () => {
    const noteHit = runJson<Array<{ promptId: string; title: string }>>(["search", "deserialization"]);
    expect(noteHit).toEqual([
      expect.objectContaining({ promptId: primaryPromptId, title: "Security audit 🔐" }),
    ]);

    const limited = runJson<Array<{ title: string }>>(["search", "fixture", "--limit", "3"]);
    expect(limited).toHaveLength(3);
  });

  it("persists version-scoped notes and rejects cross-prompt version ids", () => {
    const note = runJson<{ noteId: string }>([
      "add-note",
      "--prompt",
      primaryPromptId,
      "--version-id",
      primaryVersionId,
      "--body",
      "Verified after a fresh CLI process restart.",
    ]);
    expect(note.noteId).toBeTruthy();

    const rejected = run([
      "add-note",
      "--prompt",
      primaryPromptId,
      "--version-id",
      otherVersionId,
      "--body",
      "must not persist",
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toMatch(/not found on prompt/);

    const { db } = openDatabase(dbPath);
    const lib = new PromptLibrary(db);
    expect(lib.listNotes(primaryPromptId, primaryVersionId).map((row) => row.body)).toContain(
      "Verified after a fresh CLI process restart.",
    );
    expect(lib.listNotes(primaryPromptId).map((row) => row.body)).not.toContain("must not persist");
    db.close();
  });

  it("keeps content suggestions pending and invisible to normal reads", () => {
    const suggestion = runJson<{ status: string; versionId: string }>([
      "suggest",
      "--prompt",
      primaryPromptId,
      "--content",
      "PROPOSED-ONLY-CONTENT that must stay isolated.",
      "--rationale",
      "Release QA isolation check",
    ]);
    expect(suggestion.status).toBe("pending");

    const current = runJson<Record<string, unknown>>(["get", primaryPromptId]);
    expect(current).toMatchObject({ versionId: primaryVersionId, versionLabel: "v2" });
    expect(current.content).not.toContain("PROPOSED-ONLY-CONTENT");
    expect(runJson<unknown[]>(["search", "PROPOSED-ONLY-CONTENT"])).toEqual([]);
    expect(runJson<Array<{ versionId: string }>>(["suggestions"]).map((row) => row.versionId)).toContain(
      suggestion.versionId,
    );
  });

  it.each([
    [["search", "fixture", "--limit", "0"], /limit.*positive integer/i],
    [["get", "Security audit 🔐", "--version", "0"], /version.*positive integer/i],
    [["get", "Security audit 🔐", "--branch", "missing"], /No branch/],
    [["report-run", "--prompt", "Security audit 🔐", "--outcome", "6"], /between 1 and 5/],
    [["add-note", "--prompt", "Security audit 🔐", "--body", ""], /Missing required flag --body/],
    [["suggest", "--prompt", "Security audit 🔐", "--content", ""], /Suggested content must not be empty/],
  ])("rejects invalid input without stack traces: %j", (args, message) => {
    const result = run(args as string[]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message as RegExp);
    expect(result.stderr).not.toMatch(/\n\s+at\s/);
  });
});
