import fs from "node:fs";
import Database from "better-sqlite3";
import { LATEST_SCHEMA_VERSION, pendingMigrationCount, runMigrations } from "./migrations.js";

function applyPragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // The CLI/MCP server can write while the desktop app holds the DB open;
  // wait briefly for locks instead of failing immediately.
  db.pragma("busy_timeout = 3000");
}

/**
 * Backs up a database file (main file plus any WAL/SHM sidecars) before
 * running migrations against an existing on-disk database.
 */
function backupDatabaseFile(db: Database.Database, path: string): string {
  // Flush WAL content into the main file so the plain file copy is complete.
  db.pragma("wal_checkpoint(TRUNCATE)");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.backup-${stamp}`;
  fs.copyFileSync(path, backupPath);
  return backupPath;
}

export interface OpenDatabaseResult {
  db: Database.Database;
  /** Path of the pre-migration backup, if one was made. */
  backupPath: string | null;
}

/**
 * Opens (creating if necessary) a database at `path`, applies pragmas, backs
 * up an existing file if migrations are pending, then runs migrations.
 */
export function openDatabase(path: string): OpenDatabaseResult {
  const existed = fs.existsSync(path);
  const db = new Database(path);
  applyPragmas(db);

  let backupPath: string | null = null;
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (existed && currentVersion < LATEST_SCHEMA_VERSION && pendingMigrationCount(db) > 0) {
    backupPath = backupDatabaseFile(db, path);
  }

  runMigrations(db);
  return { db, backupPath };
}

/** Opens an in-memory database with migrations applied. No backups. */
export function openMemoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  applyPragmas(db);
  runMigrations(db);
  return db;
}
