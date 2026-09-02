import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  openDatabase,
  openMemoryDatabase,
  PromptLibrary,
  SyncEngine,
} from "../src/index.js";
import { SCHEMA_SQL } from "../src/schema.js";

const tmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promptbranch-test-"));
  tmpDirs.push(dir);
  return path.join(dir, "library.db");
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("migrations", () => {
  it("applies the initial schema to a fresh in-memory database", () => {
    const db = openMemoryDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const expected of [
      "prompts",
      "branches",
      "versions",
      "notes",
      "tags",
      "prompt_tags",
      "collections",
      "collection_prompts",
      "ratings",
      "runs",
      "settings",
      "search_index",
    ]) {
      expect(tables).toContain(expected);
    }
    const runColumns = db.pragma("table_info(runs)") as Array<{ name: string }>;
    expect(runColumns.map((column) => column.name)).toContain("prompt_content");
    // WAL is not applicable to in-memory databases; asserted on file DBs below.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("migrating a fresh file DB creates no backup and uses WAL", () => {
    const dbPath = tmpDbPath();
    const { db, backupPath } = openDatabase(dbPath);
    expect(backupPath).toBeNull();
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });

  it("is idempotent when reopening an up-to-date database", () => {
    const dbPath = tmpDbPath();
    const first = openDatabase(dbPath);
    first.db.close();
    const second = openDatabase(dbPath);
    expect(second.backupPath).toBeNull();
    expect(second.db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    second.db.close();
  });

  it("migration 2 adds status/source to versions and defaults existing rows to active/user", () => {
    const dbPath = tmpDbPath();
    // Build an old-shape (schema v1) database by hand.
    const raw = new Database(dbPath);
    raw.exec(SCHEMA_SQL);
    raw.pragma("user_version = 1");
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
        `INSERT INTO versions (id, prompt_id, branch_id, number, content, created_at)
         VALUES ('v1', 'p1', 'b1', 1, 'old content', '2024-01-01T00:00:00Z')`,
      )
      .run();
    raw.close();

    const { db, backupPath } = openDatabase(dbPath);
    expect(backupPath).not.toBeNull(); // pre-migration backup was made
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const version = db.prepare("SELECT * FROM versions WHERE id = 'v1'").get() as {
      status: string;
      source: string;
      content: string;
    };
    expect(version.status).toBe("active");
    expect(version.source).toBe("user");
    expect(version.content).toBe("old content");
    // The library API works on the migrated row.
    const lib = new PromptLibrary(db);
    expect(lib.listVersions("p1")).toHaveLength(1);
    db.close();
  });

  it("sets a busy_timeout so concurrent CLI/MCP writes do not fail immediately", () => {
    const db = openMemoryDatabase();
    expect(db.pragma("busy_timeout", { simple: true })).toBe(3000);
    db.close();
  });

  it("repairs pending provider-model keys written by delimiter-based sync triggers", () => {
    const dbPath = tmpDbPath();
    const first = openDatabase(dbPath);
    const lib = new PromptLibrary(first.db);
    const provider = lib.createProvider({
      type: "ollama",
      driver: "openai-compatible",
      name: "Migrated Ollama",
    });
    lib.setProviderModels(provider.id, [{ modelId: "llama3.2:latest" }]);
    first.db
      .prepare("UPDATE sync_dirty SET record_id = ? WHERE table_name = 'provider_models'")
      .run(`${provider.id}:llama3.2:latest`);
    first.db
      .prepare(
        `INSERT INTO providers (id, type, driver, name, created_at)
         VALUES ('tenant:one', 'ollama', 'openai-compatible', 'Imported Ollama', '2026-09-02T00:00:00.000Z')`,
      )
      .run();
    first.db
      .prepare(
        `INSERT INTO provider_models (provider_id, model_id, display_name, enabled)
         VALUES ('tenant:one', 'llama', 'Imported Llama', 1)`,
      )
      .run();
    first.db
      .prepare(
        `UPDATE sync_dirty SET record_id = 'tenant:one:llama'
         WHERE table_name = 'provider_models' AND record_id = json_array('tenant:one', 'llama')`,
      )
      .run();
    // Re-run only migrations newer than the last shipped sync schema. Once
    // the repair migration exists this models opening its immediate predecessor.
    first.db.pragma(`user_version = ${Math.max(8, LATEST_SCHEMA_VERSION - 1)}`);
    first.db.close();

    const migrated = openDatabase(dbPath);
    const engine = new SyncEngine(migrated.db);
    expect(() => engine.refineDirty()).not.toThrow();
    expect(engine.pendingDirty()).toBe(0);
    expect(engine.opsSince({}).ops).toContainEqual(
      expect.objectContaining({
        table: "provider_models",
        kind: "upsert",
        payload: expect.objectContaining({
          provider_id: "tenant:one",
          model_id: "llama",
        }),
      }),
    );
    migrated.db.close();
  });

  it("repairs JSON-looking legacy composite tombstones without changing their tuple", () => {
    const dbPath = tmpDbPath();
    const first = openDatabase(dbPath);
    first.db
      .prepare(
        `INSERT INTO providers (id, type, driver, name, created_at)
         VALUES (?, 'ollama', 'openai-compatible', 'Legacy JSON-shaped id', ?)`,
      )
      .run('["left', "2026-09-02T00:00:00.000Z");
    first.db
      .prepare(
        `INSERT INTO provider_models (provider_id, model_id, display_name, enabled)
         VALUES (?, ?, 'Legacy model', 1)`,
      )
      .run('["left', 'right","tail"]');
    first.db
      .prepare("DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?")
      .run('["left', 'right","tail"]');

    const legacyRecordId = '["left:right","tail"]';
    first.db
      .prepare(
        `UPDATE sync_dirty SET record_id = ?
         WHERE table_name = 'provider_models' AND kind = 'delete'`,
      )
      .run(legacyRecordId);
    first.db.pragma(`user_version = ${Math.max(8, LATEST_SCHEMA_VERSION - 1)}`);
    first.db.close();

    const migrated = openDatabase(dbPath);
    const engine = new SyncEngine(migrated.db);
    expect(() => engine.refineDirty()).not.toThrow();
    expect(engine.opsSince({}).ops).toContainEqual(
      expect.objectContaining({
        table: "provider_models",
        recordId: JSON.stringify(['["left', 'right","tail"]']),
        kind: "delete",
      }),
    );
    migrated.db.close();
  });

  it("canonicalizes already-refined legacy composite history before serving it", () => {
    const dbPath = tmpDbPath();
    const first = openDatabase(dbPath);
    first.db
      .prepare(
        `INSERT INTO providers (id, type, driver, name, created_at)
         VALUES (?, 'ollama', 'openai-compatible', 'Historical JSON-shaped id', ?)`,
      )
      .run('["left', "2026-09-02T00:00:00.000Z");
    first.db
      .prepare(
        `INSERT INTO provider_models (provider_id, model_id, display_name, enabled)
         VALUES (?, ?, 'Historical model', 1)`,
      )
      .run('["left', 'right","tail"]');
    first.db
      .prepare("DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?")
      .run('["left', 'right","tail"]');
    new SyncEngine(first.db).refineDirty();

    const legacyRecordId = '["left:right","tail"]';
    first.db
      .prepare("UPDATE sync_ops SET record_id = ? WHERE table_name = 'provider_models'")
      .run(legacyRecordId);
    first.db
      .prepare("UPDATE sync_heads SET record_id = ? WHERE table_name = 'provider_models'")
      .run(legacyRecordId);
    first.db.pragma(`user_version = ${Math.max(8, LATEST_SCHEMA_VERSION - 1)}`);
    first.db.close();

    const migrated = openDatabase(dbPath);
    const migratedEngine = new SyncEngine(migrated.db);
    const canonicalRecordId = JSON.stringify(['["left', 'right","tail"]']);
    expect(
      migrated.db
        .prepare("SELECT DISTINCT record_id FROM sync_ops WHERE table_name = 'provider_models'")
        .all(),
    ).toEqual([{ record_id: canonicalRecordId }]);
    expect(
      migrated.db
        .prepare("SELECT record_id FROM sync_heads WHERE table_name = 'provider_models'")
        .get(),
    ).toEqual({ record_id: canonicalRecordId });

    const target = openMemoryDatabase();
    const targetEngine = new SyncEngine(target);
    targetEngine.applyRemote(migratedEngine.opsSince({}).ops);
    expect(
      target
        .prepare(
          "SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?",
        )
        .get('["left', 'right","tail"]'),
    ).toBeUndefined();
    target.close();
    migrated.db.close();
  });
});
