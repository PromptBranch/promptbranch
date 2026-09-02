import type BetterSqlite3 from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { syncMigrationSql, syncV7Sql, syncV9Sql, syncV10Sql } from "./sync/tables.js";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Forward-only, numbered migrations. Applied in order; the highest applied
 * version is tracked in SQLite's `user_version` pragma.
 */
const migrations: Migration[] = [
  { version: 1, name: "initial-schema", sql: SCHEMA_SQL },
  // Version lifecycle + provenance for agent-suggested variations. Existing
  // rows become active/user, preserving pre-migration behavior exactly.
  {
    version: 2,
    name: "version-status-source",
    sql: `
ALTER TABLE versions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE versions ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
`,
  },
  // AI run bookkeeping + provider configuration. Existing runs were all
  // manual completions, so they backfill to status 'completed'.
  {
    version: 3,
    name: "ai-providers-and-run-results",
    sql: `
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
`,
  },
  // Driver model: `type` becomes the models.dev catalog id (e.g. 'groq'),
  // `driver` decides execution ('openai'|'anthropic'|'google'|
  // 'openai-compatible'). Pre-existing rows all had one of the four original
  // types, which are exactly the driver ids — so driver backfills from type.
  {
    version: 4,
    name: "provider-driver",
    sql: `
ALTER TABLE providers ADD COLUMN driver TEXT NOT NULL DEFAULT 'openai-compatible';
UPDATE providers SET driver = type;
`,
  },
  // Local bookkeeping for published portal snapshots. The delete token is
  // stored plaintext ON PURPOSE: it exists only here (the portal keeps a
  // sha256 hash) and is needed verbatim to revoke the share later. prompt_id
  // is nullable with ON DELETE SET NULL: the share record and its revoke
  // token must survive a hard delete of the prompt (the "(deleted prompt)"
  // DTO fallback in the desktop app anticipates this).
  {
    version: 5,
    name: "shared-snapshots",
    sql: `
CREATE TABLE shared_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  prompt_id TEXT REFERENCES prompts(id) ON DELETE SET NULL,
  portal_base_url TEXT NOT NULL,
  url TEXT NOT NULL,
  delete_token TEXT NOT NULL,
  full_history INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX idx_shared_snapshots_prompt ON shared_snapshots(prompt_id);
`,
  },
  // Multi-device sync storage. Triggers capture every write (from the app,
  // CLI or MCP server — they share this file) into sync_dirty; pure SQL on
  // purpose so older binaries keep working. The sync engine turns dirty rows
  // into ops in sync_ops and exchanges them peer-to-peer. See
  // docs-internal/specs/2026-08-27-sync-design.md.
  {
    version: 6,
    name: "sync-tables-and-triggers",
    sql: syncMigrationSql(),
  },
  // shared_snapshots joins the synced registry (share records + delete
  // tokens travel to paired devices, which already hold the whole library;
  // export files still strip tokens). Triggers plus a one-time enqueue of
  // pre-existing rows, pure SQL for older CLI/MCP binaries.
  {
    version: 7,
    name: "sync-shared-snapshots",
    sql: syncV7Sql(),
  },
  // The version row is only a lineage anchor: users can execute an edited
  // draft with variable values that differ from that immutable version.
  // Existing runs stay nullable so their historical behavior can fall back
  // to version content when the exact execution input was never recorded.
  {
    version: 8,
    name: "run-prompt-content",
    sql: `
ALTER TABLE runs ADD COLUMN prompt_content TEXT;
`,
  },
  {
    version: 9,
    name: "delimiter-safe-sync-record-keys",
    sql: syncV9Sql(),
  },
  {
    version: 10,
    name: "durable-prompt-hard-delete-tombstones",
    sql: syncV10Sql(),
  },
];

export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1]!.version;

/** Returns the number of pending migrations for an open database. */
export function pendingMigrationCount(db: BetterSqlite3.Database): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  return migrations.filter((m) => m.version > current).length;
}

export function runMigrations(db: BetterSqlite3.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
