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
    expect(migrated.db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
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

  it("repairs v10 natural-key tag histories with inverse remaps", () => {
    const tagOps = [
      {
        source_device_id: "device-a",
        seq: 1,
        op_id: "tag-a-upsert",
        table_name: "tags",
        record_id: "tag-a",
        kind: "upsert",
        payload_json: JSON.stringify({ id: "tag-a", name: "prod", color: "#0000aa" }),
        hlc: "0000000001000:000000",
        created_at: "2026-09-02T00:00:00.000Z",
      },
      {
        source_device_id: "device-b",
        seq: 1,
        op_id: "tag-b-upsert",
        table_name: "tags",
        record_id: "tag-b",
        kind: "upsert",
        payload_json: JSON.stringify({ id: "tag-b", name: "prod", color: "#0000bb" }),
        hlc: "0000000002000:000000",
        created_at: "2026-09-02T00:00:00.000Z",
      },
    ];

    const seedReleasedV10 = (dbPath: string, localTagId: "tag-a" | "tag-b") => {
      const seeded = openDatabase(dbPath).db;
      seeded
        .prepare(
          `INSERT INTO prompts (id, title, created_at, updated_at)
           VALUES ('prompt-1', 'Natural key repair', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z')`,
        )
        .run();
      seeded.prepare("INSERT INTO tags (id, name, color) VALUES (?, 'prod', ?)").run(
        localTagId,
        localTagId === "tag-a" ? "#0000aa" : "#0000bb",
      );
      seeded.prepare("INSERT INTO prompt_tags (prompt_id, tag_id) VALUES ('prompt-1', ?)").run(localTagId);
      seeded
        .prepare(
          "INSERT INTO sync_id_remaps (table_name, remote_id, local_id) VALUES ('tags', ?, ?)",
        )
        .run(localTagId === "tag-a" ? "tag-b" : "tag-a", localTagId);
      const insertOp = seeded.prepare(
        `INSERT INTO sync_ops
           (source_device_id, seq, op_id, table_name, record_id, kind, payload_json, hlc, created_at)
         VALUES (@source_device_id, @seq, @op_id, @table_name, @record_id, @kind, @payload_json, @hlc, @created_at)`,
      );
      for (const op of tagOps) insertOp.run(op);
      seeded
        .prepare(
          `INSERT INTO sync_heads (table_name, record_id, hlc, device_id) VALUES
           ('tags', 'tag-a', '0000000001000:000000', 'device-a'),
           ('tags', 'tag-b', '0000000002000:000000', 'device-b')`,
        )
        .run();
      seeded.prepare("DELETE FROM sync_dirty").run();
      // This ordinary local write was captured by the released trigger but
      // not yet refined before the upgrade. It must become a normal immutable
      // op before repair reduces the historical tag component.
      seeded.prepare("INSERT INTO tags (id, name, color) VALUES ('pending-tag', 'pending', '#00cc00')").run();
      seeded.pragma("user_version = 10");
      const verbatimOps = seeded
        .prepare(
          `SELECT source_device_id, seq, op_id, table_name, record_id, kind, payload_json, hlc, created_at
           FROM sync_ops ORDER BY source_device_id, seq`,
        )
        .all();
      seeded.close();
      return verbatimOps;
    };

    const aPath = tmpDbPath();
    const bPath = tmpDbPath();
    const verbatimOps = [seedReleasedV10(aPath, "tag-a"), seedReleasedV10(bPath, "tag-b")];
    const migrated = [openDatabase(aPath), openDatabase(bPath)];

    expect(
      migrated.map(({ db }) =>
        db.prepare("SELECT id, name, color FROM tags WHERE name = 'prod'").all(),
      ),
    ).toEqual([
      [{ id: "tag-a", name: "prod", color: "#0000bb" }],
      [{ id: "tag-a", name: "prod", color: "#0000bb" }],
    ]);

    for (const [index, { db, backupPath }] of migrated.entries()) {
      const expectedOps = verbatimOps[index]!;
      expect(backupPath).not.toBeNull();
      expect(fs.existsSync(backupPath!)).toBe(true);
      expect(db.pragma("user_version", { simple: true })).toBe(11);
      expect(db.prepare("SELECT prompt_id, tag_id FROM prompt_tags").all()).toEqual([
        { prompt_id: "prompt-1", tag_id: "tag-a" },
      ]);
      expect(db.prepare("SELECT id, name, color FROM tags WHERE id = 'pending-tag'").all()).toEqual([
        { id: "pending-tag", name: "pending", color: "#00cc00" },
      ]);
      expect(
        db
          .prepare(
            "SELECT kind, payload_json FROM sync_ops WHERE table_name = 'tags' AND record_id = 'pending-tag'",
          )
          .all(),
      ).toEqual([
        {
          kind: "upsert",
          payload_json: JSON.stringify({ id: "pending-tag", name: "pending", color: "#00cc00" }),
        },
      ]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM sync_dirty").get()).toEqual({ count: 0 });
      expect(
        db
          .prepare("SELECT record_id, hlc, device_id FROM sync_heads WHERE table_name = 'tags' AND record_id = 'tag-a'")
          .all(),
      ).toEqual([{ record_id: "tag-a", hlc: "0000000002000:000000", device_id: "device-b" }]);
      expect(
        db.prepare("SELECT remote_id, local_id FROM sync_id_remaps WHERE table_name = 'tags'").all(),
      ).toEqual([{ remote_id: "tag-b", local_id: "tag-a" }]);
      expect(
        db
          .prepare(
            `SELECT source_device_id, seq, op_id, table_name, record_id, kind, payload_json, hlc, created_at
             FROM sync_ops WHERE source_device_id IN ('device-a', 'device-b') ORDER BY source_device_id, seq`,
          )
          .all(),
      ).toEqual(expectedOps);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const repaired = {
        tags: db.prepare("SELECT id, name, color FROM tags ORDER BY id").all(),
        promptTags: db.prepare("SELECT prompt_id, tag_id FROM prompt_tags ORDER BY prompt_id, tag_id").all(),
        heads: db
          .prepare("SELECT table_name, record_id, hlc, device_id FROM sync_heads ORDER BY table_name, record_id")
          .all(),
        remaps: db.prepare("SELECT table_name, remote_id, local_id FROM sync_id_remaps ORDER BY table_name, remote_id").all(),
      };
      db.close();

      const reopened = openDatabase(index === 0 ? aPath : bPath);
      expect(reopened.backupPath).toBeNull();
      expect(reopened.db.pragma("user_version", { simple: true })).toBe(11);
      expect({
        tags: reopened.db.prepare("SELECT id, name, color FROM tags ORDER BY id").all(),
        promptTags: reopened.db.prepare("SELECT prompt_id, tag_id FROM prompt_tags ORDER BY prompt_id, tag_id").all(),
        heads: reopened.db
          .prepare("SELECT table_name, record_id, hlc, device_id FROM sync_heads ORDER BY table_name, record_id")
          .all(),
        remaps: reopened.db
          .prepare("SELECT table_name, remote_id, local_id FROM sync_id_remaps ORDER BY table_name, remote_id")
          .all(),
      }).toEqual(repaired);
      reopened.db.close();
    }
  });

  it("compresses v10 tag remap chains and reciprocal edges directly to the minimum id", () => {
    const dbPath = tmpDbPath();
    const seeded = openDatabase(dbPath).db;
    seeded.prepare("INSERT INTO tags (id, name, color) VALUES ('tag-a', 'prod', '#112233')").run();
    seeded
      .prepare(
        `INSERT INTO sync_id_remaps (table_name, remote_id, local_id) VALUES
           ('tags', 'tag-c', 'tag-b'),
           ('tags', 'tag-b', 'tag-a'),
           ('tags', 'tag-a', 'tag-c')`,
      )
      .run();
    seeded.prepare("DELETE FROM sync_dirty").run();
    seeded.pragma("user_version = 10");
    seeded.close();

    const migrated = openDatabase(dbPath);
    expect(migrated.db.pragma("user_version", { simple: true })).toBe(11);
    expect(
      migrated.db
        .prepare("SELECT remote_id, local_id FROM sync_id_remaps WHERE table_name = 'tags' ORDER BY remote_id")
        .all(),
    ).toEqual([
      { remote_id: "tag-b", local_id: "tag-a" },
      { remote_id: "tag-c", local_id: "tag-a" },
    ]);
    expect(
      migrated.db
        .prepare("SELECT 1 FROM sync_id_remaps WHERE table_name = 'tags' AND remote_id = local_id")
        .all(),
    ).toEqual([]);
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.db.close();
  });

  it("keeps terminally deleted prompt aggregates absent while repairing v10 history", () => {
    const dbPath = tmpDbPath();
    const seeded = openDatabase(dbPath).db;
    const library = new PromptLibrary(seeded);
    const prompt = library.createPrompt({ title: "Terminal history", content: "v1" });
    const tag = library.createTag({ name: "Terminal tag" });
    const collection = library.createCollection({ name: "Terminal collection" });
    library.addTagToPrompt(prompt.id, tag.id);
    library.addPromptToCollection(collection.id, prompt.id, 7);
    const engine = new SyncEngine(seeded);
    engine.refineDirty(100);

    engine.applyRemote([
      {
        source: "remote-delete",
        seq: 1,
        opId: "terminal-prompt-delete",
        table: "prompts",
        recordId: prompt.id,
        kind: "delete",
        payload: null,
        hlc: "0000000000200:000000",
        createdAt: "2026-09-03T00:00:00.000Z",
      },
    ]);

    expect(seeded.prepare("SELECT 1 FROM prompts WHERE id = ?").get(prompt.id)).toBeUndefined();
    expect(seeded.prepare("SELECT 1 FROM branches WHERE prompt_id = ?").get(prompt.id)).toBeUndefined();
    expect(seeded.prepare("SELECT 1 FROM versions WHERE prompt_id = ?").get(prompt.id)).toBeUndefined();
    expect(seeded.prepare("SELECT 1 FROM prompt_tags WHERE prompt_id = ?").get(prompt.id)).toBeUndefined();
    expect(seeded.prepare("SELECT 1 FROM collection_prompts WHERE prompt_id = ?").get(prompt.id)).toBeUndefined();
    const history = seeded
      .prepare(
        `SELECT source_device_id, seq, op_id, table_name, record_id, kind, payload_json, hlc, created_at
         FROM sync_ops ORDER BY source_device_id, seq`,
      )
      .all();
    const descendantHeads = seeded
      .prepare(
        `SELECT table_name, record_id, hlc, device_id
         FROM sync_heads
         WHERE table_name IN ('branches', 'versions', 'prompt_tags', 'collection_prompts')
         ORDER BY table_name, record_id`,
      )
      .all();
    seeded.pragma("user_version = 10");
    seeded.close();

    const migrated = openDatabase(dbPath);
    expect(migrated.db.pragma("user_version", { simple: true })).toBe(11);
    expect(migrated.db.prepare("SELECT 1 FROM prompts WHERE id = ?").get(prompt.id)).toBeUndefined();
    expect(migrated.db.prepare("SELECT 1 FROM branches WHERE prompt_id = ?").get(prompt.id)).toBeUndefined();
    expect(migrated.db.prepare("SELECT 1 FROM versions WHERE prompt_id = ?").get(prompt.id)).toBeUndefined();
    expect(migrated.db.prepare("SELECT 1 FROM prompt_tags WHERE prompt_id = ?").get(prompt.id)).toBeUndefined();
    expect(migrated.db.prepare("SELECT 1 FROM collection_prompts WHERE prompt_id = ?").get(prompt.id)).toBeUndefined();
    expect(migrated.db.prepare("SELECT prompt_id FROM sync_prompt_tombstones").all()).toContainEqual({ prompt_id: prompt.id });
    expect(
      migrated.db
        .prepare(
          `SELECT table_name, record_id, hlc, device_id
           FROM sync_heads
           WHERE table_name IN ('branches', 'versions', 'prompt_tags', 'collection_prompts')
           ORDER BY table_name, record_id`,
        )
        .all(),
    ).toEqual(descendantHeads);
    expect(
      migrated.db
        .prepare(
          `SELECT source_device_id, seq, op_id, table_name, record_id, kind, payload_json, hlc, created_at
           FROM sync_ops ORDER BY source_device_id, seq`,
        )
        .all(),
    ).toEqual(history);
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.db.close();
  });
});
