import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDatabase, latestBackup, listBackups, openMemoryDatabase, PromptLibrary } from "../src/index.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "promptbranch-backup-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("backupDatabase", () => {
  it("writes a snapshot containing the current data", () => {
    const db = openMemoryDatabase();
    const lib = new PromptLibrary(db);
    lib.createPrompt({ title: "Snapshot me", content: "body" });

    const backupPath = backupDatabase(db, dir);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(path.dirname(backupPath)).toBe(dir);
    expect(path.basename(backupPath)).toMatch(/^library-.+\.db$/);

    const copy = new Database(backupPath, { readonly: true });
    const row = copy.prepare("SELECT title FROM prompts").get() as { title: string };
    expect(row.title).toBe("Snapshot me");
    copy.close();
    db.close();
  });

  it("creates the backup directory if missing", () => {
    const db = openMemoryDatabase();
    const nested = path.join(dir, "a", "b");
    const backupPath = backupDatabase(db, nested);
    expect(fs.existsSync(backupPath)).toBe(true);
    db.close();
  });

  it("prunes to the newest `keep` snapshots", () => {
    const db = openMemoryDatabase();
    for (let i = 0; i < 5; i += 1) {
      backupDatabase(db, dir, 3);
      // Ensure distinct mtimes even on filesystems with coarse granularity.
      const files = listBackups(dir);
      const past = new Date(Date.now() - (10 - i) * 1000);
      for (const f of files) fs.utimesSync(f.path, past, past);
    }
    expect(listBackups(dir)).toHaveLength(3);
    db.close();
  });

  it("reports the newest backup via latestBackup / listBackups", () => {
    expect(latestBackup(dir)).toBeNull();
    expect(listBackups(dir)).toEqual([]);

    const db = openMemoryDatabase();
    const first = backupDatabase(db, dir);
    const second = backupDatabase(db, dir);
    // Make ordering deterministic regardless of mtime granularity.
    const older = new Date(Date.now() - 60_000);
    fs.utimesSync(first, older, older);

    const latest = latestBackup(dir);
    expect(latest?.path).toBe(second);
    expect(listBackups(dir).map((b) => b.path)).toEqual([second, first]);
    db.close();
  });
});
