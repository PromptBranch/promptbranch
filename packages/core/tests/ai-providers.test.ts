import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  PromptLibrary,
  openDatabase,
  openMemoryDatabase,
} from "../src/index.js";
import { SCHEMA_SQL } from "../src/schema.js";

const tmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promptbranch-ai-test-"));
  tmpDirs.push(dir);
  return path.join(dir, "library.db");
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function makeLibrary(): { db: Database.Database; lib: PromptLibrary } {
  const db = openMemoryDatabase();
  return { db, lib: new PromptLibrary(db) };
}

/** Creates a prompt with one version; returns ids for run inserts. */
function seedPrompt(lib: PromptLibrary): { promptId: string; versionId: string } {
  const prompt = lib.createPrompt({ title: "Greeting", content: "Say hi to {{name}}" });
  return { promptId: prompt.id, versionId: prompt.current_version_id! };
}

describe("migration 3", () => {
  it("upgrades an old-shape DB: runs gain AI columns, provider tables appear", () => {
    const dbPath = tmpDbPath();
    const raw = new Database(dbPath);
    raw.exec(SCHEMA_SQL);
    raw.exec(`
      ALTER TABLE versions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE versions ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
    `);
    raw.pragma("user_version = 2");
    raw
      .prepare(
        "INSERT INTO prompts (id, title, created_at, updated_at) VALUES ('p1', 'Old', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO branches (id, prompt_id, name, created_at) VALUES ('b1', 'p1', 'main', '2024-01-01T00:00:00Z')",
      )
      .run();
    raw
      .prepare(
        `INSERT INTO versions (id, prompt_id, branch_id, number, content, status, source, created_at)
         VALUES ('v1', 'p1', 'b1', 1, 'old content', 'active', 'user', '2024-01-01T00:00:00Z')`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO runs (id, prompt_id, version_id, tool, model, outcome_rating, result_summary, metrics_json, started_at, created_at)
         VALUES ('r1', 'p1', 'v1', 'manual', 'gpt-4o', 4, 'worked', NULL, NULL, '2024-01-01T00:00:00Z')`,
      )
      .run();
    raw.close();

    const { db } = openDatabase(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("providers");
    expect(tables).toContain("provider_models");

    const run = db.prepare("SELECT * FROM runs WHERE id = 'r1'").get() as Record<string, unknown>;
    // Existing rows default sensibly.
    expect(run["status"]).toBe("completed");
    expect(run["provider"]).toBeNull();
    expect(run["output"]).toBeNull();
    expect(run["error"]).toBeNull();
    expect(run["latency_ms"]).toBeNull();
    expect(run["run_group_id"]).toBeNull();
    // Pre-existing columns untouched.
    expect(run["model"]).toBe("gpt-4o");
    expect(run["outcome_rating"]).toBe(4);
    db.close();
  });
});

describe("migration 4", () => {
  it("upgrades a v3-shape DB: providers gain driver, backfilled from type", () => {
    const dbPath = tmpDbPath();
    const raw = new Database(dbPath);
    raw.exec(SCHEMA_SQL);
    raw.exec(`
      ALTER TABLE versions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE versions ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE runs ADD COLUMN provider TEXT;
      ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
      ALTER TABLE runs ADD COLUMN output TEXT;
      ALTER TABLE runs ADD COLUMN error TEXT;
      ALTER TABLE runs ADD COLUMN latency_ms INTEGER;
      ALTER TABLE runs ADD COLUMN run_group_id TEXT;
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        api_key_enc TEXT,
        base_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE provider_models (
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        display_name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (provider_id, model_id)
      );
    `);
    raw.pragma("user_version = 3");
    raw
      .prepare(
        "INSERT INTO providers (id, type, name, created_at) VALUES ('pr1', 'openai', 'My OpenAI', '2024-01-01T00:00:00Z')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO providers (id, type, name, created_at) VALUES ('pr2', 'openai-compatible', 'Local', '2024-01-01T00:00:00Z')",
      )
      .run();
    raw.close();

    const { db } = openDatabase(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const rows = db.prepare("SELECT id, type, driver FROM providers ORDER BY id").all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toEqual([
      { id: "pr1", type: "openai", driver: "openai" },
      { id: "pr2", type: "openai-compatible", driver: "openai-compatible" },
    ]);
    // New inserts through the library carry an explicit driver.
    const lib = new PromptLibrary(db);
    const generic = lib.createProvider({ type: "groq", driver: "openai-compatible", name: "Groq" });
    expect(generic.driver).toBe("openai-compatible");
    db.close();
  });
});

describe("provider CRUD", () => {
  it("creates, lists, updates and deletes providers", () => {
    const { lib } = makeLibrary();
    const provider = lib.createProvider({
      type: "openai",
      name: "My OpenAI",
      apiKeyEnc: "enc:blob",
    });
    expect(provider.id).toBeTruthy();
    expect(provider.api_key_enc).toBe("enc:blob");
    expect(provider.enabled).toBe(1);

    expect(lib.listProviders()).toHaveLength(1);
    expect(lib.getProvider(provider.id)?.name).toBe("My OpenAI");

    const updated = lib.updateProvider(provider.id, { name: "Renamed", enabled: false });
    expect(updated.name).toBe("Renamed");
    expect(updated.enabled).toBe(0);

    // Clearing the key stores NULL.
    expect(lib.updateProvider(provider.id, { apiKeyEnc: null }).api_key_enc).toBeNull();

    lib.deleteProvider(provider.id);
    expect(lib.listProviders()).toHaveLength(0);
    expect(() => lib.deleteProvider(provider.id)).toThrow(/Provider not found/);
  });

  it("defaults driver to type and stores an explicit driver for catalog providers", () => {
    const { lib } = makeLibrary();
    expect(lib.createProvider({ type: "openai", name: "x" }).driver).toBe("openai");
    const groq = lib.createProvider({ type: "groq", driver: "openai-compatible", name: "Groq" });
    expect(groq.driver).toBe("openai-compatible");
    expect(lib.getProvider(groq.id)?.driver).toBe("openai-compatible");
  });

  it("validates input", () => {
    const { lib } = makeLibrary();
    expect(() => lib.createProvider({ type: "", name: "x" })).toThrow(/type/);
    expect(() => lib.createProvider({ type: "openai", name: " " })).toThrow(/name/);
    const provider = lib.createProvider({ type: "openai", name: "x" });
    expect(() => lib.updateProvider(provider.id, { name: "" })).toThrow(/name/);
    expect(() => lib.updateProvider("missing", { name: "y" })).toThrow(/Provider not found/);
  });

  it("deleting a provider cascades its models but never touches runs", () => {
    const { lib } = makeLibrary();
    const { promptId, versionId } = seedPrompt(lib);
    const provider = lib.createProvider({ type: "openai", name: "p" });
    lib.setProviderModels(provider.id, [
      { modelId: "gpt-4o-mini" },
      { modelId: "gpt-4o", displayName: "GPT-4o", enabled: false },
    ]);
    expect(lib.listProviderModels(provider.id)).toHaveLength(2);
    expect(lib.listProviderModels(provider.id, { enabledOnly: true }).map((m) => m.model_id)).toEqual([
      "gpt-4o-mini",
    ]);

    const run = lib.recordModelRun({
      promptId,
      versionId,
      provider: provider.id,
      model: "gpt-4o-mini",
      status: "completed",
      output: "hello",
    });
    lib.deleteProvider(provider.id);
    expect(lib.listProviderModels(provider.id)).toHaveLength(0);
    // The run survives with its provider id intact (now dangling by design).
    expect(lib.listRuns(promptId).map((r) => r.id)).toEqual([run.id]);
    expect(lib.listRuns(promptId)[0]!.provider).toBe(provider.id);
  });

  it("setProviderModels replaces the full set", () => {
    const { lib } = makeLibrary();
    const provider = lib.createProvider({ type: "google", name: "g" });
    lib.setProviderModels(provider.id, [{ modelId: "a" }, { modelId: "b" }]);
    lib.setProviderModels(provider.id, [{ modelId: "c", displayName: "C" }]);
    const models = lib.listProviderModels(provider.id);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ model_id: "c", display_name: "C", enabled: 1 });
    expect(() => lib.setProviderModels("missing", [])).toThrow(/Provider not found/);
    expect(() => lib.setProviderModels(provider.id, [{ modelId: " " }])).toThrow(/Model id/);
  });
});

describe("catalog cache", () => {
  it("round-trips the raw catalog payload through settings", () => {
    const { lib } = makeLibrary();
    expect(lib.getCatalogCache()).toBeNull();
    lib.setCatalogCache('{"openai":[]}');
    const first = lib.getCatalogCache();
    expect(first?.json).toBe('{"openai":[]}');
    expect(first?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    lib.setCatalogCache('{"openai":[{"id":"x"}]}');
    expect(lib.getCatalogCache()?.json).toBe('{"openai":[{"id":"x"}]}');
  });
});

describe("model runs", () => {
  it("recordModelRun persists the new columns", () => {
    const { lib } = makeLibrary();
    const { promptId, versionId } = seedPrompt(lib);
    const provider = lib.createProvider({ type: "openai", name: "p" });

    const okRun = lib.recordModelRun({
      promptId,
      versionId,
      provider: provider.id,
      model: "gpt-4o-mini",
      status: "completed",
      output: "Hello  world,\nhow are you?",
      latencyMs: 812,
      runGroupId: "group-1",
      metrics: { usage: { inputTokens: 12, outputTokens: 7 }, costUsd: 0.000006 },
    });
    expect(okRun.tool).toBe("prompthub-run");
    expect(okRun.status).toBe("completed");
    expect(okRun.output).toBe("Hello  world,\nhow are you?");
    expect(okRun.result_summary).toBe("Hello world, how are you?");
    expect(okRun.latency_ms).toBe(812);
    expect(okRun.run_group_id).toBe("group-1");
    expect(JSON.parse(okRun.metrics_json!)).toEqual({
      usage: { inputTokens: 12, outputTokens: 7 },
      costUsd: 0.000006,
    });

    const failRun = lib.recordModelRun({
      promptId,
      versionId,
      provider: provider.id,
      model: "gpt-4o",
      status: "error",
      error: "Provider request failed (HTTP 401)",
      latencyMs: 120,
      runGroupId: "group-1",
    });
    expect(failRun.status).toBe("error");
    expect(failRun.error).toMatch(/HTTP 401/);
    expect(failRun.output).toBeNull();
  });

  it("validates the status/output contract", () => {
    const { lib } = makeLibrary();
    const { promptId, versionId } = seedPrompt(lib);
    const base = { promptId, versionId, provider: "p", model: "m" };
    expect(() => lib.recordModelRun({ ...base, status: "completed" })).toThrow(/output/);
    expect(() => lib.recordModelRun({ ...base, status: "error" })).toThrow(/error/);
    expect(() =>
      lib.recordModelRun({ ...base, status: "weird" as never, output: "x" }),
    ).toThrow(/status/);
  });

  it("listRuns filters by run group", () => {
    const { lib } = makeLibrary();
    const { promptId, versionId } = seedPrompt(lib);
    lib.addRun({ promptId, versionId });
    lib.recordModelRun({ promptId, versionId, provider: "p", model: "a", status: "completed", output: "1", runGroupId: "g1" });
    lib.recordModelRun({ promptId, versionId, provider: "p", model: "b", status: "completed", output: "2", runGroupId: "g1" });
    expect(lib.listRuns(promptId)).toHaveLength(3);
    expect(lib.listRuns(promptId, { runGroupId: "g1" })).toHaveLength(2);
    expect(lib.listRuns(promptId, { runGroupId: "nope" })).toHaveLength(0);
  });

  it("updateRunOutcome sets and clears the outcome rating", () => {
    const { lib } = makeLibrary();
    const { promptId, versionId } = seedPrompt(lib);
    const run = lib.recordModelRun({
      promptId,
      versionId,
      provider: "p",
      model: "a",
      status: "completed",
      output: "1",
      runGroupId: "g1",
    });
    expect(run.outcome_rating).toBeNull();

    expect(lib.updateRunOutcome(run.id, 4).outcome_rating).toBe(4);
    expect(lib.listRunGroups(promptId)[0]!.runs[0]!.outcomeRating).toBe(4);
    // Null clears the rating again.
    expect(lib.updateRunOutcome(run.id, null).outcome_rating).toBeNull();

    expect(() => lib.updateRunOutcome(run.id, 0)).toThrow(/between 1 and 5/);
    expect(() => lib.updateRunOutcome(run.id, 6)).toThrow(/between 1 and 5/);
    expect(() => lib.updateRunOutcome("missing", 3)).toThrow(/Run not found/);
  });

  it("listRunGroups groups runs with provider names", () => {
    const { lib } = makeLibrary();
    const { promptId, versionId } = seedPrompt(lib);
    const provider = lib.createProvider({ type: "openai", name: "My OpenAI" });
    lib.addRun({ promptId, versionId }); // ungrouped — excluded
    lib.recordModelRun({ promptId, versionId, provider: provider.id, model: "a", status: "completed", output: "1", runGroupId: "g1" });
    lib.recordModelRun({ promptId, versionId, provider: "missing-provider", model: "b", status: "error", error: "x", runGroupId: "g1" });
    lib.recordModelRun({ promptId, versionId, provider: provider.id, model: "c", status: "completed", output: "3", runGroupId: "g2" });

    const groups = lib.listRunGroups(promptId);
    expect(groups.map((g) => g.runGroupId).sort()).toEqual(["g1", "g2"]);
    const g1 = groups.find((g) => g.runGroupId === "g1")!;
    expect(g1.runs).toHaveLength(2);
    expect(g1.runs[0]).toMatchObject({ model: "a", providerName: "My OpenAI", status: "completed", output: "1" });
    // Deleted/unknown providers leave providerName null but keep the run.
    expect(g1.runs[1]).toMatchObject({ model: "b", providerName: null, status: "error", error: "x" });
  });

  it("deletes one result at a time and drops an empty group without deleting saved notes", () => {
    const { lib } = makeLibrary();
    const { promptId, versionId } = seedPrompt(lib);
    const first = lib.recordModelRun({
      promptId,
      versionId,
      provider: "p",
      model: "a",
      status: "completed",
      output: "1",
      runGroupId: "g1",
    });
    const second = lib.recordModelRun({
      promptId,
      versionId,
      provider: "p",
      model: "b",
      status: "completed",
      output: "2",
      runGroupId: "g1",
    });
    const note = lib.addNote({ promptId, versionId, body: "Saved model output" });

    lib.deleteRun(first.id);
    expect(lib.listRunGroups(promptId)[0]?.runs.map((run) => run.id)).toEqual([second.id]);

    lib.deleteRun(second.id);
    expect(lib.listRunGroups(promptId)).toEqual([]);
    expect(lib.listNotes(promptId).map((row) => row.id)).toEqual([note.id]);
  });

  it("listRunGroups parses usage and cost back out of metrics_json", () => {
    const { lib } = makeLibrary();
    const { promptId, versionId } = seedPrompt(lib);
    lib.recordModelRun({
      promptId,
      versionId,
      provider: "p",
      model: "a",
      status: "completed",
      output: "1",
      runGroupId: "g1",
      metrics: { usage: { inputTokens: 12, outputTokens: 7 }, costUsd: 0.000006 },
    });
    lib.recordModelRun({
      promptId,
      versionId,
      provider: "p",
      model: "b",
      status: "error",
      error: "x",
      runGroupId: "g1",
    });

    const g1 = lib.listRunGroups(promptId)[0]!;
    expect(g1.runs[0]).toMatchObject({ usage: { inputTokens: 12, outputTokens: 7 }, costUsd: 0.000006 });
    // Runs without metrics degrade to nulls, never undefined.
    expect(g1.runs[1]).toMatchObject({ usage: null, costUsd: null, judgeRationale: null, judgeScores: null });
  });

  it("listRunGroups surfaces judge rationale and scores from metrics_json", () => {
    const { lib } = makeLibrary();
    const { promptId, versionId } = seedPrompt(lib);
    const run = lib.recordModelRun({
      promptId,
      versionId,
      provider: "p",
      model: "a",
      status: "completed",
      output: "1",
      runGroupId: "g1",
    });
    lib.updateRunMetrics(run.id, {
      judgeRationale: "Direct and usable answer.",
      judgeScores: { effectiveness: 5, clarity: 4, completeness: 4, actionability: 3 },
    });

    const item = lib.listRunGroups(promptId)[0]!.runs[0]!;
    expect(item.judgeRationale).toBe("Direct and usable answer.");
    expect(item.judgeScores).toEqual({ effectiveness: 5, clarity: 4, completeness: 4, actionability: 3 });

    // Corrupt/partial judge blobs degrade to null, never throw.
    lib.updateRunMetrics(run.id, { judgeScores: { effectiveness: 5 } });
    expect(lib.listRunGroups(promptId)[0]!.runs[0]!.judgeScores).toBeNull();
  });
});
