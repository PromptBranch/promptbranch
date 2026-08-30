import { randomUUID } from "node:crypto";
import { reindexPrompt as reindexPromptRows } from "./reindex.js";
import type BetterSqlite3 from "better-sqlite3";
import type {
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
} from "./types.js";

const now = () => new Date().toISOString();

const RATING_DIMENSIONS = ["effectiveness", "clarity", "completeness", "actionability"] as const;

/** metrics_json keys owned by run execution — updateRunMetrics patches must not touch them. */
const RESERVED_METRICS_KEYS = new Set(["usage", "costUsd"]);
type RatingDimension = (typeof RATING_DIMENSIONS)[number];

export type PromptSort = "updated" | "created" | "title" | "rating";

export interface ListPromptsOptions {
  sort?: PromptSort;
  /** Prompts must carry at least one of these tags. */
  tagIds?: string[];
  collectionId?: string;
  starred?: boolean;
  includeDeleted?: boolean;
  /** Only soft-deleted prompts (Trash view). Overrides `includeDeleted`. */
  deletedOnly?: boolean;
  /** Only prompts whose average rating (across all dimensions) is >= this. */
  minRating?: number;
}

export interface ActivityItem {
  prompt_id: string;
  prompt_title: string;
  version_id: string;
  number: number;
  label: string | null;
  branch_name: string;
  change_note: string | null;
  created_at: string;
}

export interface VersionWithBranch extends VersionRow {
  branch_name: string;
}

/** A pending agent suggestion, joined with its prompt title and branch name. */
export interface SuggestionItem extends VersionWithBranch {
  prompt_title: string;
}

/** One run inside a multi-model group, as shown by the compare view. */
export interface RunGroupItem {
  id: string;
  versionId: string;
  provider: string | null;
  /** Null when the provider row was deleted after the run. */
  providerName: string | null;
  model: string | null;
  status: RunStatus;
  outcomeRating: number | null;
  output: string | null;
  error: string | null;
  latencyMs: number | null;
  /** Token usage parsed from metrics_json; null when unknown. */
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  /** Estimated USD cost parsed from metrics_json; null when unknown. */
  costUsd: number | null;
  /** Judge rationale parsed from metrics_json; null when never judged/applied. */
  judgeRationale: string | null;
  /** Judge dimension scores parsed from metrics_json; null when never judged/applied. */
  judgeScores: JudgeScores | null;
  createdAt: string;
}

/** The four LLM-judge scoring dimensions, each 1–5. */
export interface JudgeScores {
  effectiveness: number;
  clarity: number;
  completeness: number;
  actionability: number;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJudgeScores(value: unknown): JudgeScores | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const scores = {
    effectiveness: asFiniteNumber(record["effectiveness"]),
    clarity: asFiniteNumber(record["clarity"]),
    completeness: asFiniteNumber(record["completeness"]),
    actionability: asFiniteNumber(record["actionability"]),
  };
  return Object.values(scores).every((v) => v !== null) ? (scores as JudgeScores) : null;
}

/**
 * Reads usage/cost/judge fields back out of a run's metrics_json blob.
 * Defensive by design: corrupt or hand-written metrics degrade to nulls,
 * never throw.
 */
export function parseRunMetrics(
  metricsJson: string | null,
): Pick<RunGroupItem, "usage" | "costUsd" | "judgeRationale" | "judgeScores"> {
  const empty = { usage: null, costUsd: null, judgeRationale: null, judgeScores: null };
  if (metricsJson === null) return empty;
  try {
    const parsed: unknown = JSON.parse(metricsJson);
    if (typeof parsed !== "object" || parsed === null) return empty;
    const record = parsed as Record<string, unknown>;
    const rawUsage = record["usage"];
    const usage =
      typeof rawUsage === "object" && rawUsage !== null
        ? {
            inputTokens: asFiniteNumber((rawUsage as Record<string, unknown>)["inputTokens"]),
            outputTokens: asFiniteNumber((rawUsage as Record<string, unknown>)["outputTokens"]),
          }
        : null;
    const rawRationale = record["judgeRationale"];
    return {
      usage,
      costUsd: asFiniteNumber(record["costUsd"]),
      judgeRationale: typeof rawRationale === "string" ? rawRationale : null,
      judgeScores: parseJudgeScores(record["judgeScores"]),
    };
  } catch {
    return empty;
  }
}

export interface RunGroup {
  runGroupId: string;
  createdAt: string;
  runs: RunGroupItem[];
}

export interface SearchResult {
  promptId: string;
  versionId: string | null;
  title: string;
  snippet: string;
  /** bm25 score; lower is a better match. */
  rank: number;
}

export interface SearchFilters {
  tagIds?: string[];
  collectionId?: string;
  starred?: boolean;
}

export interface AverageRatings {
  effectiveness: number | null;
  clarity: number | null;
  completeness: number | null;
  actionability: number | null;
  overall: number | null;
  count: number;
}

export interface LibraryExport {
  meta: { formatVersion: 1; exportedAt: string };
  tables: {
    prompts: PromptRow[];
    branches: BranchRow[];
    versions: VersionRow[];
    notes: NoteRow[];
    tags: TagRow[];
    prompt_tags: PromptTagRow[];
    collections: CollectionRow[];
    collection_prompts: CollectionPromptRow[];
    ratings: RatingRow[];
    runs: RunRow[];
    settings: SettingRow[];
    /**
     * AI provider configuration. api_key_enc is always null in exports by
     * design: the blob is encrypted with the exporting device's OS keychain
     * and would not decrypt anywhere else. Absent in pre-v3 bundles.
     */
    providers?: ProviderRow[];
    /** Per-provider model visibility; absent in pre-v3 bundles. */
    provider_models?: ProviderModelRow[];
  };
}

export interface ImportTableSummary {
  inserted: number;
  /** Rows merged into an existing row (tags/collections by unique name). */
  merged: number;
  /** Rows whose primary key was remapped due to a collision. */
  remapped: number;
  /** Rows skipped (duplicate junction pairs). */
  skipped: number;
}

export type ImportSummary = Record<string, ImportTableSummary>;

/**
 * Cohesive domain API over an open database handle. Obtain a handle via
 * `openDatabase` / `openMemoryDatabase` (see `db.ts`), then:
 *
 *   const library = new PromptLibrary(db);
 */
export class PromptLibrary {
  constructor(private readonly db: BetterSqlite3.Database) {}

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }

  private mustGetPrompt(promptId: string): PromptRow {
    const prompt = this.get<PromptRow>("SELECT * FROM prompts WHERE id = ?", promptId);
    if (!prompt) throw new Error(`Prompt not found: ${promptId}`);
    return prompt;
  }

  // ---------------------------------------------------------------- prompts

  createPrompt(input: {
    title: string;
    description?: string;
    icon?: string;
    /** Existing tag ids to attach. */
    tagIds?: string[];
    content: string;
    changeNote?: string;
  }): PromptRow {
    if (!input.title.trim()) throw new Error("Prompt title must not be empty");
    return this.db.transaction((): PromptRow => {
      const ts = now();
      const promptId = randomUUID();
      this.run(
        `INSERT INTO prompts (id, title, description, icon, is_starred, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
        promptId,
        input.title,
        input.description ?? null,
        input.icon ?? null,
        ts,
        ts,
      );

      const branchId = randomUUID();
      this.run(
        `INSERT INTO branches (id, prompt_id, name, created_at) VALUES (?, ?, 'main', ?)`,
        branchId,
        promptId,
        ts,
      );

      const versionId = randomUUID();
      this.run(
        `INSERT INTO versions (id, prompt_id, branch_id, parent_version_id, number, content, change_note, created_at)
         VALUES (?, ?, ?, NULL, 1, ?, ?, ?)`,
        versionId,
        promptId,
        branchId,
        input.content,
        input.changeNote ?? null,
        ts,
      );
      this.run("UPDATE prompts SET current_version_id = ? WHERE id = ?", versionId, promptId);

      for (const tagId of input.tagIds ?? []) {
        this.run("INSERT INTO prompt_tags (prompt_id, tag_id) VALUES (?, ?)", promptId, tagId);
      }

      this.reindexPrompt(promptId);
      return this.mustGetPrompt(promptId);
    })();
  }

  getPrompt(promptId: string): PromptRow | null {
    return this.get<PromptRow>("SELECT * FROM prompts WHERE id = ?", promptId) ?? null;
  }

  updatePromptMetadata(
    promptId: string,
    patch: { title?: string; description?: string | null; icon?: string | null },
  ): PromptRow {
    this.mustGetPrompt(promptId);
    if (patch.title !== undefined && !patch.title.trim()) {
      throw new Error("Prompt title must not be empty");
    }
    return this.db.transaction((): PromptRow => {
      if (patch.title !== undefined) this.run("UPDATE prompts SET title = ? WHERE id = ?", patch.title, promptId);
      if (patch.description !== undefined)
        this.run("UPDATE prompts SET description = ? WHERE id = ?", patch.description, promptId);
      if (patch.icon !== undefined) this.run("UPDATE prompts SET icon = ? WHERE id = ?", patch.icon, promptId);
      this.run("UPDATE prompts SET updated_at = ? WHERE id = ?", now(), promptId);
      this.reindexPrompt(promptId);
      return this.mustGetPrompt(promptId);
    })();
  }

  listPrompts(options: ListPromptsOptions = {}): PromptRow[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (options.deletedOnly) {
      where.push("p.deleted_at IS NOT NULL");
    } else if (!options.includeDeleted) {
      where.push("p.deleted_at IS NULL");
    }
    if (options.starred !== undefined) {
      where.push("p.is_starred = ?");
      params.push(options.starred ? 1 : 0);
    }
    if (options.collectionId) {
      where.push(
        "EXISTS (SELECT 1 FROM collection_prompts cp WHERE cp.prompt_id = p.id AND cp.collection_id = ?)",
      );
      params.push(options.collectionId);
    }
    if (options.tagIds && options.tagIds.length > 0) {
      const placeholders = options.tagIds.map(() => "?").join(", ");
      where.push(`EXISTS (SELECT 1 FROM prompt_tags pt WHERE pt.prompt_id = p.id AND pt.tag_id IN (${placeholders}))`);
      params.push(...options.tagIds);
    }

    const orderBy: Record<PromptSort, string> = {
      updated: "p.updated_at DESC",
      created: "p.created_at DESC",
      title: "p.title COLLATE NOCASE ASC",
      rating: "avg_rating IS NULL, avg_rating DESC",
    };

    const innerSql = `
      SELECT p.*, (
        SELECT AVG(val) FROM (
          SELECT effectiveness AS val FROM ratings r WHERE r.target_type = 'prompt' AND r.target_id = p.id AND r.effectiveness IS NOT NULL
          UNION ALL
          SELECT clarity FROM ratings r WHERE r.target_type = 'prompt' AND r.target_id = p.id AND r.clarity IS NOT NULL
          UNION ALL
          SELECT completeness FROM ratings r WHERE r.target_type = 'prompt' AND r.target_id = p.id AND r.completeness IS NOT NULL
          UNION ALL
          SELECT actionability FROM ratings r WHERE r.target_type = 'prompt' AND r.target_id = p.id AND r.actionability IS NOT NULL
        )
      ) AS avg_rating
      FROM prompts p
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`;

    const orderClause = `ORDER BY ${orderBy[options.sort ?? "updated"]}`;
    let sql = `${innerSql} ${orderClause}`;
    if (options.minRating !== undefined) {
      sql = `SELECT * FROM (${innerSql}) p WHERE avg_rating >= ? ${orderClause}`;
      params.push(options.minRating);
    }

    type RowWithAvg = PromptRow & { avg_rating: number | null };
    return this.all<RowWithAvg>(sql, ...params).map(({ avg_rating: _avg, ...row }) => row);
  }

  setStarred(promptId: string, starred: boolean): void {
    const result = this.db
      .prepare("UPDATE prompts SET is_starred = ? WHERE id = ?")
      .run(starred ? 1 : 0, promptId);
    if (result.changes === 0) throw new Error(`Prompt not found: ${promptId}`);
  }

  softDeletePrompt(promptId: string): void {
    const result = this.db.prepare("UPDATE prompts SET deleted_at = ? WHERE id = ?").run(now(), promptId);
    if (result.changes === 0) throw new Error(`Prompt not found: ${promptId}`);
  }

  restorePrompt(promptId: string): void {
    const result = this.db.prepare("UPDATE prompts SET deleted_at = NULL WHERE id = ?").run(promptId);
    if (result.changes === 0) throw new Error(`Prompt not found: ${promptId}`);
  }

  hardDeletePrompt(promptId: string): void {
    this.mustGetPrompt(promptId);
    this.db.transaction(() => {
      this.run("DELETE FROM search_index WHERE prompt_id = ?", promptId);
      this.run("DELETE FROM runs WHERE prompt_id = ?", promptId);
      this.run("DELETE FROM notes WHERE prompt_id = ?", promptId);
      // Ratings targeting versions have no FK — delete them explicitly, before
      // the versions rows disappear, or they would be orphaned.
      this.run(
        `DELETE FROM ratings WHERE target_type = 'version'
         AND target_id IN (SELECT id FROM versions WHERE prompt_id = ?)`,
        promptId,
      );
      // Clear the FK pointer into versions before removing them.
      this.run("UPDATE prompts SET current_version_id = NULL WHERE id = ?", promptId);
      this.run("DELETE FROM versions WHERE prompt_id = ?", promptId);
      this.run("DELETE FROM branches WHERE prompt_id = ?", promptId);
      this.run("DELETE FROM prompt_tags WHERE prompt_id = ?", promptId);
      this.run("DELETE FROM collection_prompts WHERE prompt_id = ?", promptId);
      this.run("DELETE FROM ratings WHERE target_type = 'prompt' AND target_id = ?", promptId);
      this.run("DELETE FROM prompts WHERE id = ?", promptId);
    })();
  }

  // --------------------------------------------------------------- versions

  createVersion(input: {
    promptId: string;
    branchId: string;
    content: string;
    changeNote?: string;
    label?: string;
    contentFormat?: string;
  }): VersionRow {
    const branch = this.get<BranchRow>(
      "SELECT * FROM branches WHERE id = ? AND prompt_id = ?",
      input.branchId,
      input.promptId,
    );
    if (!branch) throw new Error(`Branch ${input.branchId} not found on prompt ${input.promptId}`);

    return this.db.transaction((): VersionRow => {
      const head = this.getBranchHead(input.branchId);
      const versionId = randomUUID();
      this.run(
        `INSERT INTO versions
           (id, prompt_id, branch_id, parent_version_id, number, label, content, content_format, change_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        versionId,
        input.promptId,
        input.branchId,
        head?.id ?? null,
        (head?.number ?? 0) + 1,
        input.label ?? null,
        input.content,
        input.contentFormat ?? "markdown",
        input.changeNote ?? null,
        now(),
      );
      this.run(
        "UPDATE prompts SET current_version_id = ?, updated_at = ? WHERE id = ?",
        versionId,
        now(),
        input.promptId,
      );
      this.reindexPrompt(input.promptId);
      return this.get<VersionRow>("SELECT * FROM versions WHERE id = ?", versionId)!;
    })();
  }

  getVersion(versionId: string): VersionRow | null {
    return this.get<VersionRow>("SELECT * FROM versions WHERE id = ?", versionId) ?? null;
  }

  /**
   * Versions of a prompt, ordered by branch creation then per-branch number.
   * By default only 'active' versions are returned; pass `includePending` to
   * also see 'pending'/'rejected' agent suggestions.
   */
  listVersions(promptId: string, options: { includePending?: boolean } = {}): VersionWithBranch[] {
    return this.all<VersionWithBranch>(
      `SELECT v.*, b.name AS branch_name
       FROM versions v JOIN branches b ON b.id = v.branch_id
       WHERE v.prompt_id = ?${options.includePending ? "" : " AND v.status = 'active'"}
       ORDER BY b.created_at ASC, b.name ASC, v.number ASC`,
      promptId,
    );
  }

  /** Latest (highest-numbered) active version on a branch, or null if none. */
  getBranchHead(branchId: string): VersionRow | null {
    return (
      this.get<VersionRow>(
        "SELECT * FROM versions WHERE branch_id = ? AND status = 'active' ORDER BY number DESC LIMIT 1",
        branchId,
      ) ?? null
    );
  }

  /** Points the prompt's current version at an existing version (restore-as-current). */
  setCurrentVersion(promptId: string, versionId: string): PromptRow {
    const version = this.get<VersionRow>(
      "SELECT * FROM versions WHERE id = ? AND prompt_id = ?",
      versionId,
      promptId,
    );
    if (!version) throw new Error(`Version ${versionId} not found on prompt ${promptId}`);
    if (version.status !== "active") {
      throw new Error(
        `Version ${versionId} is ${version.status} — only active versions can be made current`,
      );
    }
    this.run(
      "UPDATE prompts SET current_version_id = ?, updated_at = ? WHERE id = ?",
      versionId,
      now(),
      promptId,
    );
    return this.mustGetPrompt(promptId);
  }

  // --------------------------------------------------------------- branches

  createBranch(input: {
    promptId: string;
    name: string;
    fromVersionId: string;
    description?: string;
  }): { branch: BranchRow; version: VersionRow } {
    if (!input.name.trim()) throw new Error("Branch name must not be empty");
    const source = this.get<VersionRow>(
      "SELECT * FROM versions WHERE id = ? AND prompt_id = ?",
      input.fromVersionId,
      input.promptId,
    );
    if (!source) throw new Error(`Version ${input.fromVersionId} not found on prompt ${input.promptId}`);
    if (this.get<BranchRow>("SELECT * FROM branches WHERE prompt_id = ? AND name = ?", input.promptId, input.name)) {
      throw new Error(`Branch "${input.name}" already exists on prompt ${input.promptId}`);
    }

    return this.db.transaction(() => {
      const ts = now();
      const branchId = randomUUID();
      this.run(
        "INSERT INTO branches (id, prompt_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)",
        branchId,
        input.promptId,
        input.name,
        input.description ?? null,
        ts,
      );
      const versionId = randomUUID();
      this.run(
        `INSERT INTO versions
           (id, prompt_id, branch_id, parent_version_id, number, content, content_format, change_note, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        versionId,
        input.promptId,
        branchId,
        input.fromVersionId,
        source.content,
        source.content_format,
        `Branched from version ${source.number}`,
        ts,
      );
      this.reindexPrompt(input.promptId);
      return {
        branch: this.get<BranchRow>("SELECT * FROM branches WHERE id = ?", branchId)!,
        version: this.get<VersionRow>("SELECT * FROM versions WHERE id = ?", versionId)!,
      };
    })();
  }

  listBranches(promptId: string): BranchRow[] {
    return this.all<BranchRow>(
      "SELECT * FROM branches WHERE prompt_id = ? ORDER BY created_at ASC, name ASC",
      promptId,
    );
  }

  // ------------------------------------------------------------ suggestions

  /**
   * Agent entry point: propose a variation of a prompt. Creates a new branch
   * (default name `agent-YYYYMMDD-<shortid>`) rooted at `baseVersionId` with a
   * single **pending** version holding the proposed content. Nothing becomes
   * searchable, listable or current until a human approves it in the app.
   */
  suggestVariation(input: {
    promptId: string;
    baseVersionId: string;
    newContent: string;
    rationale: string;
    source?: VersionSource;
    branchName?: string;
  }): { branch: BranchRow; version: VersionRow } {
    this.mustGetPrompt(input.promptId);
    const base = this.get<VersionRow>(
      "SELECT * FROM versions WHERE id = ? AND prompt_id = ?",
      input.baseVersionId,
      input.promptId,
    );
    if (!base) throw new Error(`Version ${input.baseVersionId} not found on prompt ${input.promptId}`);
    if (!input.newContent.trim()) throw new Error("Suggested content must not be empty");
    if (!input.rationale.trim()) throw new Error("A rationale is required for a suggestion");
    const source = input.source ?? "agent";

    return this.db.transaction(() => {
      const ts = now();
      const branchName = input.branchName ?? this.freshAgentBranchName(input.promptId, ts);
      if (this.get<BranchRow>("SELECT * FROM branches WHERE prompt_id = ? AND name = ?", input.promptId, branchName)) {
        throw new Error(`Branch "${branchName}" already exists on prompt ${input.promptId}`);
      }
      const branchId = randomUUID();
      this.run(
        "INSERT INTO branches (id, prompt_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)",
        branchId,
        input.promptId,
        branchName,
        input.rationale,
        ts,
      );
      const versionId = randomUUID();
      this.run(
        `INSERT INTO versions
           (id, prompt_id, branch_id, parent_version_id, number, content, content_format, change_note, author, status, source, created_at)
         VALUES (?, ?, ?, ?, 1, ?, 'markdown', ?, ?, 'pending', ?, ?)`,
        versionId,
        input.promptId,
        branchId,
        base.id,
        input.newContent,
        input.rationale,
        source === "agent" ? "Agent" : "You",
        source,
        ts,
      );
      // Pending versions are deliberately NOT reindexed into FTS and do not
      // move the current pointer or updated_at — they are invisible until approved.
      return {
        branch: this.get<BranchRow>("SELECT * FROM branches WHERE id = ?", branchId)!,
        version: this.get<VersionRow>("SELECT * FROM versions WHERE id = ?", versionId)!,
      };
    })();
  }

  /** Generates a unique `agent-YYYYMMDD-<shortid>` branch name for a prompt. */
  private freshAgentBranchName(promptId: string, ts: string): string {
    const date = ts.slice(0, 10).replace(/-/g, "");
    for (let attempt = 0; attempt < 10; attempt++) {
      const name = `agent-${date}-${randomUUID().slice(0, 8)}`;
      if (!this.get<BranchRow>("SELECT id FROM branches WHERE prompt_id = ? AND name = ?", promptId, name)) {
        return name;
      }
    }
    throw new Error("Could not allocate a unique agent branch name");
  }

  /** All pending suggestions across the library, newest first. */
  listSuggestions(): SuggestionItem[] {
    return this.all<SuggestionItem>(
      `SELECT v.*, b.name AS branch_name, p.title AS prompt_title
       FROM versions v
       JOIN branches b ON b.id = v.branch_id
       JOIN prompts p ON p.id = v.prompt_id
       WHERE v.status = 'pending'
       ORDER BY v.created_at DESC, v.rowid DESC`,
    );
  }

  /**
   * Approves a pending suggestion: the version becomes active (searchable,
   * listed, eligible as current). Optionally makes it the prompt's current
   * version.
   */
  approveSuggestion(versionId: string, options: { setAsCurrent?: boolean } = {}): VersionRow {
    const version = this.get<VersionRow>("SELECT * FROM versions WHERE id = ?", versionId);
    if (!version) throw new Error(`Version not found: ${versionId}`);
    if (version.status !== "pending") {
      throw new Error(`Version ${versionId} is ${version.status} — only pending suggestions can be approved`);
    }
    return this.db.transaction((): VersionRow => {
      this.run("UPDATE versions SET status = 'active' WHERE id = ?", versionId);
      this.reindexPrompt(version.prompt_id);
      if (options.setAsCurrent) {
        this.run(
          "UPDATE prompts SET current_version_id = ?, updated_at = ? WHERE id = ?",
          versionId,
          now(),
          version.prompt_id,
        );
      }
      return this.get<VersionRow>("SELECT * FROM versions WHERE id = ?", versionId)!;
    })();
  }

  /** Rejects a pending suggestion: kept for history but permanently inactive. */
  rejectSuggestion(versionId: string): VersionRow {
    const version = this.get<VersionRow>("SELECT * FROM versions WHERE id = ?", versionId);
    if (!version) throw new Error(`Version not found: ${versionId}`);
    if (version.status !== "pending") {
      throw new Error(`Version ${versionId} is ${version.status} — only pending suggestions can be rejected`);
    }
    this.run("UPDATE versions SET status = 'rejected' WHERE id = ?", versionId);
    return this.get<VersionRow>("SELECT * FROM versions WHERE id = ?", versionId)!;
  }

  // ------------------------------------------------------------------ draft

  setDraft(promptId: string, content: string | null): void {
    this.mustGetPrompt(promptId);
    this.run("UPDATE prompts SET draft_content = ? WHERE id = ?", content, promptId);
  }

  getDraft(promptId: string): string | null {
    return this.mustGetPrompt(promptId).draft_content;
  }

  // ------------------------------------------------------------------ notes

  addNote(input: { promptId: string; versionId?: string; body: string }): NoteRow {
    if (!input.body.trim()) throw new Error("Note body must not be empty");
    if (input.versionId) {
      const version = this.get<VersionRow>(
        "SELECT * FROM versions WHERE id = ? AND prompt_id = ?",
        input.versionId,
        input.promptId,
      );
      if (!version) throw new Error(`Version ${input.versionId} not found on prompt ${input.promptId}`);
    }
    return this.db.transaction((): NoteRow => {
      const id = randomUUID();
      this.run(
        "INSERT INTO notes (id, prompt_id, version_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        input.promptId,
        input.versionId ?? null,
        input.body,
        now(),
      );
      this.reindexPrompt(input.promptId);
      return this.get<NoteRow>("SELECT * FROM notes WHERE id = ?", id)!;
    })();
  }

  listNotes(promptId: string, versionId?: string): NoteRow[] {
    if (versionId) {
      return this.all<NoteRow>(
        "SELECT * FROM notes WHERE prompt_id = ? AND version_id = ? ORDER BY created_at ASC",
        promptId,
        versionId,
      );
    }
    return this.all<NoteRow>("SELECT * FROM notes WHERE prompt_id = ? ORDER BY created_at ASC", promptId);
  }

  deleteNote(noteId: string): void {
    const note = this.get<NoteRow>("SELECT * FROM notes WHERE id = ?", noteId);
    if (!note) throw new Error(`Note not found: ${noteId}`);
    this.db.transaction(() => {
      this.run("DELETE FROM notes WHERE id = ?", noteId);
      this.reindexPrompt(note.prompt_id);
    })();
  }

  // ------------------------------------------------------------------- tags

  createTag(input: { name: string; color?: string }): TagRow {
    if (!input.name.trim()) throw new Error("Tag name must not be empty");
    const id = randomUUID();
    this.run("INSERT INTO tags (id, name, color) VALUES (?, ?, ?)", id, input.name, input.color ?? null);
    return this.get<TagRow>("SELECT * FROM tags WHERE id = ?", id)!;
  }

  listTags(): Array<TagRow & { usage_count: number }> {
    return this.all<TagRow & { usage_count: number }>(
      `SELECT t.*, (SELECT COUNT(*) FROM prompt_tags pt WHERE pt.tag_id = t.id) AS usage_count
       FROM tags t ORDER BY t.name COLLATE NOCASE ASC`,
    );
  }

  addTagToPrompt(promptId: string, tagId: string): void {
    this.mustGetPrompt(promptId);
    this.db.transaction(() => {
      this.run("INSERT OR IGNORE INTO prompt_tags (prompt_id, tag_id) VALUES (?, ?)", promptId, tagId);
      this.reindexPrompt(promptId);
    })();
  }

  /** Tags attached to one prompt (the share payload carries tag names). */
  listTagsForPrompt(promptId: string): TagRow[] {
    return this.all<TagRow>(
      `SELECT t.* FROM tags t JOIN prompt_tags pt ON pt.tag_id = t.id
       WHERE pt.prompt_id = ? ORDER BY t.name COLLATE NOCASE ASC`,
      promptId,
    );
  }

  removeTagFromPrompt(promptId: string, tagId: string): void {
    this.db.transaction(() => {
      this.run("DELETE FROM prompt_tags WHERE prompt_id = ? AND tag_id = ?", promptId, tagId);
      this.reindexPrompt(promptId);
    })();
  }

  /** Replaces the full tag set of a prompt. */
  setPromptTags(promptId: string, tagIds: string[]): void {
    this.mustGetPrompt(promptId);
    this.db.transaction(() => {
      this.run("DELETE FROM prompt_tags WHERE prompt_id = ?", promptId);
      for (const tagId of tagIds) {
        this.run("INSERT OR IGNORE INTO prompt_tags (prompt_id, tag_id) VALUES (?, ?)", promptId, tagId);
      }
      this.reindexPrompt(promptId);
    })();
  }

  // ------------------------------------------------------------- collections

  createCollection(input: { name: string; sortOrder?: number }): CollectionRow {
    if (!input.name.trim()) throw new Error("Collection name must not be empty");
    const id = randomUUID();
    this.run(
      "INSERT INTO collections (id, name, sort_order) VALUES (?, ?, ?)",
      id,
      input.name,
      input.sortOrder ?? 0,
    );
    return this.get<CollectionRow>("SELECT * FROM collections WHERE id = ?", id)!;
  }

  listCollections(): Array<CollectionRow & { prompt_count: number }> {
    return this.all<CollectionRow & { prompt_count: number }>(
      `SELECT c.*, (SELECT COUNT(*) FROM collection_prompts cp WHERE cp.collection_id = c.id) AS prompt_count
       FROM collections c ORDER BY c.sort_order ASC, c.name COLLATE NOCASE ASC`,
    );
  }

  addPromptToCollection(collectionId: string, promptId: string, sortOrder = 0): void {
    this.run(
      "INSERT OR IGNORE INTO collection_prompts (collection_id, prompt_id, sort_order) VALUES (?, ?, ?)",
      collectionId,
      promptId,
      sortOrder,
    );
  }

  removePromptFromCollection(collectionId: string, promptId: string): void {
    this.run(
      "DELETE FROM collection_prompts WHERE collection_id = ? AND prompt_id = ?",
      collectionId,
      promptId,
    );
  }

  /** Ids of the collections a prompt belongs to. */
  listCollectionIdsForPrompt(promptId: string): string[] {
    return this.all<{ collection_id: string }>(
      "SELECT collection_id FROM collection_prompts WHERE prompt_id = ? ORDER BY sort_order ASC",
      promptId,
    ).map((row) => row.collection_id);
  }

  // ------------------------------------------------------ shared snapshots

  /** Records a freshly published snapshot (see migrations.ts v5 for the token rationale). */
  recordSharedSnapshot(input: {
    snapshotId: string;
    promptId: string;
    portalBaseUrl: string;
    url: string;
    deleteToken: string;
    fullHistory: boolean;
    publishedAt: string;
  }): SharedSnapshotRow {
    this.mustGetPrompt(input.promptId);
    this.run(
      `INSERT INTO shared_snapshots
         (snapshot_id, prompt_id, portal_base_url, url, delete_token, full_history, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.snapshotId,
      input.promptId,
      input.portalBaseUrl,
      input.url,
      input.deleteToken,
      input.fullHistory ? 1 : 0,
      input.publishedAt,
    );
    return this.getSharedSnapshot(input.snapshotId)!;
  }

  getSharedSnapshot(snapshotId: string): SharedSnapshotRow | null {
    return (
      this.get<SharedSnapshotRow>(
        "SELECT * FROM shared_snapshots WHERE snapshot_id = ?",
        snapshotId,
      ) ?? null
    );
  }

  /** Newest first; revoked shares included (the UI greys them out). */
  listSharedSnapshots(promptId?: string): SharedSnapshotRow[] {
    if (promptId !== undefined) {
      return this.all<SharedSnapshotRow>(
        "SELECT * FROM shared_snapshots WHERE prompt_id = ? ORDER BY published_at DESC",
        promptId,
      );
    }
    return this.all<SharedSnapshotRow>(
      "SELECT * FROM shared_snapshots ORDER BY published_at DESC",
    );
  }

  /** Soft delete: the row stays so the UI can show the share as revoked. */
  markSharedSnapshotDeleted(snapshotId: string): void {
    this.run(
      "UPDATE shared_snapshots SET deleted_at = ? WHERE snapshot_id = ? AND deleted_at IS NULL",
      now(),
      snapshotId,
    );
  }

  // -------------------------------------------------------------- settings

  getSetting(key: string): string | null {
    const row = this.get<SettingRow>("SELECT * FROM settings WHERE key = ?", key);
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /**
   * Active versions of the prompt's default branch ('main', falling back to
   * the earliest-created branch), oldest first — the history included in a
   * full-history snapshot publish.
   */
  listDefaultBranchVersions(promptId: string): VersionRow[] {
    const branches = this.listBranches(promptId);
    const branch = branches.find((b) => b.name === "main") ?? branches[0];
    if (!branch) return [];
    return this.all<VersionRow>(
      `SELECT * FROM versions
       WHERE prompt_id = ? AND branch_id = ? AND status = 'active'
       ORDER BY number ASC`,
      promptId,
      branch.id,
    );
  }

  // --------------------------------------------------------------- activity

  /**
   * Global activity feed: most recently created versions across all prompts
   * (including soft-deleted ones), newest first.
   */
  listRecentActivity(limit = 50): ActivityItem[] {
    return this.all<ActivityItem>(
      `SELECT v.prompt_id, p.title AS prompt_title, v.id AS version_id,
              v.number, v.label, b.name AS branch_name, v.change_note, v.created_at
       FROM versions v
       JOIN prompts p ON p.id = v.prompt_id
       JOIN branches b ON b.id = v.branch_id
       ORDER BY v.created_at DESC, v.rowid DESC
       LIMIT ?`,
      limit,
    );
  }

  // ---------------------------------------------------------------- ratings

  addRating(
    input: {
      targetType: RatingTargetType;
      targetId: string;
    } & Partial<Record<RatingDimension, number>>,
  ): RatingRow {
    const scores = RATING_DIMENSIONS.map((d) => input[d]).filter((v): v is number => v !== undefined);
    if (scores.length === 0) throw new Error("Rating requires at least one dimension score");
    for (const score of scores) {
      if (score < 1 || score > 5) {
        throw new Error(`Rating scores must be between 1 and 5, got ${score}`);
      }
    }
    const id = randomUUID();
    this.run(
      `INSERT INTO ratings (id, target_type, target_id, effectiveness, clarity, completeness, actionability, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.targetType,
      input.targetId,
      input.effectiveness ?? null,
      input.clarity ?? null,
      input.completeness ?? null,
      input.actionability ?? null,
      now(),
    );
    return this.get<RatingRow>("SELECT * FROM ratings WHERE id = ?", id)!;
  }

  getLatestRating(targetType: RatingTargetType, targetId: string): RatingRow | null {
    return (
      this.get<RatingRow>(
        "SELECT * FROM ratings WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        targetType,
        targetId,
      ) ?? null
    );
  }

  getAverageRatings(targetType: RatingTargetType, targetId: string): AverageRatings {
    const perDimension = this.get<{
      effectiveness: number | null;
      clarity: number | null;
      completeness: number | null;
      actionability: number | null;
      count: number;
    }>(
      `SELECT AVG(effectiveness) AS effectiveness, AVG(clarity) AS clarity,
              AVG(completeness) AS completeness, AVG(actionability) AS actionability,
              COUNT(*) AS count
       FROM ratings WHERE target_type = ? AND target_id = ?`,
      targetType,
      targetId,
    )!;
    const overall = this.get<{ overall: number | null }>(
      `SELECT AVG(val) AS overall FROM (
         SELECT effectiveness AS val FROM ratings WHERE target_type = ? AND target_id = ? AND effectiveness IS NOT NULL
         UNION ALL
         SELECT clarity FROM ratings WHERE target_type = ? AND target_id = ? AND clarity IS NOT NULL
         UNION ALL
         SELECT completeness FROM ratings WHERE target_type = ? AND target_id = ? AND completeness IS NOT NULL
         UNION ALL
         SELECT actionability FROM ratings WHERE target_type = ? AND target_id = ? AND actionability IS NOT NULL
       )`,
      targetType,
      targetId,
      targetType,
      targetId,
      targetType,
      targetId,
      targetType,
      targetId,
    )!;
    return { ...perDimension, overall: overall.overall };
  }

  /** Average ratings per version of a prompt, for versions that have ratings. */
  getVersionRatingSummaries(promptId: string): Array<AverageRatings & { version_id: string }> {
    const ids = this.all<{ target_id: string }>(
      `SELECT DISTINCT target_id FROM ratings
       WHERE target_type = 'version'
         AND target_id IN (SELECT id FROM versions WHERE prompt_id = ?)`,
      promptId,
    );
    return ids.map(({ target_id }) => ({
      version_id: target_id,
      ...this.getAverageRatings("version", target_id),
    }));
  }

  // ------------------------------------------------------------------- runs

  addRun(input: {
    promptId: string;
    versionId: string;
    tool?: string;
    model?: string;
    provider?: string;
    status?: RunStatus;
    output?: string;
    error?: string;
    latencyMs?: number;
    runGroupId?: string;
    outcomeRating?: number;
    resultSummary?: string;
    metrics?: Record<string, unknown>;
    startedAt?: string;
  }): RunRow {
    if (input.outcomeRating !== undefined && (input.outcomeRating < 1 || input.outcomeRating > 5)) {
      throw new Error(`Outcome rating must be between 1 and 5, got ${input.outcomeRating}`);
    }
    if (input.status !== undefined && input.status !== "completed" && input.status !== "error") {
      throw new Error(`Run status must be 'completed' or 'error', got ${input.status}`);
    }
    const version = this.get<VersionRow>(
      "SELECT * FROM versions WHERE id = ? AND prompt_id = ?",
      input.versionId,
      input.promptId,
    );
    if (!version) throw new Error(`Version ${input.versionId} not found on prompt ${input.promptId}`);
    const id = randomUUID();
    this.run(
      `INSERT INTO runs
         (id, prompt_id, version_id, tool, model, provider, status, output, error, latency_ms, run_group_id,
          outcome_rating, result_summary, metrics_json, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.promptId,
      input.versionId,
      input.tool ?? "manual",
      input.model ?? null,
      input.provider ?? null,
      input.status ?? "completed",
      input.output ?? null,
      input.error ?? null,
      input.latencyMs ?? null,
      input.runGroupId ?? null,
      input.outcomeRating ?? null,
      input.resultSummary ?? null,
      input.metrics !== undefined ? JSON.stringify(input.metrics) : null,
      input.startedAt ?? null,
      now(),
    );
    return this.get<RunRow>("SELECT * FROM runs WHERE id = ?", id)!;
  }

  /**
   * Records one executed model run (tool 'prompthub-run'). Status drives the
   * output/error contract: completed runs carry output, error runs carry the
   * normalized error message.
   */
  recordModelRun(input: {
    promptId: string;
    versionId: string;
    provider: string;
    model: string;
    status: RunStatus;
    output?: string;
    error?: string;
    latencyMs?: number;
    runGroupId?: string;
    metrics?: Record<string, unknown>;
    startedAt?: string;
  }): RunRow {
    if (input.status === "completed" && input.output === undefined) {
      throw new Error("Completed runs must carry their output");
    }
    if (input.status === "error" && !input.error?.trim()) {
      throw new Error("Failed runs must carry an error message");
    }
    const resultSummary =
      input.status === "completed" && input.output !== undefined
        ? input.output.replace(/\s+/g, " ").trim().slice(0, 280) || undefined
        : undefined;
    return this.addRun({
      ...input,
      tool: "prompthub-run",
      ...(resultSummary !== undefined ? { resultSummary } : {}),
    });
  }

  listRuns(promptId: string, options: { runGroupId?: string } = {}): RunRow[] {
    if (options.runGroupId !== undefined) {
      return this.all<RunRow>(
        "SELECT * FROM runs WHERE prompt_id = ? AND run_group_id = ? ORDER BY created_at DESC, rowid DESC",
        promptId,
        options.runGroupId,
      );
    }
    return this.all<RunRow>(
      "SELECT * FROM runs WHERE prompt_id = ? ORDER BY created_at DESC, rowid DESC",
      promptId,
    );
  }

  deleteRun(runId: string): void {
    const result = this.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    if (result.changes === 0) throw new Error(`Run not found: ${runId}`);
  }

  /** Sets (or clears, with null) the outcome rating of a single run. */
  updateRunOutcome(runId: string, outcomeRating: number | null): RunRow {
    if (outcomeRating !== null && (outcomeRating < 1 || outcomeRating > 5)) {
      throw new Error(`Outcome rating must be between 1 and 5, got ${outcomeRating}`);
    }
    const result = this.db
      .prepare("UPDATE runs SET outcome_rating = ? WHERE id = ?")
      .run(outcomeRating, runId);
    if (result.changes === 0) throw new Error(`Run not found: ${runId}`);
    return this.get<RunRow>("SELECT * FROM runs WHERE id = ?", runId)!;
  }

  /**
   * Shallow-merges `patch` into a run's metrics_json blob. Existing keys not
   * named in the patch (usage, costUsd, …) are preserved; a corrupt stored
   * blob is treated as empty. Values must be JSON-serializable. The reserved
   * execution keys `usage`/`costUsd` are owned by recordModelRun — patches
   * containing them are rejected so callers can't rewrite execution facts.
   */
  updateRunMetrics(runId: string, patch: Record<string, unknown>): RunRow {
    for (const key of Object.keys(patch)) {
      if (RESERVED_METRICS_KEYS.has(key)) {
        throw new Error(`metrics_json key "${key}" is reserved and cannot be patched`);
      }
    }
    const row = this.get<RunRow>("SELECT * FROM runs WHERE id = ?", runId);
    if (!row) throw new Error(`Run not found: ${runId}`);
    let current: Record<string, unknown> = {};
    if (row.metrics_json !== null) {
      try {
        const parsed: unknown = JSON.parse(row.metrics_json);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        // Corrupt blob — start from an empty object rather than throwing.
      }
    }
    const merged = JSON.stringify({ ...current, ...patch });
    this.db.prepare("UPDATE runs SET metrics_json = ? WHERE id = ?").run(merged, runId);
    return this.get<RunRow>("SELECT * FROM runs WHERE id = ?", runId)!;
  }

  /** All runs of one run group, in creation order; empty when unknown. */
  listRunGroupRuns(runGroupId: string): RunRow[] {
    return this.all<RunRow>(
      "SELECT * FROM runs WHERE run_group_id = ? ORDER BY created_at ASC, rowid ASC",
      runGroupId,
    );
  }

  /**
   * Multi-model executions of a prompt, grouped by run_group_id (newest group
   * first, runs in creation order). Provider names are joined when the
   * provider row still exists; deleted providers leave provider_name null.
   */
  listRunGroups(promptId: string): RunGroup[] {
    const rows = this.all<RunRow & { provider_name: string | null }>(
      `SELECT r.*, p.name AS provider_name
       FROM runs r LEFT JOIN providers p ON p.id = r.provider
       WHERE r.prompt_id = ? AND r.run_group_id IS NOT NULL
       ORDER BY r.created_at DESC, r.rowid DESC`,
      promptId,
    );
    const groups = new Map<string, RunGroup>();
    // Rows arrive newest-first; unshift so each group's runs end up in
    // creation order and the first row seen sets the group's timestamp.
    for (const { provider_name, ...row } of rows) {
      let group = groups.get(row.run_group_id!);
      if (!group) {
        group = { runGroupId: row.run_group_id!, createdAt: row.created_at, runs: [] };
        groups.set(row.run_group_id!, group);
      }
      group.runs.unshift({
        id: row.id,
        versionId: row.version_id,
        provider: row.provider,
        providerName: provider_name,
        model: row.model,
        status: row.status,
        outcomeRating: row.outcome_rating,
        output: row.output,
        error: row.error,
        latencyMs: row.latency_ms,
        ...parseRunMetrics(row.metrics_json),
        createdAt: row.created_at,
      });
      if (row.created_at > group.createdAt) group.createdAt = row.created_at;
    }
    return [...groups.values()];
  }

  // -------------------------------------------------------------- providers

  createProvider(input: {
    type: string;
    name: string;
    /** Execution driver; defaults to `type` (valid for the four native ids). */
    driver?: string;
    /** Opaque encrypted key blob; encryption happens in the desktop main process. */
    apiKeyEnc?: string;
    baseUrl?: string;
    enabled?: boolean;
  }): ProviderRow {
    if (!input.type.trim()) throw new Error("Provider type must not be empty");
    if (!input.name.trim()) throw new Error("Provider name must not be empty");
    const id = randomUUID();
    this.run(
      "INSERT INTO providers (id, type, driver, name, api_key_enc, base_url, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.type,
      input.driver ?? input.type,
      input.name,
      input.apiKeyEnc ?? null,
      input.baseUrl ?? null,
      input.enabled === false ? 0 : 1,
      now(),
    );
    return this.get<ProviderRow>("SELECT * FROM providers WHERE id = ?", id)!;
  }

  getProvider(providerId: string): ProviderRow | null {
    return this.get<ProviderRow>("SELECT * FROM providers WHERE id = ?", providerId) ?? null;
  }

  /** All providers, newest last. The api_key_enc blob travels as-is (opaque). */
  listProviders(): ProviderRow[] {
    return this.all<ProviderRow>("SELECT * FROM providers ORDER BY created_at ASC, rowid ASC");
  }

  updateProvider(
    providerId: string,
    patch: {
      name?: string;
      apiKeyEnc?: string | null;
      baseUrl?: string | null;
      enabled?: boolean;
    },
  ): ProviderRow {
    const existing = this.getProvider(providerId);
    if (!existing) throw new Error(`Provider not found: ${providerId}`);
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new Error("Provider name must not be empty");
    }
    if (patch.name !== undefined) this.run("UPDATE providers SET name = ? WHERE id = ?", patch.name, providerId);
    if (patch.apiKeyEnc !== undefined)
      this.run("UPDATE providers SET api_key_enc = ? WHERE id = ?", patch.apiKeyEnc, providerId);
    if (patch.baseUrl !== undefined)
      this.run("UPDATE providers SET base_url = ? WHERE id = ?", patch.baseUrl, providerId);
    if (patch.enabled !== undefined)
      this.run("UPDATE providers SET enabled = ? WHERE id = ?", patch.enabled ? 1 : 0, providerId);
    return this.getProvider(providerId)!;
  }

  /**
   * Deletes a provider and its configured models. Runs are deliberately NOT
   * touched — they are history, and their provider column simply stops
   * resolving to a row.
   */
  deleteProvider(providerId: string): void {
    this.db.transaction(() => {
      this.run("DELETE FROM provider_models WHERE provider_id = ?", providerId);
      const result = this.db.prepare("DELETE FROM providers WHERE id = ?").run(providerId);
      if (result.changes === 0) throw new Error(`Provider not found: ${providerId}`);
    })();
  }

  /** Replaces the full configured model set of a provider. */
  setProviderModels(
    providerId: string,
    models: Array<{ modelId: string; displayName?: string; enabled?: boolean }>,
  ): void {
    if (!this.getProvider(providerId)) throw new Error(`Provider not found: ${providerId}`);
    for (const model of models) {
      if (!model.modelId.trim()) throw new Error("Model id must not be empty");
    }
    this.db.transaction(() => {
      this.run("DELETE FROM provider_models WHERE provider_id = ?", providerId);
      for (const model of models) {
        this.run(
          "INSERT INTO provider_models (provider_id, model_id, display_name, enabled) VALUES (?, ?, ?, ?)",
          providerId,
          model.modelId,
          model.displayName ?? null,
          model.enabled === false ? 0 : 1,
        );
      }
    })();
  }

  listProviderModels(providerId: string, options: { enabledOnly?: boolean } = {}): ProviderModelRow[] {
    return this.all<ProviderModelRow>(
      `SELECT * FROM provider_models WHERE provider_id = ?${options.enabledOnly ? " AND enabled = 1" : ""}
       ORDER BY model_id ASC`,
      providerId,
    );
  }

  // ----------------------------------------------------------- catalog cache

  /**
   * Reads the cached models.dev catalog payload from settings, or null when
   * never fetched. `json` is the raw stringified catalog; parsing is the
   * caller's job (packages/ai).
   */
  getCatalogCache(): { fetchedAt: string; json: string } | null {
    const row = this.get<SettingRow>("SELECT * FROM settings WHERE key = ?", "model_catalog");
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as { fetchedAt?: unknown; json?: unknown };
      if (typeof parsed.fetchedAt === "string" && typeof parsed.json === "string") {
        return { fetchedAt: parsed.fetchedAt, json: parsed.json };
      }
    } catch {
      // Corrupted cache row — treat as absent.
    }
    return null;
  }

  /** Stores the stringified parsed models.dev catalog in the settings table. */
  setCatalogCache(json: string): void {
    this.run(
      "INSERT INTO settings (key, value) VALUES ('model_catalog', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify({ fetchedAt: now(), json }),
    );
  }

  // ----------------------------------------------------------------- search

  /**
   * Full-text search over title, description, tag names, note bodies and
   * version content. Tokens are matched as prefixes (porter-stemmed). Results
   * are ranked by bm25 (best first).
   */
  search(query: string, filters: SearchFilters = {}): SearchResult[] {
    const match = buildMatchQuery(query);
    if (!match) return [];

    const where = ["search_index MATCH ?", "p.deleted_at IS NULL"];
    const params: unknown[] = [match];

    if (filters.starred !== undefined) {
      where.push("p.is_starred = ?");
      params.push(filters.starred ? 1 : 0);
    }
    if (filters.collectionId) {
      where.push(
        "EXISTS (SELECT 1 FROM collection_prompts cp WHERE cp.prompt_id = p.id AND cp.collection_id = ?)",
      );
      params.push(filters.collectionId);
    }
    if (filters.tagIds && filters.tagIds.length > 0) {
      const placeholders = filters.tagIds.map(() => "?").join(", ");
      where.push(
        `EXISTS (SELECT 1 FROM prompt_tags pt WHERE pt.prompt_id = p.id AND pt.tag_id IN (${placeholders}))`,
      );
      params.push(...filters.tagIds);
    }

    interface RawRow {
      prompt_id: string;
      version_id: string | null;
      title: string;
      snippet: string;
      rank: number;
    }
    const rows = this.all<RawRow>(
      `SELECT s.prompt_id, s.version_id, p.title,
              snippet(search_index, -1, '', '', '…', 24) AS snippet,
              bm25(search_index) AS rank
       FROM search_index s JOIN prompts p ON p.id = s.prompt_id
       WHERE ${where.join(" AND ")}
       ORDER BY rank ASC`,
      ...params,
    );
    return rows.map((row) => ({
      promptId: row.prompt_id,
      versionId: row.version_id,
      title: row.title,
      snippet: row.snippet,
      rank: row.rank,
    }));
  }

  /** Rebuilds all search_index rows for one prompt. Call inside the mutating transaction. */
  private reindexPrompt(promptId: string): void {
    reindexPromptRows(this.db, promptId);
  }

  // ----------------------------------------------------------- export/import

  /**
   * JSON-serializable snapshot of every table. Two deliberate exceptions:
   * provider API keys (providers.api_key_enc) are exported as null by design
   * — they are encrypted with this device's OS keychain, useless anywhere
   * else, and must be re-entered after import. And shared_snapshots is
   * excluded entirely: share records hold plaintext delete tokens that should
   * not travel in export files, so migrating to a new library loses revoke
   * capability — revoke shares before migrating, or re-publish afterwards.
   * Everything else round-trips losslessly.
   */
  exportLibrary(): LibraryExport {
    return {
      meta: { formatVersion: 1, exportedAt: now() },
      tables: {
        prompts: this.all<PromptRow>("SELECT * FROM prompts ORDER BY created_at"),
        branches: this.all<BranchRow>("SELECT * FROM branches ORDER BY created_at"),
        versions: this.all<VersionRow>("SELECT * FROM versions ORDER BY created_at"),
        notes: this.all<NoteRow>("SELECT * FROM notes ORDER BY created_at"),
        tags: this.all<TagRow>("SELECT * FROM tags ORDER BY name"),
        prompt_tags: this.all<PromptTagRow>("SELECT * FROM prompt_tags"),
        collections: this.all<CollectionRow>("SELECT * FROM collections ORDER BY sort_order"),
        collection_prompts: this.all<CollectionPromptRow>("SELECT * FROM collection_prompts"),
        ratings: this.all<RatingRow>("SELECT * FROM ratings ORDER BY created_at"),
        runs: this.all<RunRow>("SELECT * FROM runs ORDER BY created_at"),
        settings: this.all<SettingRow>("SELECT * FROM settings ORDER BY key"),
        providers: this.all<ProviderRow>("SELECT * FROM providers ORDER BY created_at").map((row) => ({
          ...row,
          api_key_enc: null,
        })),
        provider_models: this.all<ProviderModelRow>("SELECT * FROM provider_models ORDER BY provider_id, model_id"),
      },
    };
  }

  /**
   * Imports an export payload. Primary-key collisions get fresh ids and all
   * foreign keys are remapped consistently. Tags and collections colliding on
   * their UNIQUE name are merged into the existing row. Returns per-table
   * counts.
   */
  importLibrary(data: LibraryExport): ImportSummary {
    const summary: ImportSummary = {};
    const bump = (table: string, field: keyof ImportTableSummary) => {
      const entry = (summary[table] ??= { inserted: 0, merged: 0, remapped: 0, skipped: 0 });
      entry[field] += 1;
    };

    this.db.transaction(() => {
      const idMaps = {
        prompts: new Map<string, string>(),
        branches: new Map<string, string>(),
        versions: new Map<string, string>(),
        notes: new Map<string, string>(),
        tags: new Map<string, string>(),
        collections: new Map<string, string>(),
        ratings: new Map<string, string>(),
        runs: new Map<string, string>(),
        providers: new Map<string, string>(),
      };
      const remap = (table: keyof typeof idMaps, id: string | null): string | null =>
        id === null ? null : (idMaps[table].get(id) ?? id);

      // Claims `wantedId` for `table`: returns the id to insert with (fresh on
      // collision) and records the mapping.
      const claimId = (table: keyof typeof idMaps, wantedId: string, existsSql: string): string => {
        const existing = this.get<{ id: string }>(existsSql, wantedId);
        if (existing) {
          const fresh = randomUUID();
          idMaps[table].set(wantedId, fresh);
          bump(table, "remapped");
          return fresh;
        }
        idMaps[table].set(wantedId, wantedId);
        bump(table, "inserted");
        return wantedId;
      };

      // -- tags / collections first (unique-name merge targets)
      for (const tag of data.tables.tags) {
        const byName = this.get<{ id: string }>("SELECT id FROM tags WHERE name = ?", tag.name);
        if (byName) {
          idMaps.tags.set(tag.id, byName.id);
          bump("tags", "merged");
          continue;
        }
        const id = claimId("tags", tag.id, "SELECT id FROM tags WHERE id = ?");
        this.run("INSERT INTO tags (id, name, color) VALUES (?, ?, ?)", id, tag.name, tag.color);
      }
      for (const collection of data.tables.collections) {
        const byName = this.get<{ id: string }>("SELECT id FROM collections WHERE name = ?", collection.name);
        if (byName) {
          idMaps.collections.set(collection.id, byName.id);
          bump("collections", "merged");
          continue;
        }
        const id = claimId("collections", collection.id, "SELECT id FROM collections WHERE id = ?");
        this.run(
          "INSERT INTO collections (id, name, sort_order) VALUES (?, ?, ?)",
          id,
          collection.name,
          collection.sort_order,
        );
      }

      // -- AI provider configuration (pre-v3 bundles have no such tables).
      // Keys are never exported — api_key_enc stays null and the user
      // re-enters keys after import.
      for (const provider of data.tables.providers ?? []) {
        const id = claimId("providers", provider.id, "SELECT id FROM providers WHERE id = ?");
        this.run(
          "INSERT INTO providers (id, type, driver, name, api_key_enc, base_url, enabled, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
          id,
          provider.type,
          provider.driver ?? provider.type,
          provider.name,
          provider.base_url ?? null,
          provider.enabled ?? 1,
          provider.created_at ?? now(),
        );
      }
      for (const pm of data.tables.provider_models ?? []) {
        const result = this.db
          .prepare(
            "INSERT OR IGNORE INTO provider_models (provider_id, model_id, display_name, enabled) VALUES (?, ?, ?, ?)",
          )
          .run(remap("providers", pm.provider_id), pm.model_id, pm.display_name, pm.enabled);
        bump("provider_models", result.changes > 0 ? "inserted" : "skipped");
      }

      // -- prompts: inserted with current_version_id NULL, fixed up after versions
      const pendingCurrentVersion: Array<{ promptId: string; oldVersionId: string }> = [];
      for (const prompt of data.tables.prompts) {
        const id = claimId("prompts", prompt.id, "SELECT id FROM prompts WHERE id = ?");
        this.run(
          `INSERT INTO prompts (id, title, description, icon, draft_content, current_version_id, is_starred, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
          id,
          prompt.title,
          prompt.description,
          prompt.icon,
          prompt.draft_content,
          prompt.is_starred,
          prompt.created_at,
          prompt.updated_at,
          prompt.deleted_at,
        );
        if (prompt.current_version_id) {
          pendingCurrentVersion.push({ promptId: id, oldVersionId: prompt.current_version_id });
        }
      }

      for (const branch of data.tables.branches) {
        const id = claimId("branches", branch.id, "SELECT id FROM branches WHERE id = ?");
        this.run(
          "INSERT INTO branches (id, prompt_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)",
          id,
          remap("prompts", branch.prompt_id),
          branch.name,
          branch.description,
          branch.created_at,
        );
      }

      for (const version of data.tables.versions) {
        const id = claimId("versions", version.id, "SELECT id FROM versions WHERE id = ?");
        this.run(
          `INSERT INTO versions
             (id, prompt_id, branch_id, parent_version_id, number, label, content, content_format, change_note, author, status, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          remap("prompts", version.prompt_id),
          remap("branches", version.branch_id),
          remap("versions", version.parent_version_id),
          version.number,
          version.label,
          version.content,
          version.content_format,
          version.change_note,
          version.author,
          // Bundles exported before schema v2 lack these fields; default them.
          version.status ?? "active",
          version.source ?? "user",
          version.created_at,
        );
      }

      for (const pending of pendingCurrentVersion) {
        this.run(
          "UPDATE prompts SET current_version_id = ? WHERE id = ?",
          remap("versions", pending.oldVersionId),
          pending.promptId,
        );
      }

      for (const note of data.tables.notes) {
        const id = claimId("notes", note.id, "SELECT id FROM notes WHERE id = ?");
        this.run(
          "INSERT INTO notes (id, prompt_id, version_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
          id,
          remap("prompts", note.prompt_id),
          remap("versions", note.version_id),
          note.body,
          note.created_at,
        );
      }

      for (const pt of data.tables.prompt_tags) {
        const promptId = remap("prompts", pt.prompt_id)!;
        const tagId = remap("tags", pt.tag_id)!;
        const result = this.db
          .prepare("INSERT OR IGNORE INTO prompt_tags (prompt_id, tag_id) VALUES (?, ?)")
          .run(promptId, tagId);
        bump("prompt_tags", result.changes > 0 ? "inserted" : "skipped");
      }

      for (const cp of data.tables.collection_prompts) {
        const collectionId = remap("collections", cp.collection_id)!;
        const promptId = remap("prompts", cp.prompt_id)!;
        const result = this.db
          .prepare(
            "INSERT OR IGNORE INTO collection_prompts (collection_id, prompt_id, sort_order) VALUES (?, ?, ?)",
          )
          .run(collectionId, promptId, cp.sort_order);
        bump("collection_prompts", result.changes > 0 ? "inserted" : "skipped");
      }

      for (const rating of data.tables.ratings) {
        const id = claimId("ratings", rating.id, "SELECT id FROM ratings WHERE id = ?");
        this.run(
          `INSERT INTO ratings (id, target_type, target_id, effectiveness, clarity, completeness, actionability, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          rating.target_type,
          rating.target_type === "prompt"
            ? remap("prompts", rating.target_id)
            : remap("versions", rating.target_id),
          rating.effectiveness,
          rating.clarity,
          rating.completeness,
          rating.actionability,
          rating.created_at,
        );
      }

      for (const run of data.tables.runs) {
        const id = claimId("runs", run.id, "SELECT id FROM runs WHERE id = ?");
        this.run(
          `INSERT INTO runs
             (id, prompt_id, version_id, tool, model, provider, status, output, error, latency_ms, run_group_id,
              outcome_rating, result_summary, metrics_json, started_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          remap("prompts", run.prompt_id),
          remap("versions", run.version_id),
          run.tool,
          run.model,
          // Bundles exported before schema v3 lack these fields; default them.
          // Provider references are remapped like other foreign keys (deleted
          // providers pass through unresolved, as in live data).
          remap("providers", run.provider ?? null),
          run.status ?? "completed",
          run.output ?? null,
          run.error ?? null,
          run.latency_ms ?? null,
          run.run_group_id ?? null,
          run.outcome_rating,
          run.result_summary,
          run.metrics_json,
          run.started_at,
          run.created_at,
        );
      }

      for (const setting of data.tables.settings) {
        this.run(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          setting.key,
          setting.value,
        );
        bump("settings", "inserted");
      }

      // Rebuild search rows for every prompt we touched.
      const touched = new Set<string>(idMaps.prompts.values());
      for (const promptId of touched) this.reindexPrompt(promptId);
    })();

    return summary;
  }
}

/**
 * Turns free text into an FTS5 MATCH expression: each token is quoted and
 * prefix-matched ("foo bar" -> `"foo"* "bar"*`, i.e. AND semantics).
 */
function buildMatchQuery(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" ");
}
