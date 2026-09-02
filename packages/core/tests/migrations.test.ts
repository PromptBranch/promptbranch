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

/** Rewinds a latest-schema fixture so migrations v9 and later run again. */
function rewindBeforeV9(db: Database.Database): void {
  db.prepare("DROP TRIGGER IF EXISTS sync_prompt_tombstone_del").run();
  db.prepare("DROP TABLE IF EXISTS sync_prompt_tombstones").run();
  db.pragma("user_version = 8");
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
    rewindBeforeV9(first.db);
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
    rewindBeforeV9(first.db);
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
    rewindBeforeV9(first.db);
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

  it("records local prompt hard deletes even while ordinary sync capture is guarded", () => {
    const db = openMemoryDatabase();
    db.prepare(
      `INSERT INTO prompts (id, title, created_at, updated_at)
       VALUES ('local-deleted', 'Local deleted', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z')`,
    ).run();
    db.prepare("DELETE FROM sync_dirty").run();
    db.prepare("INSERT INTO sync_meta (key, value) VALUES ('applying', '1')").run();

    db.prepare("DELETE FROM prompts WHERE id = 'local-deleted'").run();

    expect(
      db.prepare("SELECT prompt_id FROM sync_prompt_tombstones").all(),
    ).toEqual([{ prompt_id: "local-deleted" }]);
    expect(
      db.prepare("SELECT 1 FROM sync_dirty WHERE table_name = 'prompts'").get(),
    ).toBeUndefined();
    db.close();
  });

  it("migration 10 backfills prompt tombstones and removes already-resurrected aggregates", () => {
    const dbPath = tmpDbPath();
    const first = openDatabase(dbPath);
    const lib = new PromptLibrary(first.db);
    const historical = lib.createPrompt({ title: "Historical delete", content: "v1" });
    const pending = lib.createPrompt({ title: "Pending delete", content: "v1" });
    const historicalVersion = historical.current_version_id!;
    const pendingVersion = pending.current_version_id!;
    const orphanVersion = "historical-orphan-version";
    lib.addNote({ promptId: historical.id, versionId: historicalVersion, body: "remove" });
    lib.addRating({ targetType: "prompt", targetId: historical.id, effectiveness: 4 });
    lib.addRating({ targetType: "version", targetId: pendingVersion, clarity: 4 });
    lib.addRun({ promptId: pending.id, versionId: pendingVersion });
    first.db
      .prepare(
        `INSERT INTO ratings (id, target_type, target_id, effectiveness, created_at)
         VALUES ('historical-orphan-rating', 'version', ?, 5, '2026-09-02T00:00:00.000Z')`,
      )
      .run(orphanVersion);
    lib.recordSharedSnapshot({
      snapshotId: "HISTORICAL_DELETE_SHARE",
      promptId: historical.id,
      portalBaseUrl: "https://promptbranch.app",
      url: "https://promptbranch.app/p/HISTORICAL_DELETE_SHARE",
      deleteToken: "historical-token",
      fullHistory: false,
      publishedAt: "2026-09-02T00:00:00.000Z",
    });
    lib.recordSharedSnapshot({
      snapshotId: "PENDING_DELETE_SHARE",
      promptId: pending.id,
      portalBaseUrl: "https://promptbranch.app",
      url: "https://promptbranch.app/p/PENDING_DELETE_SHARE",
      deleteToken: "pending-token",
      fullHistory: false,
      publishedAt: "2026-09-02T00:00:00.000Z",
    });
    first.db.prepare("DELETE FROM sync_dirty").run();
    first.db.prepare("DROP TRIGGER IF EXISTS sync_prompt_tombstone_del").run();
    first.db.prepare("DROP TABLE IF EXISTS sync_prompt_tombstones").run();
    first.db.pragma("user_version = 9");
    first.db
      .prepare(
        `INSERT INTO sync_ops
           (source_device_id, seq, op_id, table_name, record_id, kind, payload_json, hlc, created_at)
         VALUES ('old-device', 1, 'historical-prompt-delete', 'prompts', ?, 'delete', NULL,
                 '0000000002000:000000', '2026-09-02T00:00:00.000Z')`,
      )
      .run(historical.id);
    first.db
      .prepare(
        `INSERT INTO sync_ops
           (source_device_id, seq, op_id, table_name, record_id, kind, payload_json, hlc, created_at)
         VALUES ('old-device', 2, 'historical-version-upsert', 'versions', ?, 'upsert', ?,
                 '0000000001000:000000', '2026-09-02T00:00:00.000Z')`,
      )
      .run(orphanVersion, JSON.stringify({ id: orphanVersion, prompt_id: historical.id }));
    first.db
      .prepare(
        `INSERT INTO sync_ops
           (source_device_id, seq, op_id, table_name, record_id, kind, payload_json, hlc, created_at)
         VALUES
           ('old-device', 3, 'historical-share-revoke-later', 'shared_snapshots',
            'HISTORICAL_DELETE_SHARE', 'upsert', ?, '0000000004000:000000',
            '2026-09-02T00:00:00.000Z'),
           ('old-device', 4, 'historical-share-revoke-earlier', 'shared_snapshots',
            'HISTORICAL_DELETE_SHARE', 'upsert', ?, '0000000003000:000000',
            '2026-09-02T00:00:00.000Z')`,
      )
      .run(
        JSON.stringify({ deleted_at: "2026-09-02T02:00:00.000Z" }),
        JSON.stringify({ deleted_at: "2026-09-02T01:00:00.000Z" }),
      );
    first.db
      .prepare("INSERT INTO sync_dirty (table_name, record_id, kind) VALUES ('prompts', ?, 'delete')")
      .run(pending.id);
    first.db
      .prepare(
        `INSERT INTO sync_pending_pointers (prompt_id, version_id, hlc)
         VALUES (?, ?, '0000000003000:000000'), (?, ?, '0000000003000:000001')`,
      )
      .run(historical.id, historicalVersion, pending.id, pendingVersion);
    first.db.close();

    const migrated = openDatabase(dbPath);
    expect(migrated.db.pragma("user_version", { simple: true })).toBe(10);
    expect(
      migrated.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'sync_ops_record_lookup'")
        .get(),
    ).toBeDefined();
    expect(
      migrated.db
        .prepare("SELECT prompt_id FROM sync_prompt_tombstones ORDER BY prompt_id")
        .all(),
    ).toEqual(
      [historical.id, pending.id]
        .sort()
        .map((prompt_id) => ({ prompt_id })),
    );
    for (const promptId of [historical.id, pending.id]) {
      expect(migrated.db.prepare("SELECT 1 FROM prompts WHERE id = ?").get(promptId)).toBeUndefined();
      expect(migrated.db.prepare("SELECT 1 FROM branches WHERE prompt_id = ?").get(promptId)).toBeUndefined();
      expect(migrated.db.prepare("SELECT 1 FROM versions WHERE prompt_id = ?").get(promptId)).toBeUndefined();
      expect(migrated.db.prepare("SELECT 1 FROM notes WHERE prompt_id = ?").get(promptId)).toBeUndefined();
      expect(migrated.db.prepare("SELECT 1 FROM runs WHERE prompt_id = ?").get(promptId)).toBeUndefined();
      expect(
        migrated.db.prepare("SELECT 1 FROM sync_pending_pointers WHERE prompt_id = ?").get(promptId),
      ).toBeUndefined();
    }
    expect(
      migrated.db.prepare("SELECT 1 FROM ratings WHERE target_id IN (?, ?, ?, ?)").get(
        historical.id,
        historicalVersion,
        pendingVersion,
        orphanVersion,
      ),
    ).toBeUndefined();
    expect(
      migrated.db
        .prepare(
          `SELECT snapshot_id, prompt_id, delete_token, deleted_at
           FROM shared_snapshots ORDER BY snapshot_id`,
        )
        .all(),
    ).toEqual([
      {
        snapshot_id: "HISTORICAL_DELETE_SHARE",
        prompt_id: null,
        delete_token: "historical-token",
        deleted_at: "2026-09-02T01:00:00.000Z",
      },
      {
        snapshot_id: "PENDING_DELETE_SHARE",
        prompt_id: null,
        delete_token: "pending-token",
        deleted_at: null,
      },
    ]);
    migrated.db.close();
  });
});
