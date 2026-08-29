/** Row interfaces mirroring the SQLite schema. All timestamps are ISO-8601 UTC strings. */

export interface PromptRow {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  draft_content: string | null;
  current_version_id: string | null;
  is_starred: 0 | 1;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface BranchRow {
  id: string;
  prompt_id: string;
  name: string;
  description: string | null;
  created_at: string;
}

/**
 * Lifecycle of a version: user-authored versions are 'active' immediately;
 * agent-suggested variations start 'pending' until approved ('active') or
 * 'rejected' in the app's review queue. Pending/rejected versions are excluded
 * from branch heads, default listings, FTS indexing and current eligibility.
 */
export type VersionStatus = "active" | "pending" | "rejected";

/** Who created a version: the user in the app, or an agent via CLI/MCP. */
export type VersionSource = "user" | "agent";

export interface VersionRow {
  id: string;
  prompt_id: string;
  branch_id: string;
  parent_version_id: string | null;
  number: number;
  label: string | null;
  content: string;
  content_format: string;
  change_note: string | null;
  author: string;
  status: VersionStatus;
  source: VersionSource;
  created_at: string;
}

export interface NoteRow {
  id: string;
  prompt_id: string;
  version_id: string | null;
  body: string;
  created_at: string;
}

export interface TagRow {
  id: string;
  name: string;
  color: string | null;
}

export interface PromptTagRow {
  prompt_id: string;
  tag_id: string;
}

export interface CollectionRow {
  id: string;
  name: string;
  sort_order: number;
}

export interface CollectionPromptRow {
  collection_id: string;
  prompt_id: string;
  sort_order: number;
}

export type RatingTargetType = "prompt" | "version";

export interface RatingRow {
  id: string;
  target_type: RatingTargetType;
  target_id: string;
  effectiveness: number | null;
  clarity: number | null;
  completeness: number | null;
  actionability: number | null;
  created_at: string;
}

/** Lifecycle of a run: a completed generation, or a failed one (error set). */
export type RunStatus = "completed" | "error";

export interface RunRow {
  id: string;
  prompt_id: string;
  version_id: string;
  tool: string;
  model: string | null;
  /** Provider row id that executed the run (null for manual runs). */
  provider: string | null;
  status: RunStatus;
  /** Full model output for completed runs. */
  output: string | null;
  /** Normalized error message for failed runs. */
  error: string | null;
  latency_ms: number | null;
  /** Groups runs of one multi-model execution for the compare view. */
  run_group_id: string | null;
  outcome_rating: number | null;
  result_summary: string | null;
  metrics_json: string | null;
  started_at: string | null;
  created_at: string;
}

/** A configured AI provider. api_key_enc is an opaque blob encrypted by the
 * desktop main process (Electron safeStorage); core treats it as inert text. */
export interface ProviderRow {
  id: string;
  /** models.dev catalog id (e.g. 'openai', 'groq'); 'openai-compatible' for custom endpoints. */
  type: string;
  /** Execution driver: 'openai' | 'anthropic' | 'google' | 'openai-compatible'. */
  driver: string;
  name: string;
  api_key_enc: string | null;
  base_url: string | null;
  enabled: 0 | 1;
  created_at: string;
}

export interface ProviderModelRow {
  provider_id: string;
  model_id: string;
  display_name: string | null;
  enabled: 0 | 1;
}

export interface SettingRow {
  key: string;
  value: string;
}

/**
 * A prompt snapshot published to a sharing portal. Soft-deleted (deleted_at)
 * when revoked so the UI can still show the share as revoked. delete_token is
 * local-only plaintext — see migrations.ts v5 for why. prompt_id goes null
 * when the prompt is hard-deleted (ON DELETE SET NULL): the record and its
 * revoke token must outlive the prompt.
 */
export interface SharedSnapshotRow {
  snapshot_id: string;
  prompt_id: string | null;
  portal_base_url: string;
  url: string;
  delete_token: string;
  full_history: 0 | 1;
  published_at: string;
  deleted_at: string | null;
}
