/**
 * Registry of every table that participates in multi-device sync. One source
 * of truth for three consumers: the v6 migration (dirty-capture triggers),
 * the refine step (row snapshots / record keys) and the apply step (upserts,
 * cascades, FK remapping). Keep parents ahead of children in `rank` — ops
 * are applied in rank order within a batch.
 */

export type SyncedTableName =
  | "tags"
  | "collections"
  | "providers"
  | "provider_models"
  | "prompts"
  | "branches"
  | "versions"
  | "prompt_tags"
  | "collection_prompts"
  | "notes"
  | "ratings"
  | "runs"
  | "shared_snapshots";

export interface SyncedTableDef {
  name: SyncedTableName;
  /** Apply order within a batch; parents before children. */
  rank: number;
  /** Columns carried in op payloads (a full row snapshot). */
  columns: readonly string[];
  /** Primary-key columns; composite for junction tables. */
  pk: readonly string[];
  /**
   * Migration that first added this table to the sync registry — drives
   * which migrations create its dirty-capture triggers. Default 6.
   */
  since?: number;
  /**
   * FK columns whose target tables can be id-remapped after a unique-name
   * merge (tags, collections, branches). Applied to incoming payloads and
   * delete record keys before they touch local rows.
   */
  remappableRefs?: Readonly<Record<string, SyncedTableName>>;
}

export const SYNCED_TABLES: readonly SyncedTableDef[] = [
  { name: "tags", rank: 10, columns: ["id", "name", "color"], pk: ["id"] },
  { name: "collections", rank: 20, columns: ["id", "name", "sort_order"], pk: ["id"] },
  {
    name: "providers",
    rank: 30,
    columns: ["id", "type", "driver", "name", "api_key_enc", "base_url", "enabled", "created_at"],
    pk: ["id"],
  },
  {
    name: "provider_models",
    rank: 50,
    columns: ["provider_id", "model_id", "display_name", "enabled"],
    pk: ["provider_id", "model_id"],
  },
  {
    name: "prompts",
    rank: 40,
    columns: [
      "id",
      "title",
      "description",
      "icon",
      "draft_content",
      "current_version_id",
      "is_starred",
      "created_at",
      "updated_at",
      "deleted_at",
    ],
    pk: ["id"],
  },
  {
    name: "branches",
    rank: 60,
    columns: ["id", "prompt_id", "name", "description", "created_at"],
    pk: ["id"],
    remappableRefs: { prompt_id: "prompts" },
  },
  {
    name: "versions",
    rank: 70,
    columns: [
      "id",
      "prompt_id",
      "branch_id",
      "parent_version_id",
      "number",
      "label",
      "content",
      "content_format",
      "change_note",
      "author",
      "status",
      "source",
      "created_at",
    ],
    pk: ["id"],
    remappableRefs: { prompt_id: "prompts", branch_id: "branches" },
  },
  {
    name: "prompt_tags",
    rank: 80,
    columns: ["prompt_id", "tag_id"],
    pk: ["prompt_id", "tag_id"],
    remappableRefs: { prompt_id: "prompts", tag_id: "tags" },
  },
  {
    name: "collection_prompts",
    rank: 90,
    columns: ["collection_id", "prompt_id", "sort_order"],
    pk: ["collection_id", "prompt_id"],
    remappableRefs: { collection_id: "collections", prompt_id: "prompts" },
  },
  {
    name: "notes",
    rank: 100,
    columns: ["id", "prompt_id", "version_id", "body", "created_at"],
    pk: ["id"],
    remappableRefs: { prompt_id: "prompts", version_id: "versions" },
  },
  {
    name: "ratings",
    rank: 110,
    columns: ["id", "target_type", "target_id", "effectiveness", "clarity", "completeness", "actionability", "created_at"],
    pk: ["id"],
  },
  {
    name: "runs",
    rank: 120,
    columns: [
      "id",
      "prompt_id",
      "version_id",
      "tool",
      "model",
      "provider",
      "status",
      "output",
      "error",
      "latency_ms",
      "run_group_id",
      "outcome_rating",
      "result_summary",
      "metrics_json",
      "started_at",
      "created_at",
    ],
    pk: ["id"],
    remappableRefs: { prompt_id: "prompts", version_id: "versions" },
  },
  {
    // Share records including their plaintext delete tokens: paired devices
    // already hold the whole library, so they are trusted with revoke
    // capability too (unlike export files, which strip tokens). prompt_id
    // goes NULL via the v5 ON DELETE SET NULL when a prompt is hard-deleted.
    name: "shared_snapshots",
    rank: 45,
    since: 7,
    columns: [
      "snapshot_id",
      "prompt_id",
      "portal_base_url",
      "url",
      "delete_token",
      "full_history",
      "published_at",
      "deleted_at",
    ],
    pk: ["snapshot_id"],
  },
];

const BY_NAME = new Map(SYNCED_TABLES.map((t) => [t.name, t]));

export function tableDef(name: string): SyncedTableDef | undefined {
  return BY_NAME.get(name as SyncedTableName);
}

export function isSyncedTable(name: string): name is SyncedTableName {
  return BY_NAME.has(name as SyncedTableName);
}

/** Composite record key ("a:b"). Values are UUIDs — never contain ':'. */
export function encodeRecordId(def: SyncedTableDef, values: readonly string[]): string {
  return values.join(":");
}

/** Splits a composite record key back into pk column values. */
export function decodeRecordId(def: SyncedTableDef, recordId: string): string[] {
  const values = recordId.split(":");
  if (values.length !== def.pk.length) {
    throw new Error(`Malformed record key for ${def.name}: ${recordId}`);
  }
  return values;
}

/**
 * Sync storage DDL plus dirty-capture triggers. The triggers are pure SQL on
 * purpose: the CLI and MCP server open the same database file, and older
 * binaries must keep writing without any app-registered functions. A guard
 * on sync_meta.applying stops writes made while applying remote ops from
 * echoing back into the dirty set.
 */
export const SYNC_SCHEMA_SQL = `
CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sync_dirty (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete'))
);

CREATE TABLE sync_ops (
  source_device_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT,
  hlc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_device_id, seq),
  UNIQUE (source_device_id, op_id)
);

CREATE TABLE sync_cursors (
  source_device_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);

CREATE TABLE sync_heads (
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY (table_name, record_id)
);

CREATE TABLE sync_id_remaps (
  table_name TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  PRIMARY KEY (table_name, remote_id)
);

CREATE TABLE sync_pending_pointers (
  prompt_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  hlc TEXT NOT NULL
);

CREATE TABLE sync_peers (
  fingerprint TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  paired_at TEXT NOT NULL,
  last_seen TEXT,
  address TEXT,
  forgotten_at TEXT
);
`;

function keyExpr(alias: "NEW" | "OLD", pk: readonly string[]): string {
  return pk.map((column) => `${alias}."${column}"`).join(" || ':' || ");
}

function triggersForDef(def: SyncedTableDef): string[] {
  const events = [
    { suffix: "ins", event: "INSERT", alias: "NEW", kind: "upsert" },
    { suffix: "upd", event: "UPDATE", alias: "NEW", kind: "upsert" },
    { suffix: "del", event: "DELETE", alias: "OLD", kind: "delete" },
  ] as const;
  return events.map(
    ({ suffix, event, alias, kind }) =>
      `CREATE TRIGGER sync_dirty_${def.name}_${suffix}
AFTER ${event} ON ${def.name} FOR EACH ROW
WHEN (SELECT value FROM sync_meta WHERE key = 'applying') IS NULL
BEGIN
  INSERT INTO sync_dirty (table_name, record_id, kind) VALUES ('${def.name}', ${keyExpr(alias, def.pk)}, '${kind}');
END;`,
  );
}

export function syncTriggersSql(sinceVersion = Number.POSITIVE_INFINITY): string {
  return SYNCED_TABLES.filter((def) => (def.since ?? 6) <= sinceVersion)
    .flatMap(triggersForDef)
    .join("\n\n");
}

/** Full v6 migration SQL: sync storage plus v6-era capture triggers. */
export function syncMigrationSql(): string {
  return `${SYNC_SCHEMA_SQL}\n${syncTriggersSql(6)}`;
}

/**
 * v7: shared_snapshots joins the registry. Creates its triggers and enqueues
 * pre-existing share rows — pure SQL, so CLI/MCP binaries pick it up too —
 * meaning publishes made before v7 ship on the next drain. The NOT IN guard
 * keeps the enqueue from re-marking rows already captured as ops.
 */
export function syncV7Sql(): string {
  const triggers = SYNCED_TABLES.filter((def) => (def.since ?? 6) > 6)
    .flatMap(triggersForDef)
    .join("\n\n");
  return `${triggers}
INSERT INTO sync_dirty (table_name, record_id, kind)
SELECT 'shared_snapshots', snapshot_id, 'upsert' FROM shared_snapshots
WHERE snapshot_id NOT IN (SELECT record_id FROM sync_ops WHERE table_name = 'shared_snapshots');`;
}
