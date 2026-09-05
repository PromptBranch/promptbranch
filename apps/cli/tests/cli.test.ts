import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, PromptLibrary } from "@promptbranch/core";

/**
 * Exercises every CLI command against a temp database by spawning the built
 * dist/index.js with PROMPTBRANCH_DB pointed at the temp file.
 */

const CLI = path.join(import.meta.dirname, "..", "dist", "index.js");
const CLI_PACKAGE_VERSION = (
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

let tmpDir: string;
let dbPath: string;
let promptId: string;
let initialVersionId: string;

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  return runWithDb(args, dbPath);
}

function runWithDb(args: string[], targetDbPath: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, PROMPTBRANCH_DB: targetDbPath },
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptbranch-cli-test-"));
  dbPath = path.join(tmpDir, "library.db");
  const { db } = openDatabase(dbPath);
  const lib = new PromptLibrary(db);
  const prompt = lib.createPrompt({
    title: "Code review",
    description: "Reviews code changes",
    content: "Review the following diff carefully.",
  });
  promptId = prompt.id;
  initialVersionId = prompt.current_version_id!;
  const tag = lib.createTag({ name: "review" });
  lib.addTagToPrompt(prompt.id, tag.id);
  db.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("promptbranch cli", () => {
  it("--version reports the package version without creating a database", () => {
    const versionOnlyDb = path.join(tmpDir, "version-only", "library.db");
    const result = runWithDb(["--version"], versionOnlyDb);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`promptbranch-cli/${CLI_PACKAGE_VERSION}\n`);
    expect(result.stderr).toBe("");
    expect(fs.existsSync(versionOnlyDb)).toBe(false);
  });

  it("db-path is side-effect free and emits valid JSON when requested", () => {
    const pathOnlyDb = path.join(tmpDir, "path-only", "library.db");

    const plain = runWithDb(["db-path"], pathOnlyDb);
    expect(plain.status).toBe(0);
    expect(plain.stdout.trim()).toBe(pathOnlyDb);
    expect(fs.existsSync(pathOnlyDb)).toBe(false);

    const json = runWithDb(["db-path", "--json"], pathOnlyDb);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ path: pathOnlyDb });
    expect(fs.existsSync(pathOnlyDb)).toBe(false);
  });

  it("list shows prompts, filterable by tag, JSON-parseable", () => {
    const rows = runJson<Array<Record<string, unknown>>>(["list"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: promptId, title: "Code review", currentVersionLabel: "v1" });

    const tagged = runJson<Array<Record<string, unknown>>>(["list", "--tag", "review"]);
    expect(tagged).toHaveLength(1);
    // Unknown tag → error, non-zero exit.
    const unknownTag = run(["list", "--tag", "nope-tag"]);
    expect(unknownTag.status).toBe(1);
    expect(unknownTag.stderr).toMatch(/Tag not found/);
  });

  it("get prints raw content (pipeable) and full JSON with --json", () => {
    const plain = run(["get", "code review"]);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toBe("Review the following diff carefully.\n");

    const json = runJson<Record<string, unknown>>(["get", promptId, "--version", "1"]);
    expect(json).toMatchObject({
      id: promptId,
      versionLabel: "v1",
      branch: "main",
      content: "Review the following diff carefully.",
    });
  });

  it("get accepts an immutable version id", () => {
    const json = runJson<Record<string, unknown>>([
      "get",
      promptId,
      "--version-id",
      initialVersionId,
    ]);

    expect(json).toMatchObject({
      id: promptId,
      versionId: initialVersionId,
      content: "Review the following diff carefully.",
    });
  });

  it("rejects an immutable version id combined with a numeric selector", () => {
    const result = run([
      "get",
      promptId,
      "--version-id",
      initialVersionId,
      "--version",
      "1",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cannot be combined/i);
  });

  it("search finds content and respects --limit", () => {
    const rows = runJson<Array<Record<string, unknown>>>(["search", "diff", "--limit", "5"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Code review", currentVersionLabel: "v1" });
  });

  it("report-run writes a run row", () => {
    const payload = runJson<{ runId: string; versionId: string; versionLabel: string }>([
      "report-run",
      "--prompt",
      "Code review",
      "--version-id",
      initialVersionId,
      "--tool",
      "kimi-cli",
      "--model",
      "k2",
      "--outcome",
      "4",
      "--summary",
      "caught two bugs",
    ]);
    expect(payload.versionId).toBe(initialVersionId);
    expect(payload.versionLabel).toBe("v1");

    const { db } = openDatabase(dbPath);
    const lib = new PromptLibrary(db);
    const runs = lib.listRuns(promptId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ tool: "kimi-cli", model: "k2", outcome_rating: 4 });
    db.close();
  });

  it("rejects an out-of-range outcome rating", () => {
    const result = run(["report-run", "--prompt", "Code review", "--outcome", "9"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/outcome/i);
  });

  it("add-note writes a prompt-level note", () => {
    runJson(["add-note", "--prompt", "Code review", "--body", "works well on small diffs"]);
    const { db } = openDatabase(dbPath);
    const lib = new PromptLibrary(db);
    expect(lib.listNotes(promptId).map((n) => n.body)).toContain("works well on small diffs");
    db.close();
  });

  it("suggest --file creates a pending suggestion; suggestions lists it", () => {
    const suggestionFile = path.join(tmpDir, "suggestion.md");
    fs.writeFileSync(suggestionFile, "Review the following diff ruthlessly. Prioritize security issues.\n");

    const payload = runJson<{ status: string; branch: string; versionId: string }>([
      "suggest",
      "--prompt",
      "Code review",
      "--file",
      suggestionFile,
      "--base-version-id",
      initialVersionId,
      "--rationale",
      "Security-first ordering found more issues",
    ]);
    expect(payload.status).toBe("pending");
    expect(payload.branch).toMatch(/^agent-\d{8}-/);

    const rows = runJson<Array<Record<string, unknown>>>(["suggestions"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      promptTitle: "Code review",
      rationale: "Security-first ordering found more issues",
      source: "agent",
    });

    // Pending version is invisible to get/listVersions defaults.
    const { db } = openDatabase(dbPath);
    const lib = new PromptLibrary(db);
    expect(lib.listVersions(promptId)).toHaveLength(1);
    expect(lib.getVersion(payload.versionId)?.parent_version_id).toBe(initialVersionId);
    db.close();
  });

  it("rejects competing suggestion content sources without writing a suggestion", () => {
    const suggestionFile = path.join(tmpDir, "competing-suggestion.md");
    fs.writeFileSync(suggestionFile, "Suggestion from file\n");

    const { db: beforeDb } = openDatabase(dbPath);
    const before = new PromptLibrary(beforeDb).listSuggestions().length;
    beforeDb.close();

    const result = run([
      "suggest",
      "--prompt",
      "Code review",
      "--file",
      suggestionFile,
      "--content",
      "Suggestion from flag",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/exactly one of --file or --content/i);

    const { db: afterDb } = openDatabase(dbPath);
    expect(new PromptLibrary(afterDb).listSuggestions()).toHaveLength(before);
    afterDb.close();
  });

  it("fails cleanly with non-zero exit on unknown prompt and unknown command", () => {
    const missing = run(["get", "no-such-prompt"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/No prompt matches/);

    const bad = run(["frobnicate"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/Unknown command/);
  });

  it("help prints usage", () => {
    const result = run(["help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("promptbranch suggest");
  });
});
