import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, openDatabase, openMemoryDatabase, PromptLibrary } from "../src/index.js";
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
});
