import Database from "better-sqlite3";

const [databasePath, promptId, branchId, parentVersionId, holdMillisecondsText] =
  process.argv.slice(2);
const holdMilliseconds = Number(holdMillisecondsText);

if (
  !databasePath ||
  !promptId ||
  !branchId ||
  !parentVersionId ||
  !Number.isInteger(holdMilliseconds) ||
  holdMilliseconds < 1
) {
  throw new Error("Expected database path, prompt, branch, parent version, and lock duration");
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

  setTimeout(() => {
    try {
      db.exec("COMMIT");
      process.stdout.write("released\n");
      db.close();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
  }, holdMilliseconds);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  db.close();
  process.exitCode = 1;
}
