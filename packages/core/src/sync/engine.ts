import { randomUUID } from "node:crypto";
import { SqliteError } from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { reindexPrompt } from "../reindex.js";
import { compareHlc, formatHlc, parseHlc } from "./hlc.js";
import {
  SYNCED_TABLES,
  decodeRecordId,
  encodeRecordId,
  recordKeySql,
  tableDef,
  type SyncedTableDef,
  type SyncedTableName,
} from "./tables.js";

/** One record-level change, as it travels between devices. */
export interface SyncOp {
  /** Authoring device id; ops relayed verbatim keep their original source. */
  source: string;
  /** Per-source monotonic sequence, allocated by the author at refine time. */
  seq: number;
  /** Unique per source; makes apply idempotent. */
  opId: string;
  table: SyncedTableName;
  /** Stable encoded primary-key values. */
  recordId: string;
  kind: "upsert" | "delete";
  /** Full row snapshot for upserts (redacted), null for deletes. */
  payload: Record<string, unknown> | null;
  /** Author's HLC stamp at refine time. */
  hlc: string;
  createdAt: string;
}

/** A pinned peer device record (sync_peers table). */
export interface SyncPeerRow {
  fingerprint: string;
  name: string;
  paired_at: string;
  last_seen: string | null;
  address: string | null;
  forgotten_at: string | null;
}

export interface ApplySummary {
  applied: number;
  /** Ops already present (verbatim relays coming back around). */
  skipped: number;
  /** Ops that lost the last-writer-wins comparison. */
  stale: number;
  /** Ops deferred: their referenced row has not arrived yet (re-pulled later). */
  deferred: number;
}

export interface RefineSummary {
  ops: number;
}

/**
 * runs.output is the only realistically oversized column; cap it in flight.
 * 2 MB, not more: JSON-escaping control characters can inflate a string up
 * to 6×, and a single op must still fit a frame (see frames.ts MAX_FRAME_BYTES).
 */
const RUN_OUTPUT_CAP = 2_000_000;
const TRUNCATION_MARKER = "\n\n[…sync-truncated]";
const DEFAULT_BYTE_BUDGET = 1_000_000;

interface OpRow {
  source_device_id: string;
  seq: number;
  op_id: string;
  table_name: string;
  record_id: string;
  kind: string;
  payload_json: string | null;
  hlc: string;
  created_at: string;
}

interface RemapRow {
  remote_id: string;
  local_id: string;
}

type NaturalKeyChildTable = "prompt_tags" | "collection_prompts";

interface ChildHistoryEntry {
  op: SyncOp;
  values: string[];
}

interface NaturalKeyRepairContext {
  childHistoryByParent: Map<NaturalKeyChildTable, Map<string, ChildHistoryEntry[]>>;
  onChildHistoryLoad?: (table: NaturalKeyChildTable) => void;
}

/** Small union-find for the historical aliases that must reduce together. */
class IdComponents {
  private readonly parents = new Map<string, string>();

  add(id: string): void {
    if (!this.parents.has(id)) this.parents.set(id, id);
  }

  connect(left: string, right: string): void {
    this.add(left);
    this.add(right);
    const leftRoot = this.root(left);
    const rightRoot = this.root(right);
    if (leftRoot !== rightRoot) this.parents.set(rightRoot, leftRoot);
  }

  groups(): string[][] {
    const groups = new Map<string, string[]>();
    for (const id of this.parents.keys()) {
      const root = this.root(id);
      const group = groups.get(root);
      if (group === undefined) groups.set(root, [id]);
      else group.push(id);
    }
    return [...groups.values()].map((group) => group.sort()).sort((left, right) => left[0]!.localeCompare(right[0]!));
  }

  private root(id: string): string {
    const parent = this.parents.get(id);
    if (parent === undefined || parent === id) return id;
    const root = this.root(parent);
    this.parents.set(id, root);
    return root;
  }
}

function opFromRow(row: OpRow): SyncOp {
  return {
    source: row.source_device_id,
    seq: row.seq,
    opId: row.op_id,
    table: row.table_name as SyncOp["table"],
    recordId: row.record_id,
    kind: row.kind as SyncOp["kind"],
    payload: row.payload_json === null ? null : (JSON.parse(row.payload_json) as Record<string, unknown>),
    hlc: row.hlc,
    createdAt: row.created_at,
  };
}

/** LWW revision comparison: HLC first, device id as the deterministic tiebreak. */
function compareRevisions(hlcA: string, deviceA: string, hlcB: string, deviceB: string): number {
  const byHlc = compareHlc(hlcA, hlcB);
  if (byHlc !== 0) return byHlc;
  if (deviceA === deviceB) return 0;
  return deviceA < deviceB ? -1 : 1;
}

/** Tables whose unique natural keys merge across devices (keep-local + remap). */
const MERGE_TABLES = new Set<SyncedTableName>(["tags", "collections", "branches"]);

/**
 * Transport-agnostic record sync engine over one library database. Writes are
 * captured by triggers (see tables.ts); this class refines them into ops,
 * applies remote ops with deterministic merges, and serves ops to peers. The
 * desktop peer service (and tests) drive it; it never touches the network.
 *
 * Convergence rules:
 * - append-only rows union by primary key (UUIDs never collide);
 * - mutable rows resolve by (HLC, deviceId) last-writer-wins;
 * - prompt hard deletion is terminal for the prompt and its owned aggregate;
 * - share revocation is grow-only and keeps the earliest non-null timestamp;
 * - unique-name collisions (tags/collections/branches) merge into the local
 *   row and record an id remap so later references follow it;
 * - ops are stored verbatim regardless of LWW outcome so gossip stays
 *   complete for peers that never meet the original author.
 */
export class SyncEngine {
  private deviceIdCache: string | null = null;

  constructor(private readonly db: BetterSqlite3.Database) {}

  // ------------------------------------------------------------------ identity

  deviceId(): string {
    if (this.deviceIdCache) return this.deviceIdCache;
    const read = this.db.prepare("SELECT value FROM sync_meta WHERE key = 'deviceId'") as BetterSqlite3.Statement;
    const existing = read.get() as { value: string } | undefined;
    if (existing) {
      this.deviceIdCache = existing.value;
      return existing.value;
    }
    // INSERT OR IGNORE: the CLI/MCP server may race us on the same file.
    this.db
      .prepare("INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('deviceId', ?)")
      .run(randomUUID());
    const confirmed = read.get() as { value: string };
    this.deviceIdCache = confirmed.value;
    return confirmed.value;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM sync_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Rows written since the last refine (from this process or CLI/MCP). */
  pendingDirty(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty").get() as { n: number };
    return row.n;
  }

  // -------------------------------------------------------------------- peers

  /** A pinned peer device. `forgottenAt` set means it was unpaired again. */
  listSyncPeers(options: { includeForgotten?: boolean } = {}): SyncPeerRow[] {
    const sql = options.includeForgotten
      ? "SELECT * FROM sync_peers ORDER BY paired_at"
      : "SELECT * FROM sync_peers WHERE forgotten_at IS NULL ORDER BY paired_at";
    return this.db.prepare(sql).all() as SyncPeerRow[];
  }

  getSyncPeer(fingerprint: string): SyncPeerRow | null {
    const row = this.db.prepare("SELECT * FROM sync_peers WHERE fingerprint = ?").get(fingerprint) as
      | SyncPeerRow
      | undefined;
    return row ?? null;
  }

  upsertSyncPeer(input: { fingerprint: string; name: string; address?: string | null }): SyncPeerRow {
    this.db
      .prepare(
        `INSERT INTO sync_peers (fingerprint, name, paired_at, last_seen, address, forgotten_at)
         VALUES (?, ?, ?, NULL, ?, NULL)
         ON CONFLICT(fingerprint) DO UPDATE SET
           name = excluded.name,
           address = COALESCE(excluded.address, sync_peers.address),
           forgotten_at = NULL`,
      )
      .run(input.fingerprint, input.name, new Date().toISOString(), input.address ?? null);
    return this.getSyncPeer(input.fingerprint)!;
  }

  touchSyncPeer(fingerprint: string, address?: string): void {
    this.db
      .prepare(
        `UPDATE sync_peers SET last_seen = ?, address = COALESCE(?, address)
         WHERE fingerprint = ? AND forgotten_at IS NULL`,
      )
      .run(new Date().toISOString(), address ?? null, fingerprint);
  }

  forgetSyncPeer(fingerprint: string): void {
    this.db
      .prepare("UPDATE sync_peers SET forgotten_at = ? WHERE fingerprint = ?")
      .run(new Date().toISOString(), fingerprint);
  }

  // ---------------------------------------------------------------------- hlc

  private nextStamp(nowMs?: number): string {
    const now = nowMs ?? Date.now();
    const millis = Number(this.getMeta("hlc_millis") ?? "0");
    const counter = Number(this.getMeta("hlc_counter") ?? "0");
    const stamp =
      now > millis ? { millis: now, counter: 0 } : { millis, counter: counter + 1 };
    this.setMeta("hlc_millis", String(stamp.millis));
    this.setMeta("hlc_counter", String(stamp.counter));
    return formatHlc(stamp);
  }

  private observeStamp(hlc: string): void {
    const remote = parseHlc(hlc);
    const millis = Number(this.getMeta("hlc_millis") ?? "0");
    const counter = Number(this.getMeta("hlc_counter") ?? "0");
    if (remote.millis > millis || (remote.millis === millis && remote.counter > counter)) {
      this.setMeta("hlc_millis", String(remote.millis));
      this.setMeta("hlc_counter", String(remote.counter));
    }
  }

  // ------------------------------------------------------------------- refine

  /**
   * Turns dirty rows into ops: one op per record carrying its *final* state
   * (a row upserted then deleted between refines collapses to a tombstone).
   * Redacts provider API keys and truncates oversized run outputs before
   * anything leaves the device.
   */
  refineDirty(nowMs?: number): RefineSummary {
    if (this.pendingDirty() === 0) return { ops: 0 };
    const me = this.deviceId();
    return this.db.transaction((): RefineSummary => {
      const dirtyRows = this.db.prepare("SELECT table_name, record_id FROM sync_dirty ORDER BY seq").all() as Array<{
        table_name: string;
        record_id: string;
      }>;
      if (dirtyRows.length === 0) return { ops: 0 };

      // Last write per record wins; final row state is authoritative.
      const byRecord = new Map<string, { table: SyncedTableName; recordId: string }>();
      for (const row of dirtyRows) {
        const def = tableDef(row.table_name);
        if (!def) continue;
        byRecord.set(`${row.table_name}\u0000${row.record_id}`, {
          table: def.name,
          recordId: row.record_id,
        });
      }

      const insertOp = this.db.prepare(
        `INSERT INTO sync_ops (source_device_id, seq, op_id, table_name, record_id, kind, payload_json, hlc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const upsertHead = this.db.prepare(
        `INSERT INTO sync_heads (table_name, record_id, hlc, device_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(table_name, record_id) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id`,
      );
      const touchCursor = this.db.prepare(
        `INSERT INTO sync_cursors (source_device_id, last_seq) VALUES (?, ?)
         ON CONFLICT(source_device_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`,
      );

      let seq = this.nextLocalSeq(me);
      let ops = 0;
      for (const { table, recordId } of byRecord.values()) {
        const def = tableDef(table)!;
        const row = this.readRow(def, recordId);
        let kind: SyncOp["kind"] = "upsert";
        let payloadJson: string | null;
        if (row === null) {
          kind = "delete";
          payloadJson = null;
        } else {
          payloadJson = JSON.stringify(redactPayload(table, row));
        }
        const hlc = this.nextStamp(nowMs);
        insertOp.run(me, seq, randomUUID(), table, recordId, kind, payloadJson, hlc, new Date().toISOString());
        upsertHead.run(table, recordId, hlc, me);
        seq += 1;
        ops += 1;
      }
      if (ops > 0) touchCursor.run(me, seq - 1);
      this.db.prepare("DELETE FROM sync_dirty").run();
      return { ops };
    })();
  }

  /**
   * Marks every existing row in every synced table dirty — the bootstrap
   * that ships a pre-sync library the first time sync is enabled.
   */
  bootstrapDirty(): void {
    this.db.transaction(() => {
      for (const def of SYNCED_TABLES) {
        const pk = recordKeySql(def.pk);
        this.db
          .prepare(`INSERT INTO sync_dirty (table_name, record_id, kind) SELECT '${def.name}', ${pk}, 'upsert' FROM ${def.name}`)
          .run();
      }
    })();
  }

  private nextLocalSeq(me: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM sync_ops WHERE source_device_id = ?")
      .get(me) as { n: number };
    return row.n + 1;
  }

  private readRow(def: SyncedTableDef, recordId: string): Record<string, unknown> | null {
    const values = decodeRecordId(def, recordId);
    const where = def.pk.map((c) => `"${c}" = ?`).join(" AND ");
    const row = this.db.prepare(`SELECT * FROM ${def.name} WHERE ${where}`).get(...values) as
      | Record<string, unknown>
      | undefined;
    return row ?? null;
  }

  // -------------------------------------------------------------- anti-entropy

  /** Per-source knowledge for the hello exchange. */
  haveVector(): Record<string, number> {
    const rows = this.db.prepare("SELECT source_device_id, last_seq FROM sync_cursors").all() as Array<{
      source_device_id: string;
      last_seq: number;
    }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.source_device_id] = row.last_seq;
    return out;
  }

  /**
   * Ops a peer is missing, per source in seq order, until the byte budget is
   * exhausted. Always includes at least one op so tiny budgets still make
   * progress. Row-capped so a bootstrap never loads an entire source stream
   * into memory at once.
   */
  opsSince(
    have: Record<string, number>,
    byteBudget: number = DEFAULT_BYTE_BUDGET,
    rowLimit: number = 10_000,
  ): { ops: SyncOp[]; hasMore: boolean } {
    const sources = this.db
      .prepare("SELECT DISTINCT source_device_id AS s FROM sync_ops ORDER BY s")
      .all() as Array<{ s: string }>;
    const ops: SyncOp[] = [];
    let bytes = 0;
    let hasMore = false;
    const selectRows = this.db.prepare(
      "SELECT * FROM sync_ops WHERE source_device_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    );
    outer: for (const { s } of sources) {
      const start = have[s] ?? 0;
      const rows = selectRows.all(s, start, rowLimit) as OpRow[];
      for (const row of rows) {
        const size = (row.payload_json?.length ?? 0) + 128;
        if (ops.length > 0 && bytes + size > byteBudget) {
          hasMore = true;
          break outer;
        }
        ops.push(opFromRow(row));
        bytes += size;
      }
      if (rows.length === rowLimit) {
        hasMore = true;
        break outer;
      }
    }
    return { ops, hasMore };
  }

  /**
   * Applies a batch of remote ops. Batch application is idempotent and
   * commutative (rank-sorted, FK-deferred), and advances each source's cursor
   * only across a contiguous prefix of stored ops. A byte-budget split can
   * deliver an op before the row it references (the referenced op sits in
   * another source's stream) — such orphans are skipped and re-pulled once
   * their parent arrives, never stalling the session.
   */
  applyRemote(remoteOps: SyncOp[]): ApplySummary {
    if (remoteOps.length === 0) return { applied: 0, skipped: 0, stale: 0, deferred: 0 };
    // Canonical rekeys change primary and composite keys. Preserve every local
    // dirty snapshot before they can turn an unrefined upsert into an alias
    // tombstone when refineDirty reads the old key afterwards.
    if (this.pendingDirty() > 0) this.refineDirty();
    // Array#sort is stable in V8, so per-source seq order survives rank sorting.
    const sorted = [...remoteOps].sort((a, b) => tableRank(a.table) - tableRank(b.table));
    for (const op of sorted) {
      // Protocol errors stay loud; only SQLite-level failures degrade.
      if (!tableDef(op.table)) throw new Error(`Unknown synced table in op: ${op.table}`);
    }

    try {
      return this.applyInTransaction(sorted);
    } catch (err) {
      if (!isForeignKeyFailure(err)) throw err;
      // Rollback left no partial state; retry op-by-op so one orphan cannot
      // block the rest of the batch. Skipped ops stay unrecorded, so the
      // cursor stops before them and the next pull re-sends them.
      const summary: ApplySummary = { applied: 0, skipped: 0, stale: 0, deferred: 0 };
      for (const op of sorted) {
        try {
          const one = this.applyInTransaction([op]);
          summary.applied += one.applied;
          summary.skipped += one.skipped;
          summary.stale += one.stale;
          summary.deferred += one.deferred;
        } catch (opErr) {
          if (!isForeignKeyFailure(opErr)) throw opErr;
          summary.deferred += 1;
        }
      }
      return summary;
    }
  }

  /**
   * Reduces released natural-key collisions from immutable history. Migration
   * v11 calls this after refining pending local writes; normal remote delivery
   * continues through applyRemote so it can retain its cursor semantics.
   */
  repairNaturalKeyMerges(options: { onChildHistoryLoad?: (table: NaturalKeyChildTable) => void } = {}): void {
    this.db.transaction(() => {
      this.db.pragma("defer_foreign_keys = ON");
      const alreadyApplying = this.getMeta("applying") !== null;
      if (!alreadyApplying) this.setMeta("applying", "1");
      try {
        const touchedPrompts = new Set<string>();
        const touchedBranches = new Set<string>();
        // Migration v11 reduces every natural-key component in one pass. The
        // junction histories are immutable, so grouping them once avoids an
        // N components × M child-ops rescan during startup repair.
        const repairContext: NaturalKeyRepairContext = {
          childHistoryByParent: new Map(),
          onChildHistoryLoad: options.onChildHistoryLoad,
        };

        for (const def of SYNCED_TABLES) {
          if (!MERGE_TABLES.has(def.name)) continue;
          for (const component of this.historicalMergeComponents(def)) {
            const { canonical, members } = this.canonicalRemapComponent(def.name, component);
            for (const member of members) {
              this.rekeyMergeRow(def, member, canonical, touchedPrompts, touchedBranches);
            }

            const parentKeys = members.map((id) => encodeRecordId(def, [id]));
            const canonicalRecordId = encodeRecordId(def, [canonical]);
            const winner = this.winningMergeOp(def, members);
            if (winner === null) {
              this.normalizeHeads(def.name, parentKeys, canonicalRecordId);
              continue;
            }

            const remapped = this.remapOp(def, winner);
            if (winner.kind === "delete" || remapped.payload === null) {
              this.applyDelete(def, canonicalRecordId, touchedPrompts, touchedBranches);
            } else if (this.tombstonedPromptOwner(def, remapped.payload) !== null) {
              // v10's terminal prompt cascade intentionally leaves historical
              // descendant ops for gossip. Repair must consume their winner
              // without recreating an FK child under the deleted prompt.
              this.applyDelete(def, canonicalRecordId, touchedPrompts, touchedBranches);
            } else {
              this.applyUpsert(
                def,
                canonicalRecordId,
                { ...remapped.payload, id: canonical },
                touchedPrompts,
                touchedBranches,
                winner.hlc,
              );
            }
            this.replaceHeads(def.name, parentKeys, canonicalRecordId, winner);
            this.observeStamp(winner.hlc);

            if (def.name === "tags" || def.name === "collections") {
              this.reduceCanonicalChildren(
                def,
                members,
                canonical,
                winner.kind === "upsert",
                touchedPrompts,
                repairContext,
              );
            }
            if (def.name === "branches") touchedBranches.add(canonical);
          }
        }

        for (const branchId of touchedBranches) this.renumberBranch(branchId);
        for (const promptId of touchedPrompts) reindexPrompt(this.db, promptId);
      } finally {
        if (!alreadyApplying) this.db.prepare("DELETE FROM sync_meta WHERE key = 'applying'").run();
      }
    })();
  }

  private applyInTransaction(sorted: SyncOp[]): ApplySummary {
    const summary: ApplySummary = { applied: 0, skipped: 0, stale: 0, deferred: 0 };

    this.db.transaction(() => {
      // Referenced rows may appear later in the batch (or, for the prompt
      // current-version pointer, in a later batch) — check FKs at commit.
      this.db.pragma("defer_foreign_keys = ON");
      this.setMeta("applying", "1");
      try {
        const opExists = this.db.prepare(
          "SELECT 1 FROM sync_ops WHERE source_device_id = ? AND op_id = ?",
        );
        const insertOp = this.db.prepare(
          `INSERT OR IGNORE INTO sync_ops (source_device_id, seq, op_id, table_name, record_id, kind, payload_json, hlc, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const head = this.db.prepare(
          "SELECT hlc, device_id FROM sync_heads WHERE table_name = ? AND record_id = ?",
        );
        const upsertHead = this.db.prepare(
          `INSERT INTO sync_heads (table_name, record_id, hlc, device_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(table_name, record_id) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id`,
        );

        const touchedPrompts = new Set<string>();
        const touchedBranches = new Set<string>();

        for (const op of sorted) {
          const def = tableDef(op.table);
          if (!def) throw new Error(`Unknown synced table in op: ${op.table}`);

          if (opExists.get(op.source, op.opId)) {
            summary.skipped += 1;
            continue;
          }

          // Schema-drift guard: a version-skewed peer's payload must not
          // reach the transaction, where it would fail as an ambiguous
          // constraint error (or silently drop columns) instead of a clear
          // protocol failure naming the offender.
          if (op.payload !== null) {
            validatePayload(def, op);
          }

          const remapped = this.remapOp(def, op);
          const { table } = remapped;
          let { recordId, payload } = remapped;
          let structuralChange = false;
          if (op.kind === "upsert" && payload !== null && MERGE_TABLES.has(table)) {
            const canonicalized = this.canonicalizeMergeUpsert(
              def,
              recordId,
              payload,
              op,
              touchedPrompts,
              touchedBranches,
            );
            recordId = canonicalized.recordId;
            payload = canonicalized.payload;
            structuralChange = canonicalized.structuralChange;
          }

          if (
            table === "ratings" &&
            op.kind === "upsert" &&
            payload?.["target_type"] === "version" &&
            !this.knowsVersion(String(payload["target_id"]))
          ) {
            // Ratings have a polymorphic target rather than a SQLite FK. Do
            // the same transient-parent deferral explicitly so a rating that
            // arrives before its version cannot become an unowned orphan.
            summary.deferred += 1;
            continue;
          }
          const localHead = head.get(table, recordId) as { hlc: string; device_id: string } | undefined;
          const wins =
            localHead === undefined ||
            compareRevisions(op.hlc, op.source, localHead.hlc, localHead.device_id) > 0;

          // Store verbatim for gossip even when the op loses LWW locally.
          insertOp.run(
            op.source,
            op.seq,
            op.opId,
            op.table,
            op.recordId,
            op.kind,
            op.payload === null ? null : JSON.stringify(op.payload),
            op.hlc,
            op.createdAt,
          );
          this.observeStamp(op.hlc);

          const promptHardDelete = table === "prompts" && op.kind === "delete";
          if (promptHardDelete) {
            this.recordPromptTombstone(recordId);
          }

          if (op.kind === "upsert" && payload !== null) {
            if (table === "shared_snapshots") {
              payload = this.normalizeSharedSnapshot(payload);
              const local = this.db
                .prepare("SELECT deleted_at FROM shared_snapshots WHERE snapshot_id = ?")
                .get(recordId) as { deleted_at: string | null } | undefined;
              const incomingDeletedAt =
                typeof payload["deleted_at"] === "string" ? payload["deleted_at"] : null;
              const deletedAt =
                local?.deleted_at && incomingDeletedAt
                  ? [local.deleted_at, incomingDeletedAt].sort()[0]!
                  : (local?.deleted_at ?? incomingDeletedAt);
              payload = { ...payload, deleted_at: deletedAt };
              if (!wins && local !== undefined && deletedAt !== local.deleted_at) {
                // Revocation is an absorbing state. An older revoke may not
                // replace newer share metadata, but it must still revoke the
                // locally retained token. Keep the earliest timestamp so the
                // merge is independent of delivery order.
                this.db
                  .prepare("UPDATE shared_snapshots SET deleted_at = ? WHERE snapshot_id = ?")
                  .run(deletedAt, recordId);
                summary.applied += 1;
                continue;
              }
            } else {
              const owner = this.tombstonedPromptOwner(def, payload);
              if (owner !== null) {
                // Terminal aggregate deletion consumes later descendant ops
                // for gossip/cursor continuity without rematerializing rows.
                if (def.name === "versions") {
                  // A polymorphic rating has no SQLite FK. It may have arrived
                  // before ownership of this version was known, so remove it
                  // when the terminally owned version is finally identified.
                  this.db
                    .prepare("DELETE FROM ratings WHERE target_type = 'version' AND target_id = ?")
                    .run(recordId);
                }
                if (wins) upsertHead.run(table, recordId, op.hlc, op.source);
                summary.stale += 1;
                continue;
              }
              if (this.hasWinningNaturalParentTombstone(def, payload, op)) {
                // A natural-key parent may have been deleted after an older
                // child op was authored. Its absent row is a known terminal
                // parent state, not a transient FK orphan: retain the child
                // verbatim and its canonical head for gossip/cursors, but do
                // not recreate a row beneath the deleted parent.
                if (wins) upsertHead.run(table, recordId, op.hlc, op.source);
                if (wins) summary.applied += 1;
                else summary.stale += 1;
                continue;
              }
            }
          }

          if (!wins && !promptHardDelete) {
            // This op lost the mutable LWW race, but may still have merged an
            // alias component or reduced child history. It remains one input
            // classification either way, never both stale and applied.
            if (structuralChange) summary.applied += 1;
            else summary.stale += 1;
            continue;
          }

          if (op.kind === "delete") {
            this.applyDelete(def, recordId, touchedPrompts, touchedBranches);
          } else {
            this.applyUpsert(def, recordId, payload!, touchedPrompts, touchedBranches, op.hlc);
          }
          if (wins) upsertHead.run(table, recordId, op.hlc, op.source);
          summary.applied += 1;
        }

        for (const branchId of touchedBranches) this.renumberBranch(branchId);
        for (const promptId of touchedPrompts) reindexPrompt(this.db, promptId);

        for (const source of new Set(sorted.map((o) => o.source))) this.advanceCursor(source);
      } finally {
        this.db.prepare("DELETE FROM sync_meta WHERE key = 'applying'").run();
      }
    })();
    return summary;
  }

  // ------------------------------------------------------------------- helpers

  /**
   * Resolves the complete remap component, not just its first edge. Old
   * releases could leave inverse or chained rows behind, so following one
   * direction would make the surviving id depend on which peer we met first.
   * Rewriting every alias directly to the smallest id keeps the relation
   * idempotent even when a corrupt historical cycle is encountered.
   */
  private canonicalRemapComponent(
    table: SyncedTableName,
    ids: readonly string[],
  ): { canonical: string; members: string[]; changed: boolean } {
    const mappings = this.db
      .prepare("SELECT remote_id, local_id FROM sync_id_remaps WHERE table_name = ?")
      .all(table) as Array<{ remote_id: string; local_id: string }>;
    const neighbors = new Map<string, Set<string>>();
    const connect = (left: string, right: string) => {
      let leftNeighbors = neighbors.get(left);
      if (!leftNeighbors) neighbors.set(left, (leftNeighbors = new Set()));
      leftNeighbors.add(right);
      let rightNeighbors = neighbors.get(right);
      if (!rightNeighbors) neighbors.set(right, (rightNeighbors = new Set()));
      rightNeighbors.add(left);
    };
    for (const { remote_id, local_id } of mappings) connect(remote_id, local_id);

    const visited = new Set(ids);
    const queue = [...visited];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const neighbor of neighbors.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    const members = [...visited].sort();
    const canonical = members[0]!;

    // Delete first so changing a historical inverse edge cannot conflict with
    // its old primary key. Canonical self-maps are deliberately absent.
    const aliases = members.filter((id) => id !== canonical);
    const componentMappings = mappings.filter(
      ({ remote_id, local_id }) => visited.has(remote_id) || visited.has(local_id),
    );
    const changed =
      componentMappings.length !== aliases.length ||
      aliases.some(
        (alias) => !componentMappings.some(({ remote_id, local_id }) => remote_id === alias && local_id === canonical),
      );
    const affected = members;
    if (affected.length > 0) {
      const placeholders = affected.map(() => "?").join(", ");
      this.db
        .prepare(
          `DELETE FROM sync_id_remaps
           WHERE table_name = ? AND (remote_id IN (${placeholders}) OR local_id IN (${placeholders}))`,
        )
        .run(table, ...affected, ...affected);
    }
    const insert = this.db.prepare(
      "INSERT INTO sync_id_remaps (table_name, remote_id, local_id) VALUES (?, ?, ?)",
    );
    for (const alias of aliases) insert.run(table, alias, canonical);
    return { canonical, members, changed };
  }

  private readRemap(table: SyncedTableName, remoteId: string): string | null {
    const { canonical } = this.canonicalRemapComponent(table, [remoteId]);
    return canonical === remoteId ? null : canonical;
  }

  private recordRemap(table: SyncedTableName, remoteId: string, localId: string): void {
    this.canonicalRemapComponent(table, [remoteId, localId]);
  }

  /**
   * Reads every released alias source before materialization changes any row.
   * Natural-key upserts supply positive identity evidence; remap edges retain
   * older aliases and tombstones whose payload is intentionally absent.
   */
  private historicalMergeComponents(def: SyncedTableDef): string[][] {
    const components = new IdComponents();
    const remaps = this.db
      .prepare("SELECT remote_id, local_id FROM sync_id_remaps WHERE table_name = ?")
      .all(def.name) as RemapRow[];
    for (const { remote_id, local_id } of remaps) components.connect(remote_id, local_id);
    const canonicalPromptId = this.canonicalPromptIdResolver();
    const byNaturalKey = new Map<string, string>();
    const addNaturalKey = (id: string, payload: Record<string, unknown>): void => {
      const key = this.mergeNaturalKey(def, payload, canonicalPromptId);
      if (key === null) return;
      components.add(id);
      const existing = byNaturalKey.get(key);
      if (existing === undefined) byNaturalKey.set(key, id);
      else components.connect(existing, id);
    };

    const currentRows = this.db
      .prepare(
        def.name === "branches"
          ? "SELECT id, prompt_id, name FROM branches"
          : `SELECT id, name FROM ${def.name}`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of currentRows) {
      const id = row["id"];
      if (typeof id === "string") addNaturalKey(id, row);
    }

    const historical = this.db.prepare("SELECT * FROM sync_ops WHERE table_name = ?").all(def.name) as OpRow[];
    for (const row of historical) {
      components.add(row.record_id);
      const op = opFromRow(row);
      if (op.payload === null || typeof op.payload["id"] !== "string") continue;
      const id = op.payload["id"];
      components.connect(row.record_id, id);
      addNaturalKey(id, op.payload);
    }

    return components.groups();
  }

  /**
   * Live delivery must retain a historical same-name identity even after its
   * materialized row was removed by a newer tombstone. Query only candidates
   * with the incoming name, then reuse the repair reducer's natural-key and
   * remap rules to expand that one component.
   */
  private historicalNaturalKeyComponent(
    def: SyncedTableDef,
    incomingId: string,
    payload: Record<string, unknown>,
  ): string[] {
    const canonicalPromptId = this.canonicalPromptIdResolver();
    const incomingKey = this.mergeNaturalKey(def, payload, canonicalPromptId);
    if (incomingKey === null) return [incomingId];

    const components = new IdComponents();
    components.add(incomingId);
    const localId = this.naturalKeyLookup(def, payload);
    if (localId !== null) components.connect(incomingId, localId);
    const remaps = this.db
      .prepare("SELECT remote_id, local_id FROM sync_id_remaps WHERE table_name = ?")
      .all(def.name) as RemapRow[];
    for (const { remote_id, local_id } of remaps) components.connect(remote_id, local_id);

    const historical = this.db
      .prepare(
        `SELECT * FROM sync_ops
         WHERE table_name = ? AND payload_json IS NOT NULL
           AND json_extract(payload_json, '$.name') = ?`,
      )
      .all(def.name, String(payload["name"])) as OpRow[];
    for (const row of historical) {
      const op = opFromRow(row);
      if (op.payload === null || typeof op.payload["id"] !== "string") continue;
      if (this.mergeNaturalKey(def, op.payload, canonicalPromptId) !== incomingKey) continue;
      components.connect(incomingId, op.payload["id"]);
      components.connect(row.record_id, op.payload["id"]);
    }

    return components.groups().find((component) => component.includes(incomingId)) ?? [incomingId];
  }

  /** Branch names are scoped by prompt identity; tags and collections use name alone. */
  private mergeNaturalKey(
    def: SyncedTableDef,
    payload: Record<string, unknown>,
    canonicalPromptId: (promptId: string) => string,
  ): string | null {
    const name = payload["name"];
    if (typeof name !== "string") return null;
    if (def.name !== "branches") return name;
    const promptId = payload["prompt_id"];
    return typeof promptId === "string" ? `${canonicalPromptId(promptId)}\u0000${name}` : null;
  }

  /** Resolves legacy prompt remap components without mutating them during a read. */
  private canonicalPromptIdResolver(): (promptId: string) => string {
    const mappings = this.db
      .prepare("SELECT remote_id, local_id FROM sync_id_remaps WHERE table_name = 'prompts'")
      .all() as RemapRow[];
    const neighbors = new Map<string, Set<string>>();
    const connect = (left: string, right: string) => {
      let leftNeighbors = neighbors.get(left);
      if (leftNeighbors === undefined) neighbors.set(left, (leftNeighbors = new Set()));
      leftNeighbors.add(right);
      let rightNeighbors = neighbors.get(right);
      if (rightNeighbors === undefined) neighbors.set(right, (rightNeighbors = new Set()));
      rightNeighbors.add(left);
    };
    for (const { remote_id, local_id } of mappings) connect(remote_id, local_id);
    return (promptId: string): string => {
      const visited = new Set([promptId]);
      const queue = [promptId];
      while (queue.length > 0) {
        const current = queue.pop()!;
        for (const neighbor of neighbors.get(current) ?? []) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
      return [...visited].sort()[0]!;
    };
  }

  /** Returns the newest recorded revision among equivalent record keys. */
  private newestHead(table: SyncedTableName, recordIds: readonly string[]): { hlc: string; device_id: string } | null {
    if (recordIds.length === 0) return null;
    const placeholders = recordIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT hlc, device_id FROM sync_heads
         WHERE table_name = ? AND record_id IN (${placeholders})`,
      )
      .all(table, ...recordIds) as Array<{ hlc: string; device_id: string }>;
    let newest: { hlc: string; device_id: string } | null = null;
    for (const row of rows) {
      if (newest === null || compareRevisions(row.hlc, row.device_id, newest.hlc, newest.device_id) > 0) {
        newest = row;
      }
    }
    return newest;
  }

  /** Whether normalizing these aliases would actually change stored head state. */
  private headsNeedNormalization(
    table: SyncedTableName,
    recordIds: readonly string[],
    canonicalRecordId: string,
  ): boolean {
    const unique = [...new Set(recordIds)];
    if (unique.length === 0) return false;
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT record_id, hlc, device_id FROM sync_heads
         WHERE table_name = ? AND record_id IN (${placeholders})`,
      )
      .all(table, ...unique) as Array<{ record_id: string; hlc: string; device_id: string }>;
    const newest = this.newestHead(table, unique);
    if (newest === null) return rows.length !== 0;
    return (
      rows.length !== 1 ||
      rows[0]?.record_id !== canonicalRecordId ||
      rows[0]?.hlc !== newest.hlc ||
      rows[0]?.device_id !== newest.device_id
    );
  }

  /** Moves all equivalent heads to one delimiter-safe key and keeps the LWW winner. */
  private normalizeHeads(
    table: SyncedTableName,
    recordIds: readonly string[],
    canonicalRecordId: string,
  ): { hlc: string; device_id: string } | null {
    const unique = [...new Set(recordIds)];
    const newest = this.newestHead(table, unique);
    if (unique.length === 0) return newest;
    const placeholders = unique.map(() => "?").join(", ");
    this.db
      .prepare(`DELETE FROM sync_heads WHERE table_name = ? AND record_id IN (${placeholders})`)
      .run(table, ...unique);
    if (newest !== null) {
      this.db
        .prepare("INSERT INTO sync_heads (table_name, record_id, hlc, device_id) VALUES (?, ?, ?, ?)")
        .run(table, canonicalRecordId, newest.hlc, newest.device_id);
    }
    return newest;
  }

  /** Replaces equivalent heads with the immutable operation that won the reduction. */
  private replaceHeads(
    table: SyncedTableName,
    recordIds: readonly string[],
    canonicalRecordId: string,
    winner: SyncOp,
  ): void {
    const unique = [...new Set(recordIds)];
    if (unique.length > 0) {
      const placeholders = unique.map(() => "?").join(", ");
      this.db
        .prepare(`DELETE FROM sync_heads WHERE table_name = ? AND record_id IN (${placeholders})`)
        .run(table, ...unique);
    }
    this.db
      .prepare("INSERT INTO sync_heads (table_name, record_id, hlc, device_id) VALUES (?, ?, ?, ?)")
      .run(table, canonicalRecordId, winner.hlc, winner.source);
  }

  private sourceRecordWins(
    table: SyncedTableName,
    sourceRecordId: string,
    targetRecordId: string,
  ): boolean {
    const source = this.newestHead(table, [sourceRecordId]);
    const target = this.newestHead(table, [targetRecordId]);
    return (
      source !== null &&
      (target === null || compareRevisions(source.hlc, source.device_id, target.hlc, target.device_id) > 0)
    );
  }

  /** The immutable operation reducer for one natural-key parent component. */
  private winningMergeOp(def: SyncedTableDef, members: readonly string[], incoming?: SyncOp): SyncOp | null {
    const placeholders = members.map(() => "?").join(", ");
    const historical = this.db
      .prepare(
        `SELECT * FROM sync_ops WHERE table_name = ? AND record_id IN (${placeholders})`,
      )
      .all(def.name, ...members) as OpRow[];
    let winner = incoming ?? null;
    for (const row of historical) {
      const candidate = opFromRow(row);
      if (winner === null || compareRevisions(candidate.hlc, candidate.source, winner.hlc, winner.source) > 0) {
        winner = candidate;
      }
    }
    return winner;
  }

  /**
   * Reduces every affected junction-key history, including head-only deletes.
   * Physical rows alone are insufficient: a newer tombstone intentionally has
   * none, but still decides the canonical membership and collection ordering.
   */
  private reduceCanonicalChildren(
    def: SyncedTableDef,
    members: readonly string[],
    canonicalId: string,
    parentExists: boolean,
    touchedPrompts: Set<string>,
    repairContext?: NaturalKeyRepairContext,
  ): boolean {
    const childDef = tableDef(def.name === "tags" ? "prompt_tags" : "collection_prompts")!;
    const foreignColumn = def.name === "tags" ? "tag_id" : "collection_id";
    const foreignIndex = childDef.pk.indexOf(foreignColumn);
    const histories = this.childHistoryEntries(childDef, foreignIndex, members, repairContext);
    const groups = new Map<string, { recordIds: Set<string>; winner: SyncOp; values: string[] }>();
    for (const { op: candidate, values: originalValues } of histories) {
      if (!members.includes(originalValues[foreignIndex]!)) continue;
      const values = [...originalValues];
      values[foreignIndex] = canonicalId;
      const canonicalRecordId = encodeRecordId(childDef, values);
      const group = groups.get(canonicalRecordId);
      if (group === undefined) {
        groups.set(canonicalRecordId, { recordIds: new Set([candidate.recordId]), winner: candidate, values });
      } else {
        group.recordIds.add(candidate.recordId);
        if (compareRevisions(candidate.hlc, candidate.source, group.winner.hlc, group.winner.source) > 0) {
          group.winner = candidate;
        }
      }
    }

    let changed = false;
    for (const [recordId, group] of groups) {
      changed =
        this.headsNeedNormalization(childDef.name, [...group.recordIds, recordId], recordId) || changed;
      this.replaceHeads(childDef.name, [...group.recordIds, recordId], recordId, group.winner);
      const promptIndex = childDef.pk.indexOf("prompt_id");
      const promptId = group.values[promptIndex]!;
      const payload =
        group.winner.kind === "upsert" && group.winner.payload !== null
          ? { ...group.winner.payload, [foreignColumn]: canonicalId }
          : null;
      const terminalOwner = payload === null ? null : this.tombstonedPromptOwner(childDef, payload);
      if (!parentExists || group.winner.kind === "delete" || terminalOwner !== null || payload === null) {
        changed = changed || this.readRow(childDef, recordId) !== null;
        this.applyDelete(childDef, recordId, touchedPrompts, new Set());
      } else {
        const current = this.readRow(childDef, recordId);
        changed =
          changed ||
          current === null ||
          childDef.columns.some((column) => current[column] !== (payload[column] ?? null));
        this.upsertRow(childDef, payload, []);
        touchedPrompts.add(promptId);
      }
    }
    return changed;
  }

  /**
   * Live canonicalization reads the affected table on demand. Migration repair
   * shares a parent-key index across components so each immutable child op is
   * decoded once, then visited only for its own natural-key component.
   */
  private childHistoryEntries(
    childDef: SyncedTableDef,
    foreignIndex: number,
    members: readonly string[],
    repairContext?: NaturalKeyRepairContext,
  ): ChildHistoryEntry[] {
    if (repairContext === undefined) {
      return (this.db.prepare("SELECT * FROM sync_ops WHERE table_name = ?").all(childDef.name) as OpRow[]).map(
        (row) => ({ op: opFromRow(row), values: decodeRecordId(childDef, row.record_id) }),
      );
    }

    const table = childDef.name as NaturalKeyChildTable;
    let byParent = repairContext.childHistoryByParent.get(table);
    if (byParent === undefined) {
      repairContext.onChildHistoryLoad?.(table);
      byParent = new Map();
      const rows = this.db.prepare("SELECT * FROM sync_ops WHERE table_name = ?").all(table) as OpRow[];
      for (const row of rows) {
        const values = decodeRecordId(childDef, row.record_id);
        const parentId = values[foreignIndex]!;
        const entries = byParent.get(parentId);
        const entry = { op: opFromRow(row), values };
        if (entries === undefined) byParent.set(parentId, [entry]);
        else entries.push(entry);
      }
      repairContext.childHistoryByParent.set(table, byParent);
    }

    return members.flatMap((member) => byParent.get(member) ?? []);
  }

  /** Repoints a tag's junction rows before retiring an alias row. */
  private rekeyTagChildren(fromId: string, toId: string, touchedPrompts: Set<string>): void {
    const def = tableDef("prompt_tags")!;
    const rows = this.db
      .prepare("SELECT prompt_id, tag_id FROM prompt_tags WHERE tag_id = ?")
      .all(fromId) as Array<{ prompt_id: string; tag_id: string }>;
    for (const row of rows) {
      const oldRecordId = encodeRecordId(def, [row.prompt_id, fromId]);
      const canonicalRecordId = encodeRecordId(def, [row.prompt_id, toId]);
      this.db
        .prepare("INSERT OR IGNORE INTO prompt_tags (prompt_id, tag_id) VALUES (?, ?)")
        .run(row.prompt_id, toId);
      this.db.prepare("DELETE FROM prompt_tags WHERE prompt_id = ? AND tag_id = ?").run(row.prompt_id, fromId);
      this.normalizeHeads(def.name, [oldRecordId, canonicalRecordId], canonicalRecordId);
      touchedPrompts.add(row.prompt_id);
    }
  }

  /** Rekeys a collection's junction rows without letting PK conflicts drop membership. */
  private rekeyCollectionChildren(fromId: string, toId: string, touchedPrompts: Set<string>): void {
    const def = tableDef("collection_prompts")!;
    const rows = this.db
      .prepare("SELECT collection_id, prompt_id, sort_order FROM collection_prompts WHERE collection_id = ?")
      .all(fromId) as Array<{ collection_id: string; prompt_id: string; sort_order: number }>;
    for (const row of rows) {
      const oldRecordId = encodeRecordId(def, [fromId, row.prompt_id]);
      const canonicalRecordId = encodeRecordId(def, [toId, row.prompt_id]);
      const target = this.db
        .prepare("SELECT 1 FROM collection_prompts WHERE collection_id = ? AND prompt_id = ?")
        .get(toId, row.prompt_id);
      if (target === undefined || this.sourceRecordWins(def.name, oldRecordId, canonicalRecordId)) {
        this.upsertRow(def, { ...row, collection_id: toId }, []);
      }
      this.db
        .prepare("DELETE FROM collection_prompts WHERE collection_id = ? AND prompt_id = ?")
        .run(fromId, row.prompt_id);
      this.normalizeHeads(def.name, [oldRecordId, canonicalRecordId], canonicalRecordId);
      touchedPrompts.add(row.prompt_id);
    }
  }

  /** Versions are not keyed by branch, but their FK must move before retiring a branch alias. */
  private rekeyBranchChildren(
    fromId: string,
    toId: string,
    touchedPrompts: Set<string>,
    touchedBranches: Set<string>,
  ): void {
    const rows = this.db
      .prepare("SELECT DISTINCT prompt_id FROM versions WHERE branch_id = ?")
      .all(fromId) as Array<{ prompt_id: string }>;
    this.db.prepare("UPDATE versions SET branch_id = ? WHERE branch_id = ?").run(toId, fromId);
    for (const row of rows) touchedPrompts.add(row.prompt_id);
    touchedBranches.add(toId);
  }

  /**
   * Materializes one component at its canonical id. The FK moves deliberately
   * precede parent deletion: SQLite's cascades would otherwise erase the
   * child rows before their canonical composite keys can be installed.
   */
  private rekeyMergeRow(
    def: SyncedTableDef,
    fromId: string,
    toId: string,
    touchedPrompts: Set<string>,
    touchedBranches: Set<string>,
  ): boolean {
    if (fromId === toId) return false;
    const source = this.db
      .prepare(`SELECT ${def.columns.map((column) => `"${column}"`).join(", ")} FROM ${def.name} WHERE id = ?`)
      .get(fromId) as Record<string, unknown> | undefined;
    if (source === undefined) return false;
    const target = this.db
      .prepare(`SELECT ${def.columns.map((column) => `"${column}"`).join(", ")} FROM ${def.name} WHERE id = ?`)
      .get(toId) as Record<string, unknown> | undefined;
    const sourceRecordId = encodeRecordId(def, [fromId]);
    const targetRecordId = encodeRecordId(def, [toId]);
    const sourceWins = target === undefined || this.sourceRecordWins(def.name, sourceRecordId, targetRecordId);

    switch (def.name) {
      case "tags":
        this.rekeyTagChildren(fromId, toId, touchedPrompts);
        break;
      case "collections":
        this.rekeyCollectionChildren(fromId, toId, touchedPrompts);
        break;
      case "branches":
        this.rekeyBranchChildren(fromId, toId, touchedPrompts, touchedBranches);
        break;
      default:
        return false;
    }

    if (target === undefined) {
      this.db.prepare(`UPDATE ${def.name} SET id = ? WHERE id = ?`).run(toId, fromId);
    } else {
      if (sourceWins) this.updateColumns(def, toId, source, def.columns.filter((column) => column !== "id"));
      this.db.prepare(`DELETE FROM ${def.name} WHERE id = ?`).run(fromId);
    }
    this.normalizeHeads(def.name, [sourceRecordId, targetRecordId], targetRecordId);
    return true;
  }

  /**
   * Merge-table identity is chosen before the ordinary LWW lookup. That keeps
   * identity (minimum id) independent from mutable state (maximum revision).
   */
  private canonicalizeMergeUpsert(
    def: SyncedTableDef,
    recordId: string,
    payload: Record<string, unknown>,
    incoming: SyncOp,
    touchedPrompts: Set<string>,
    touchedBranches: Set<string>,
  ): { recordId: string; payload: Record<string, unknown>; structuralChange: boolean } {
    const incomingId = String(payload["id"]);
    const historicalMembers = this.historicalNaturalKeyComponent(def, incomingId, payload);
    const { canonical, members, changed: remapsChanged } = this.canonicalRemapComponent(
      def.name,
      historicalMembers,
    );
    let structuralChange = remapsChanged;
    for (const member of members) {
      structuralChange = this.rekeyMergeRow(def, member, canonical, touchedPrompts, touchedBranches) || structuralChange;
    }
    const parentKeys = members.map((id) => encodeRecordId(def, [id]));
    const canonicalRecordId = encodeRecordId(def, [canonical]);
    this.normalizeHeads(def.name, parentKeys, canonicalRecordId);
    const winner = this.winningMergeOp(def, members, incoming)!;
    const parentExists = winner.kind === "upsert";
    if (!parentExists) {
      const before = this.readRow(def, canonicalRecordId) !== null;
      this.applyDelete(def, canonicalRecordId, touchedPrompts, touchedBranches);
      structuralChange = structuralChange || before;
    }
    if (def.name === "tags" || def.name === "collections") {
      structuralChange =
        this.reduceCanonicalChildren(def, members, canonical, parentExists, touchedPrompts) || structuralChange;
    }
    if (def.name === "branches") touchedBranches.add(canonical);
    return { recordId: canonicalRecordId, payload: { ...payload, id: canonical }, structuralChange };
  }

  private isPromptTombstoned(promptId: string): boolean {
    return this.db
      .prepare("SELECT 1 FROM sync_prompt_tombstones WHERE prompt_id = ?")
      .get(promptId) !== undefined;
  }

  private recordPromptTombstone(promptId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO sync_prompt_tombstones (prompt_id) VALUES (?)")
      .run(promptId);
    this.db.prepare("DELETE FROM sync_pending_pointers WHERE prompt_id = ?").run(promptId);
  }

  /** Returns the terminally deleted prompt that owns this incoming row. */
  private tombstonedPromptOwner(
    def: SyncedTableDef,
    payload: Record<string, unknown>,
  ): string | null {
    if (def.name === "prompts") {
      const promptId = String(payload["id"]);
      return this.isPromptTombstoned(promptId) ? promptId : null;
    }

    if (
      def.name === "branches" ||
      def.name === "versions" ||
      def.name === "prompt_tags" ||
      def.name === "collection_prompts" ||
      def.name === "notes" ||
      def.name === "runs"
    ) {
      const promptId = String(payload["prompt_id"]);
      return this.isPromptTombstoned(promptId) ? promptId : null;
    }

    if (def.name !== "ratings") return null;
    const targetId = String(payload["target_id"]);
    if (payload["target_type"] === "prompt") {
      return this.isPromptTombstoned(targetId) ? targetId : null;
    }
    if (payload["target_type"] !== "version") return null;
    const current = this.db.prepare("SELECT prompt_id FROM versions WHERE id = ?").get(targetId) as
      | { prompt_id: string }
      | undefined;
    if (current && this.isPromptTombstoned(current.prompt_id)) return current.prompt_id;
    const historical = this.db
      .prepare(
        `SELECT json_extract(payload_json, '$.prompt_id') AS prompt_id
         FROM sync_ops
         WHERE table_name = 'versions' AND record_id = ? AND payload_json IS NOT NULL
         ORDER BY hlc DESC, source_device_id DESC
         LIMIT 1`,
      )
      .get(targetId) as { prompt_id: string | null } | undefined;
    return historical?.prompt_id && this.isPromptTombstoned(historical.prompt_id)
      ? historical.prompt_id
      : null;
  }

  /**
   * A known merge-parent tombstone consumes only children that predate it.
   * Later children stay FK-deferred: they may still be paired with a parent
   * upsert in a future source tail, while an older child cannot materialize
   * under the parent state that already won its natural-key component.
   */
  private hasWinningNaturalParentTombstone(
    def: SyncedTableDef,
    payload: Record<string, unknown>,
    child: SyncOp,
  ): boolean {
    const parent =
      def.name === "prompt_tags"
        ? { table: "tags" as const, foreignColumn: "tag_id" }
        : def.name === "collection_prompts"
          ? { table: "collections" as const, foreignColumn: "collection_id" }
          : def.name === "versions"
            ? { table: "branches" as const, foreignColumn: "branch_id" }
            : null;
    if (parent === null) return false;
    const parentId = payload[parent.foreignColumn];
    if (typeof parentId !== "string") return false;
    const parentDef = tableDef(parent.table)!;
    if (this.readRow(parentDef, encodeRecordId(parentDef, [parentId])) !== null) return false;
    const { members } = this.canonicalRemapComponent(parent.table, [parentId]);
    const winner = this.winningMergeOp(parentDef, members);
    return (
      winner !== null &&
      winner.kind === "delete" &&
      compareRevisions(winner.hlc, winner.source, child.hlc, child.source) >= 0
    );
  }

  private normalizeSharedSnapshot(payload: Record<string, unknown>): Record<string, unknown> {
    const promptId = payload["prompt_id"];
    if (typeof promptId !== "string" || !this.isPromptTombstoned(promptId)) return payload;
    return { ...payload, prompt_id: null };
  }

  private knowsVersion(versionId: string): boolean {
    if (this.db.prepare("SELECT 1 FROM versions WHERE id = ?").get(versionId)) return true;
    return this.db
      .prepare(
        `SELECT 1 FROM sync_ops
         WHERE table_name = 'versions' AND record_id = ? AND payload_json IS NOT NULL
         LIMIT 1`,
      )
      .get(versionId) !== undefined;
  }

  /** Applies recorded id remaps to an op's record key and payload references. */
  private remapOp(
    def: SyncedTableDef,
    op: SyncOp,
  ): { table: SyncedTableName; recordId: string; payload: Record<string, unknown> | null } {
    const refs = def.remappableRefs ?? {};
    const remapValue = (column: string, value: unknown): unknown => {
      const target = refs[column];
      if (target === undefined || typeof value !== "string") return value;
      return this.readRemap(target, value) ?? value;
    };
    if (op.payload !== null) {
      const payload = { ...op.payload };
      for (const column of Object.keys(refs)) payload[column] = remapValue(column, payload[column]);
      if (MERGE_TABLES.has(def.name) && typeof payload["id"] === "string") {
        payload["id"] = this.readRemap(def.name, payload["id"]) ?? payload["id"];
      }
      const recordId = encodeRecordId(def, def.pk.map((c) => String(payload[c])));
      return { table: def.name, recordId, payload };
    }
    // Tombstones: FK columns remap as usual, and a merge table's own id also
    // passes through its remap — otherwise deleting the merged-away id on the
    // device that lost the name race would no-op here and leave a ghost row.
    const values = decodeRecordId(def, op.recordId);
    for (let i = 0; i < values.length; i++) {
      const remapped = remapValue(def.pk[i]!, values[i]);
      if (typeof remapped === "string") values[i] = remapped;
    }
    if (MERGE_TABLES.has(def.name)) {
      const remapped = this.readRemap(def.name, values[0]!);
      if (remapped !== null) values[0] = remapped;
    }
    return { table: def.name, recordId: encodeRecordId(def, values), payload: null };
  }

  private applyUpsert(
    def: SyncedTableDef,
    recordId: string,
    payload: Record<string, unknown>,
    touchedPrompts: Set<string>,
    touchedBranches: Set<string>,
    opHlc: string,
  ): void {
    switch (def.name) {
      case "tags":
      case "collections":
      case "branches": {
        // A local row with the same natural key absorbs the remote id…
        const local = this.naturalKeyLookup(def, payload);
        const remoteId = String(payload["id"]);
        if (local !== null && local !== remoteId) {
          this.recordRemap(def.name, remoteId, local);
          // …but the winning op still updates the row's mutable columns.
          this.updateColumns(def, local, payload, def.columns.filter((c) => c !== "id"));
        } else {
          this.upsertRow(def, payload, []);
        }
        if (def.name === "branches") touchedPrompts.add(String(payload["prompt_id"]));
        return;
      }
      case "providers": {
        const local = this.db
          .prepare("SELECT type, driver, base_url FROM providers WHERE id = ?")
          .get(String(payload["id"])) as
          | { type: string; driver: string; base_url: string | null }
          | undefined;
        const routeChanged =
          local !== undefined &&
          (local.type !== payload["type"] ||
            local.driver !== payload["driver"] ||
            local.base_url !== (payload["base_url"] ?? null));
        // API keys never travel. Preserve the local key for metadata edits,
        // but clear it when a synced execution route changes so the old
        // credential cannot be silently sent to a new destination.
        this.upsertRow(def, payload, ["api_key_enc"]);
        if (routeChanged) {
          this.db
            .prepare("UPDATE providers SET api_key_enc = NULL WHERE id = ?")
            .run(String(payload["id"]));
        }
        return;
      }
      case "prompts": {
        let pointer = payload["current_version_id"];
        if (typeof pointer === "string") {
          const present = this.db.prepare("SELECT 1 FROM versions WHERE id = ?").get(pointer);
          if (!present) {
            // Version not received yet — stash the pointer, keep the local one.
            this.db
              .prepare(
                `INSERT INTO sync_pending_pointers (prompt_id, version_id, hlc) VALUES (?, ?, ?)
                 ON CONFLICT(prompt_id) DO UPDATE SET version_id = excluded.version_id, hlc = excluded.hlc
                 WHERE excluded.hlc >= sync_pending_pointers.hlc`,
              )
              .run(String(payload["id"]), pointer, opHlc);
            const current = this.db
              .prepare("SELECT current_version_id FROM prompts WHERE id = ?")
              .get(String(payload["id"])) as { current_version_id: string | null } | undefined;
            pointer = current?.current_version_id ?? null;
          } else {
            // This winning op set the pointer directly: any older stash for
            // the prompt is superseded and must not resurrect later.
            this.db
              .prepare("DELETE FROM sync_pending_pointers WHERE prompt_id = ?")
              .run(String(payload["id"]));
          }
        }
        this.upsertRow(def, { ...payload, current_version_id: pointer }, []);
        touchedPrompts.add(String(payload["id"]));
        return;
      }
      case "versions": {
        this.upsertRow(def, payload, []);
        touchedPrompts.add(String(payload["prompt_id"]));
        touchedBranches.add(String(payload["branch_id"]));
        this.fulfillPendingPointer(String(payload["id"]));
        return;
      }
      case "notes":
      case "prompt_tags": {
        this.upsertRow(def, payload, []);
        touchedPrompts.add(String(payload["prompt_id"]));
        return;
      }
      case "collection_prompts": {
        this.upsertRow(def, payload, []);
        touchedPrompts.add(String(payload["prompt_id"]));
        return;
      }
      default:
        // ratings/runs/provider_models never feed the search index.
        this.upsertRow(def, payload, []);
        return;
    }
  }

  /** Natural-key lookup for the unique-name merge tables. */
  private naturalKeyLookup(def: SyncedTableDef, payload: Record<string, unknown>): string | null {
    if (def.name === "tags" || def.name === "collections") {
      const row = this.db
        .prepare(`SELECT id FROM ${def.name} WHERE name = ?`)
        .get(String(payload["name"])) as { id: string } | undefined;
      return row?.id ?? null;
    }
    // branches: UNIQUE (prompt_id, name)
    const row = this.db
      .prepare("SELECT id FROM branches WHERE prompt_id = ? AND name = ?")
      .get(String(payload["prompt_id"]), String(payload["name"])) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * INSERT … ON CONFLICT(pk) DO UPDATE for every payload column except
   * `preserve` (columns the local row owns on conflict; insert still uses
   * the payload value).
   */
  private upsertRow(def: SyncedTableDef, payload: Record<string, unknown>, preserve: string[]): void {
    const columns = def.columns;
    const placeholders = columns.map(() => "?").join(", ");
    const updateColumns = columns.filter((c) => !preserve.includes(c));
    const updates = updateColumns.map((c) => `"${c}" = excluded."${c}"`).join(", ");
    this.db
      .prepare(
        `INSERT INTO ${def.name} (${columns.map((c) => `"${c}"`).join(", ")})
         VALUES (${placeholders})
         ON CONFLICT(${def.pk.map((c) => `"${c}"`).join(", ")}) DO UPDATE SET ${updates}`,
      )
      .run(...columns.map((c) => payload[c] ?? null));
  }

  private updateColumns(
    def: SyncedTableDef,
    id: string,
    payload: Record<string, unknown>,
    columns: readonly string[],
  ): void {
    if (columns.length === 0) return;
    const sets = columns.map((c) => `"${c}" = ?`).join(", ");
    this.db
      .prepare(`UPDATE ${def.name} SET ${sets} WHERE id = ?`)
      .run(...columns.map((c) => payload[c] ?? null), id);
  }

  private applyDelete(
    def: SyncedTableDef,
    recordId: string,
    touchedPrompts: Set<string>,
    touchedBranches: Set<string>,
  ): void {
    const values = decodeRecordId(def, recordId);
    const id = values[0]!;
    const run = (sql: string, ...params: unknown[]) => this.db.prepare(sql).run(...params);
    switch (def.name) {
      case "prompts": {
        // hardDeletePrompt's cascade, mirrored.
        run("DELETE FROM search_index WHERE prompt_id = ?", id);
        run("DELETE FROM runs WHERE prompt_id = ?", id);
        run("DELETE FROM notes WHERE prompt_id = ?", id);
        run(
          `DELETE FROM ratings WHERE target_type = 'version'
           AND target_id IN (SELECT id FROM versions WHERE prompt_id = ?)`,
          id,
        );
        run("UPDATE prompts SET current_version_id = NULL WHERE id = ?", id);
        run("DELETE FROM versions WHERE prompt_id = ?", id);
        run("DELETE FROM branches WHERE prompt_id = ?", id);
        run("DELETE FROM prompt_tags WHERE prompt_id = ?", id);
        run("DELETE FROM collection_prompts WHERE prompt_id = ?", id);
        run("DELETE FROM ratings WHERE target_type = 'prompt' AND target_id = ?", id);
        run("DELETE FROM sync_pending_pointers WHERE prompt_id = ?", id);
        run("DELETE FROM prompts WHERE id = ?", id);
        return;
      }
      case "tags":
        run("DELETE FROM prompt_tags WHERE tag_id = ?", id);
        run("DELETE FROM tags WHERE id = ?", id);
        return;
      case "collections":
        run("DELETE FROM collection_prompts WHERE collection_id = ?", id);
        run("DELETE FROM collections WHERE id = ?", id);
        return;
      case "branches": {
        const promptId = (
          this.db.prepare("SELECT prompt_id FROM branches WHERE id = ?").get(id) as
            | { prompt_id: string }
            | undefined
        )?.prompt_id;
        run("DELETE FROM runs WHERE version_id IN (SELECT id FROM versions WHERE branch_id = ?)", id);
        run(
          `DELETE FROM ratings WHERE target_type = 'version'
           AND target_id IN (SELECT id FROM versions WHERE branch_id = ?)`,
          id,
        );
        run("UPDATE notes SET version_id = NULL WHERE version_id IN (SELECT id FROM versions WHERE branch_id = ?)", id);
        run("DELETE FROM versions WHERE branch_id = ?", id);
        run("DELETE FROM branches WHERE id = ?", id);
        if (promptId !== undefined) touchedPrompts.add(promptId);
        return;
      }
      case "versions": {
        const row = this.db.prepare("SELECT prompt_id, branch_id FROM versions WHERE id = ?").get(id) as
          | { prompt_id: string; branch_id: string }
          | undefined;
        run("DELETE FROM runs WHERE version_id = ?", id);
        run("DELETE FROM ratings WHERE target_type = 'version' AND target_id = ?", id);
        run("UPDATE notes SET version_id = NULL WHERE version_id = ?", id);
        run("DELETE FROM versions WHERE id = ?", id);
        if (row) {
          touchedPrompts.add(row.prompt_id);
          touchedBranches.add(row.branch_id);
        }
        return;
      }
      case "notes": {
        const row = this.db.prepare("SELECT prompt_id FROM notes WHERE id = ?").get(id) as
          | { prompt_id: string }
          | undefined;
        run("DELETE FROM notes WHERE id = ?", id);
        if (row) touchedPrompts.add(row.prompt_id);
        return;
      }
      case "ratings":
        run("DELETE FROM ratings WHERE id = ?", id);
        return;
      case "runs":
        run("DELETE FROM runs WHERE id = ?", id);
        return;
      case "providers":
        run("DELETE FROM provider_models WHERE provider_id = ?", id);
        run("DELETE FROM providers WHERE id = ?", id);
        return;
      case "prompt_tags": {
        const [promptId, tagId] = values as [string, string];
        run("DELETE FROM prompt_tags WHERE prompt_id = ? AND tag_id = ?", promptId, tagId);
        touchedPrompts.add(promptId);
        return;
      }
      case "collection_prompts": {
        const [collectionId, promptId] = values as [string, string];
        run("DELETE FROM collection_prompts WHERE collection_id = ? AND prompt_id = ?", collectionId, promptId);
        touchedPrompts.add(promptId);
        return;
      }
      case "provider_models": {
        const [providerId, modelId] = values as [string, string];
        run("DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?", providerId, modelId);
        return;
      }
      case "shared_snapshots":
        run("DELETE FROM shared_snapshots WHERE snapshot_id = ?", id);
        return;
    }
  }

  /** Sets a prompt pointer whose version finally arrived; clears the stash. */
  private fulfillPendingPointer(versionId: string): void {
    const stash = this.db
      .prepare("SELECT prompt_id, hlc FROM sync_pending_pointers WHERE version_id = ?")
      .get(versionId) as { prompt_id: string; hlc: string } | undefined;
    if (!stash) return;
    if (this.isPromptTombstoned(stash.prompt_id)) {
      this.db.prepare("DELETE FROM sync_pending_pointers WHERE version_id = ?").run(versionId);
      return;
    }
    // Belt and braces: never let a stash older than the prompt row's winning
    // revision resurrect a stale pointer.
    const head = this.db
      .prepare("SELECT hlc FROM sync_heads WHERE table_name = 'prompts' AND record_id = ?")
      .get(stash.prompt_id) as { hlc: string } | undefined;
    if (head && compareHlc(stash.hlc, head.hlc) < 0) {
      this.db.prepare("DELETE FROM sync_pending_pointers WHERE version_id = ?").run(versionId);
      return;
    }
    this.db.prepare("UPDATE prompts SET current_version_id = ? WHERE id = ?").run(versionId, stash.prompt_id);
    this.db.prepare("DELETE FROM sync_pending_pointers WHERE version_id = ?").run(versionId);
  }

  /** Deterministic per-branch numbering: (created_at, id) order. */
  private renumberBranch(branchId: string): void {
    const rows = this.db
      .prepare("SELECT id FROM versions WHERE branch_id = ? ORDER BY created_at, id")
      .all(branchId) as Array<{ id: string }>;
    const update = this.db.prepare("UPDATE versions SET number = ? WHERE id = ?");
    rows.forEach((row, index) => update.run(index + 1, row.id));
  }

  /** Advances a source's cursor across the contiguous stored prefix. */
  private advanceCursor(source: string): void {
    const current = this.db
      .prepare("SELECT last_seq FROM sync_cursors WHERE source_device_id = ?")
      .get(source) as { last_seq: number } | undefined;
    let cursor = current?.last_seq ?? 0;
    const exists = this.db.prepare(
      "SELECT 1 FROM sync_ops WHERE source_device_id = ? AND seq = ?",
    );
    for (let guard = 0; guard < 1_000_000; guard++) {
      if (exists.get(source, cursor + 1)) cursor += 1;
      else break;
    }
    this.db
      .prepare(
        `INSERT INTO sync_cursors (source_device_id, last_seq) VALUES (?, ?)
         ON CONFLICT(source_device_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`,
      )
      .run(source, cursor);
  }
}

function tableRank(table: SyncOp["table"]): number {
  return tableDef(table)?.rank ?? 0;
}

/**
 * Only a foreign-key orphan degrades to per-op deferral — its parent may
 * simply not have arrived yet (transient). Anything else — SQLITE_BUSY from
 * the concurrent CLI/MCP writer, disk, corruption, or CHECK/NOT NULL
 * violations that would retry forever — stays loud: the session fails and
 * reconnects instead of silently wedging a source's tail.
 */
function isForeignKeyFailure(err: unknown): boolean {
  return (
    err instanceof SqliteError &&
    typeof err.code === "string" &&
    /^SQLITE_CONSTRAINT(_FOREIGNKEY)?$/.test(err.code)
  );
}

/**
 * Rejects payloads that do not match the synced-table schema before they can
 * touch the transaction: unknown columns and missing primary-key parts are
 * protocol violations from a version-skewed peer, not data problems.
 */
function validatePayload(def: SyncedTableDef, op: SyncOp): void {
  const payload = op.payload!;
  for (const key of Object.keys(payload)) {
    if (!def.columns.includes(key)) {
      throw new Error(
        `Op ${op.source}/${op.opId} for ${def.name} carries unknown column "${key}" — peer schema drift`,
      );
    }
  }
  for (const column of def.pk) {
    if (payload[column] === undefined || payload[column] === null || payload[column] === "") {
      throw new Error(`Op ${op.source}/${op.opId} for ${def.name} is missing pk column "${column}"`);
    }
  }
}

/** Device-local secrets and in-flight caps, applied before ops leave. */
function redactPayload(table: SyncedTableName, row: Record<string, unknown>): Record<string, unknown> {
  if (table === "providers") {
    return { ...row, api_key_enc: null };
  }
  if (table === "runs") {
    // Exact substituted prompts were added after wire protocol v1. Keep them
    // device-local until peers can negotiate optional columns; otherwise a
    // rolling upgrade wedges older peers on schema-drift validation.
    const { prompt_content: _promptContent, ...portable } = row;
    const output = portable["output"];
    if (typeof output === "string" && output.length > RUN_OUTPUT_CAP) {
      return { ...portable, output: output.slice(0, RUN_OUTPUT_CAP) + TRUNCATION_MARKER };
    }
    return portable;
  }
  return row;
}
