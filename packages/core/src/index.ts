import type BetterSqlite3 from "better-sqlite3";
export type Database = BetterSqlite3.Database;
export { backupDatabase, latestBackup, listBackups, type BackupFile } from "./backup.js";
export { openDatabase, openMemoryDatabase, type OpenDatabaseResult } from "./db.js";
export { LATEST_SCHEMA_VERSION, pendingMigrationCount, runMigrations } from "./migrations.js";
export {
  parseRunMetrics,
  PromptLibrary,
  type ActivityItem,
  type AverageRatings,
  type ImportSummary,
  type ImportTableSummary,
  type JudgeScores,
  type LibraryExport,
  type ListPromptsOptions,
  type PromptSort,
  type RunGroup,
  type RunGroupItem,
  type SearchFilters,
  type SearchResult,
  type SuggestionItem,
  type VersionWithBranch,
} from "./library.js";
export { DB_ENV_VAR, DB_FILENAME, resolveDatabasePath } from "./paths.js";
export { reindexPrompt } from "./reindex.js";
export { compareHlc, formatHlc, parseHlc, type HlcStamp } from "./sync/hlc.js";
export { SyncEngine, type ApplySummary, type RefineSummary, type SyncOp, type SyncPeerRow } from "./sync/engine.js";
export { tableDef, SYNCED_TABLES, type SyncedTableDef, type SyncedTableName } from "./sync/tables.js";
export { formatVersionLabel, resolvePrompt, resolveVersion, type ResolvedVersion } from "./resolve.js";
export {
  extractPromptVariables,
  missingPromptVariables,
  substitutePromptVariables,
  type PromptVariableValue,
} from "./variables.js";
export type {
  BranchRow,
  CollectionPromptRow,
  CollectionRow,
  NoteRow,
  PromptRow,
  PromptTagRow,
  ProviderModelRow,
  ProviderRow,
  RatingRow,
  RatingTargetType,
  RunRow,
  RunStatus,
  SettingRow,
  SharedSnapshotRow,
  TagRow,
  VersionRow,
  VersionSource,
  VersionStatus,
} from "./types.js";
