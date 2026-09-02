import type BetterSqlite3 from "better-sqlite3";
import { SyncEngine } from "./engine.js";

/**
 * Repairs the released unique-name split after preserving every captured local
 * write as an immutable op. The caller owns the surrounding migration
 * transaction, so either refinement and reduction both persist or neither do.
 */
export function repairNaturalKeyMerges(db: BetterSqlite3.Database): void {
  const engine = new SyncEngine(db);
  engine.refineDirty();
  engine.repairNaturalKeyMerges();
}
