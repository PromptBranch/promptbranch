import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";

const BACKUP_FILE_RE = /^library-.+\.db$/;

export interface BackupFile {
  path: string;
  mtimeMs: number;
}

/** Lists backup snapshots in `dir`, newest first. Returns [] if dir is missing. */
export function listBackups(dir: string): BackupFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => BACKUP_FILE_RE.test(name))
    .map((name) => {
      const filePath = path.join(dir, name);
      return { path: filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The newest backup snapshot in `dir`, or null if there are none. */
export function latestBackup(dir: string): BackupFile | null {
  return listBackups(dir)[0] ?? null;
}

/**
 * Writes a consistent timestamped snapshot of `db` into `dir` via SQLite
 * `VACUUM INTO` (safe against concurrent readers thanks to WAL mode), then
 * prunes the directory down to the `keep` newest snapshots. Returns the path
 * of the snapshot that was written.
 */
export function backupDatabase(db: BetterSqlite3.Database, dir: string, keep = 10): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Short random suffix: two backups within the same millisecond must not collide.
  const backupPath = path.join(dir, `library-${stamp}-${randomUUID().slice(0, 8)}.db`);
  db.prepare("VACUUM INTO ?").run(backupPath);

  const backups = listBackups(dir);
  for (const stale of backups.slice(Math.max(keep, 0))) {
    fs.rmSync(stale.path, { force: true });
  }
  return backupPath;
}
