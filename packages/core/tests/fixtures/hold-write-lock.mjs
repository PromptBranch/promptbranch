import Database from "better-sqlite3";
import fs from "node:fs";

const [databasePath, promptId, branchId, parentVersionId, releasePath] = process.argv.slice(2);

if (
  !databasePath ||
  !promptId ||
  !branchId ||
  !parentVersionId ||
  !releasePath
) {
  throw new Error("Expected database path, prompt, branch, parent version, and release path");
}

const concurrentVersionId = "concurrent-writer-version";
const db = new Database(databasePath);
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 3000");

try {
  db.exec("BEGIN IMMEDIATE");
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO versions
       (id, prompt_id, branch_id, parent_version_id, number, content, created_at)
     VALUES (?, ?, ?, ?, 2, 'concurrent writer content', ?)`,
  ).run(concurrentVersionId, promptId, branchId, parentVersionId, createdAt);
  db.prepare(
    "UPDATE prompts SET current_version_id = ?, updated_at = ? WHERE id = ?",
  ).run(concurrentVersionId, createdAt, promptId);
  process.stdout.write("locked\n");

  const release = () => {
    if (!fs.existsSync(releasePath)) return;
    if (fs.readFileSync(releasePath, "utf8").trim() !== "release") return;
    fs.unwatchFile(releasePath);
    try {
      db.exec("COMMIT");
      db.close();
      process.stdout.write("released\n", () => process.exit(0));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    }
  };
  fs.watchFile(releasePath, { interval: 10 }, release);
  release();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  db.close();
  process.exitCode = 1;
}
