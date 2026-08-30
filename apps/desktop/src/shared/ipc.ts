/** Shared IPC contract between main, preload and renderer. */
import { z } from "zod";
import { IPC_CHANNELS } from "./channels.js";
// Type-only on purpose: share's runtime graph reaches node:crypto, which the
// renderer bundle cannot load — runtime schema use stays in the main process.
import type {
  Finding,
  PublishResponse,
  SnapshotPayload,
  SnapshotResponse,
} from "@promptbranch/share";

export { IPC_CHANNELS };

// ---------------------------------------------------------------------------
// Zod schemas for inbound payloads (validated in the main process)
// ---------------------------------------------------------------------------

const id = z.string().trim().min(1).max(200);
const shortText = z.string().trim().min(1).max(500);
const longText = z.string().max(1_000_000);

export const promptListSchema = z.object({
  sort: z.enum(["updated", "created", "title", "rating"]).optional(),
  tagIds: z.array(id).max(100).optional(),
  collectionId: id.optional(),
  starred: z.boolean().optional(),
  deletedOnly: z.boolean().optional(),
  minRating: z.number().min(1).max(5).optional(),
});
export type PromptListQuery = z.infer<typeof promptListSchema>;
export type SortKey = NonNullable<PromptListQuery["sort"]>;

export const promptCreateSchema = z.object({
  title: shortText,
  description: z.string().max(5_000).optional(),
  tagIds: z.array(id).max(100).optional(),
  content: longText,
  changeNote: z.string().max(2_000).optional(),
});
export type PromptCreateInput = z.infer<typeof promptCreateSchema>;

export const promptUpdateSchema = z.object({
  id,
  patch: z.object({
    title: shortText.optional(),
    description: z.string().max(5_000).nullable().optional(),
    icon: z.string().max(100).nullable().optional(),
  }),
});

export const versionCreateSchema = z.object({
  promptId: id,
  branchId: id,
  content: longText,
  changeNote: z.string().max(2_000).optional(),
});
export type VersionCreateInput = z.infer<typeof versionCreateSchema>;

export const versionSetCurrentSchema = z.object({ promptId: id, versionId: id });

export const draftSetSchema = z.object({ promptId: id, content: longText.nullable() });

export const noteAddSchema = z.object({
  promptId: id,
  versionId: id.optional(),
  body: z.string().trim().min(1).max(100_000),
});
export type NoteAddInput = z.infer<typeof noteAddSchema>;

export const tagCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().max(50).optional(),
});
export type TagCreateInput = z.infer<typeof tagCreateSchema>;

export const tagOnPromptSchema = z.object({ promptId: id, tagId: id });

export const collectionCreateSchema = z.object({ name: z.string().trim().min(1).max(200) });

export const collectionPromptSchema = z.object({ collectionId: id, promptId: id });

export const searchSchema = z.object({ query: z.string().max(1_000) });

export const ratingAveragesSchema = z.object({
  targetType: z.enum(["prompt", "version"]),
  targetId: id,
});

const score = z.number().int().min(1).max(5);

export const ratingAddSchema = z.object({
  targetType: z.enum(["prompt", "version"]),
  targetId: id,
  effectiveness: score.optional(),
  clarity: score.optional(),
  completeness: score.optional(),
  actionability: score.optional(),
});
export type RatingAddInput = z.infer<typeof ratingAddSchema>;

export const runAddSchema = z.object({
  promptId: id,
  versionId: id,
  tool: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(100).optional(),
  outcomeRating: score.optional(),
  resultSummary: z.string().max(100_000).optional(),
  startedAt: z.string().max(100).optional(),
});
export type RunAddInput = z.infer<typeof runAddSchema>;

export const runUpdateOutcomeSchema = z.object({
  runId: id,
  /**
   * 1–5, or null to clear. The DB column is REAL (LLM-judge averages land on
   * one decimal); manual star input always sends integers.
   */
  outcomeRating: z.number().min(1).max(5).nullable(),
});
export type RunUpdateOutcomeInput = z.infer<typeof runUpdateOutcomeSchema>;

/** JSON values mergeable into a run's metrics_json blob. */
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(10_000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string().max(100), jsonValueSchema),
  ]),
);

export const runUpdateMetricsSchema = z.object({
  runId: id,
  /** Shallow-merged into metrics_json; existing keys are preserved. */
  patch: z.record(z.string().trim().min(1).max(100), jsonValueSchema),
});
export type RunUpdateMetricsInput = z.infer<typeof runUpdateMetricsSchema>;

export const branchCreateSchema = z.object({
  promptId: id,
  name: z.string().trim().min(1).max(100),
  fromVersionId: id,
  description: z.string().max(2_000).optional(),
});
export type BranchCreateInput = z.infer<typeof branchCreateSchema>;

export const recentActivitySchema = z.object({ limit: z.number().int().min(1).max(500).optional() });

export const suggestionApproveSchema = z.object({
  versionId: id,
  setAsCurrent: z.boolean().optional(),
});

export const suggestionRejectSchema = z.object({ versionId: id });

// ---------------------------------------------------------------------------
// Sharing (portal publish / import)
// ---------------------------------------------------------------------------

export const shareScopeSchema = z.object({
  promptId: id,
  includeHistory: z.boolean(),
  description: z.string().max(2_000).optional(),
});
export type ShareScopeInput = z.infer<typeof shareScopeSchema>;

export const shareDeleteSchema = z.object({ snapshotId: id });

export const sharePortalSetSchema = z.object({
  /** Empty string resets to the official instance. */
  baseUrl: z.string().trim().max(500),
});

export const shareImportPreviewSchema = z.object({ url: z.string().trim().min(1).max(2_000) });
// Import confirm takes the exact previewed SnapshotResponse — validated in the
// main handler with snapshotResponseSchema from @promptbranch/share.

// ---------------------------------------------------------------------------
// Sync

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/, "fingerprint");

export const syncSetEnabledSchema = z.object({ enabled: z.boolean() });

export const syncSetDeviceNameSchema = z.object({ name: z.string().trim().min(1).max(100) });

export const syncPairWithCodeSchema = z.object({
  address: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  code: z.string().trim().min(1).max(20),
});

export const syncRespondPairingSchema = z.object({
  fingerprint: fingerprintSchema,
  accept: z.boolean(),
});

export const syncForgetDeviceSchema = z.object({ fingerprint: fingerprintSchema });

export const syncPairRequestEventSchema = z.object({
  fingerprint: fingerprintSchema,
  fingerprintShort: z.string().min(1),
  name: z.string().min(1).max(100),
});

export const syncPeerDtoSchema = z.object({
  fingerprint: fingerprintSchema,
  name: z.string().min(1).max(100),
  fingerprintShort: z.string().min(1),
  lastSeen: z.string().nullable(),
  /** "offline" = paired but no live connection (retrying in the background). */
  state: z.enum(["connecting", "syncing", "steady", "error", "offline"]),
  unhealthy: z.boolean(),
});

export const syncStatusDtoSchema = z.object({
  enabled: z.boolean(),
  listening: z.boolean(),
  deviceName: z.string().min(1).max(100),
  fingerprintShort: z.string(),
  pairingActive: z.boolean(),
  pairingCode: z.string().nullable(),
  peers: z.array(syncPeerDtoSchema),
  nearby: z.array(
    z.object({
      fingerprint: fingerprintSchema,
      name: z.string(),
      address: z.string(),
      port: z.number().int().min(1).max(65_535),
    }),
  ),
  pendingDirty: z.number().int().min(0),
  lastSyncedAt: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// AI providers, catalog, runs and assist
// ---------------------------------------------------------------------------

/**
 * Execution drivers — how a provider talks to its endpoint. A provider's
 * `type` is its models.dev catalog id (e.g. "groq"); the driver decides the
 * wire protocol. Long-tail catalog providers all use "openai-compatible".
 */
export const aiProviderDriverSchema = z.enum(["openai", "anthropic", "google", "openai-compatible"]);
export type AiProviderDriver = z.infer<typeof aiProviderDriverSchema>;

/** models.dev catalog provider id, or 'openai-compatible' for custom endpoints. */
export const aiCatalogProviderIdSchema = z.string().trim().min(1).max(100);

/**
 * Base URLs must use https — plaintext http would send API keys unencrypted.
 * The only exception is a loopback host (local servers like Ollama/LM Studio).
 */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function isAllowedBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
}

const baseUrlSchema = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine(isAllowedBaseUrl, {
    message: "Base URL must use https:// (http:// is only allowed for localhost)",
  });

export const aiProviderCreateSchema = z.object({
  type: aiCatalogProviderIdSchema,
  name: z.string().trim().min(1).max(100),
  /** Plaintext API key — encrypted in main before storage, never returned. */
  apiKey: z.string().max(500).optional(),
  baseUrl: baseUrlSchema.optional(),
  enabled: z.boolean().optional(),
});
export type AiProviderCreateInput = z.infer<typeof aiProviderCreateSchema>;

export const aiProviderUpdateSchema = z.object({
  id,
  patch: z.object({
    name: z.string().trim().min(1).max(100).optional(),
    /** Plaintext key to (re)store, or null to clear. Omit to keep as-is. */
    apiKey: z.string().max(500).nullable().optional(),
    baseUrl: baseUrlSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  }),
});
export type AiProviderUpdateInput = z.infer<typeof aiProviderUpdateSchema>;

export const aiProviderTestSchema = z.object({ providerId: id, modelId: z.string().trim().min(1).max(200).optional() });

export const aiProviderConnectEnvSchema = z.object({ catalogId: aiCatalogProviderIdSchema });
export type AiProviderConnectEnvInput = z.infer<typeof aiProviderConnectEnvSchema>;

export const aiModelsSetSchema = z.object({
  providerId: id,
  models: z
    .array(
      z.object({
        modelId: z.string().trim().min(1).max(200),
        displayName: z.string().trim().min(1).max(200).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .max(200),
});
export type AiModelsSetInput = z.infer<typeof aiModelsSetSchema>;

/** Hides (or unhides) a single model without touching the rest of the list. */
export const aiModelHideSchema = z.object({
  providerId: id,
  modelId: z.string().trim().min(1).max(200),
  hidden: z.boolean(),
});
export type AiModelHideInput = z.infer<typeof aiModelHideSchema>;

const modelRefSchema = z.object({ providerId: id, modelId: z.string().trim().min(1).max(200) });

export const aiRunSchema = z.object({
  promptId: id,
  /** Defaults to the prompt's current version. */
  versionId: id.optional(),
  /** Raw prompt content; {{variable}} placeholders are substituted. */
  content: z.string().trim().min(1).max(1_000_000),
  variables: z.record(z.string().max(200), z.string().max(100_000)).default({}),
  modelRefs: z
    .array(modelRefSchema)
    .min(1)
    .max(6)
    .refine(
      (refs) => new Set(refs.map((r) => `${r.providerId} ${r.modelId}`)).size === refs.length,
      { message: "modelRefs must not contain duplicate provider/model pairs" },
    ),
});
export type AiRunInput = z.infer<typeof aiRunSchema>;

/** Aborts every in-flight model stream of one run group. */
export const aiRunCancelSchema = z.object({ runGroupId: id });
export type AiRunCancelInput = z.infer<typeof aiRunCancelSchema>;

export const aiRunCancelResultSchema = z.object({ cancelled: z.boolean() });
export type AiRunCancelResult = z.infer<typeof aiRunCancelResultSchema>;

/**
 * Live progress of one model in a run group, emitted by main on the
 * ai:run-progress channel while ai:run executes. `text` is the output
 * accumulated so far (not just the delta) — the renderer can render it
 * directly. Parsed again on the renderer side (defense in depth).
 */
export const aiRunProgressEventSchema = z.object({
  runGroupId: id,
  providerId: id,
  modelId: z.string().trim().min(1).max(200),
  /**
   * `queued` fires per model at request time — it carries the runGroupId
   * immediately, so Cancel works in the window before the first token.
   * `started` keeps its first-token meaning.
   */
  phase: z.enum(["queued", "started", "delta", "completed", "error"]),
  /** Accumulated output so far; set on delta/completed. */
  text: z.string().optional(),
  latencyMs: z.number().optional(),
  usage: z
    .object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable() })
    .optional(),
  costUsd: z.number().nullable().optional(),
  error: z.string().optional(),
});
export type AiRunProgressEvent = z.infer<typeof aiRunProgressEventSchema>;

export const aiAssistSchema = z
  .object({
    mode: z.enum(["generate", "improve"]),
    description: z.string().trim().min(1).max(50_000).optional(),
    content: z.string().max(1_000_000).optional(),
    instruction: z.string().trim().min(1).max(50_000).optional(),
    providerId: id,
    modelId: z.string().trim().min(1).max(200),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "generate" && !value.description) {
      ctx.addIssue({ code: "custom", message: "description is required for mode 'generate'" });
    }
    if (value.mode === "improve") {
      if (!value.content?.trim()) ctx.addIssue({ code: "custom", message: "content is required for mode 'improve'" });
      if (!value.instruction) ctx.addIssue({ code: "custom", message: "instruction is required for mode 'improve'" });
    }
  });
export type AiAssistInput = z.infer<typeof aiAssistSchema>;

/** LLM-as-judge for a run group: one judge model scores every completed run. */
export const aiJudgeSchema = z.object({
  runGroupId: id,
  judge: modelRefSchema,
  /** Optional user criteria ("What makes a good response?"). */
  criteria: z.string().trim().min(1).max(5_000).optional(),
});
export type AiJudgeInput = z.infer<typeof aiJudgeSchema>;

// ---------------------------------------------------------------------------
// DTOs returned to the renderer (camelCase; rows never leak over the bridge)
// ---------------------------------------------------------------------------

export interface TagDto {
  id: string;
  name: string;
  color: string | null;
  usageCount: number;
}

export interface CollectionDto {
  id: string;
  name: string;
  sortOrder: number;
  promptCount: number;
}

export interface PromptSummary {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  isStarred: boolean;
  versionLabel: string | null;
  tags: TagDto[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface PromptDetail extends PromptSummary {
  currentVersionId: string | null;
  draftContent: string | null;
  collectionIds: string[];
}

export interface VersionDto {
  id: string;
  promptId: string;
  branchId: string;
  branchName: string;
  parentVersionId: string | null;
  number: number;
  label: string | null;
  /** Display label, e.g. "v3" or "concise v1". */
  displayLabel: string;
  changeNote: string | null;
  author: string;
  createdAt: string;
  isCurrent: boolean;
}

export interface VersionContentDto extends VersionDto {
  content: string;
  contentFormat: string;
}

export interface BranchDto {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface NoteDto {
  id: string;
  promptId: string;
  versionId: string | null;
  versionLabel: string | null;
  body: string;
  createdAt: string;
}

export interface RatingSummaryDto {
  effectiveness: number | null;
  clarity: number | null;
  completeness: number | null;
  actionability: number | null;
  overall: number | null;
  count: number;
}

export interface RatingDto {
  id: string;
  targetType: "prompt" | "version";
  targetId: string;
  effectiveness: number | null;
  clarity: number | null;
  completeness: number | null;
  actionability: number | null;
  createdAt: string;
}

export interface BranchCreateResult {
  branch: BranchDto;
  version: VersionDto;
}

export interface RunDto {
  id: string;
  promptId: string;
  versionId: string;
  versionLabel: string | null;
  tool: string;
  model: string | null;
  outcomeRating: number | null;
  resultSummary: string | null;
  startedAt: string | null;
  createdAt: string;
}

export interface SearchResultDto {
  promptId: string;
  title: string;
  snippet: string;
}

export interface LibraryStats {
  prompts: number;
  versions: number;
  branches: number;
  tags: number;
  collections: number;
  notes: number;
  runs: number;
}

export interface ActivityItemDto {
  promptId: string;
  promptTitle: string;
  versionId: string;
  displayLabel: string;
  branchName: string;
  changeNote: string | null;
  createdAt: string;
}

/** A pending agent-suggested variation awaiting human review. */
export interface SuggestionDto {
  versionId: string;
  promptId: string;
  promptTitle: string;
  branchName: string;
  displayLabel: string;
  /** The version the suggestion was based on (diff base). */
  baseVersionId: string | null;
  rationale: string | null;
  source: "user" | "agent";
  author: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// AI DTOs
// ---------------------------------------------------------------------------

export interface AiProviderModelDto {
  modelId: string;
  displayName: string | null;
  enabled: boolean;
}

/** A configured AI provider. The API key is never exposed — only whether one is stored. */
export interface AiProviderDto {
  id: string;
  /** models.dev catalog id, or 'openai-compatible' for custom endpoints. */
  type: string;
  /** Execution driver (wire protocol). */
  driver: AiProviderDriver;
  name: string;
  baseUrl: string | null;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: string;
  /** The remembered connection-test model (the user's last explicit pick). */
  testModel?: string | null;
  models: AiProviderModelDto[];
}

/** Static driver metadata from the @promptbranch/ai registry. */
export interface AiProviderTypeInfo {
  id: AiProviderDriver;
  displayName: string;
  envVarHint: string | null;
  requiresBaseUrl: boolean;
  docUrl: string;
  defaultTestModel: string | null;
}

export interface AiProviderTestResult {
  ok: boolean;
  error?: string;
  /**
   * True when the failure looks like a retired/unavailable test model (the
   * key itself authenticated) — the renderer offers a model picker to retry
   * instead of asking the user to "fix" the key.
   */
  modelUnavailable?: boolean;
  /**
   * The replacement model the provider itself named in a retirement notice,
   * when present — offered as a one-click "switch and re-test".
   */
  suggestedModel?: string;
}

/** Result of connecting a provider from an environment variable key. */
export interface AiProviderConnectResult {
  provider: AiProviderDto;
  /** Auto connection test run right after creation. */
  test: AiProviderTestResult;
}

/**
 * Which catalog providers have an API key in the process environment, keyed
 * by models.dev provider id. Booleans only — key material never crosses the
 * bridge.
 */
export type AiEnvDetectResult = Record<string, boolean>;

export interface AiCatalogModelDto {
  id: string;
  name: string;
  contextWindow: number | null;
  outputLimit: number | null;
  inputModalities: string[];
  outputModalities: string[];
  reasoning: boolean;
  toolCall: boolean;
  /** USD per million tokens; null when pricing is unknown. */
  costInput: number | null;
  costOutput: number | null;
}

/** A connectable models.dev catalog provider, for the connect-provider list. */
export interface AiCatalogProviderDto {
  id: string;
  name: string;
  /** Env vars that may hold the API key (for Detected badges). */
  env: string[];
  /** OpenAI-compatible base URL prefilled at connect time; null for native drivers. */
  api: string | null;
  npm: string | null;
  doc: string | null;
  modelCount: number;
  /** Pinned in the "Popular" group. */
  popular: boolean;
  driver: AiProviderDriver;
}

/** Cached models.dev catalog: connectable providers + models per provider id. */
export interface AiCatalogDto {
  fetchedAt: string;
  providers: AiCatalogProviderDto[];
  /** Keyed by models.dev provider id; custom providers have no entry. */
  models: Record<string, AiCatalogModelDto[]>;
}

export interface AiCatalogRefreshResult {
  ok: boolean;
  /** Human-readable failure reason when ok=false (stale cache still served). */
  error?: string;
  catalog: AiCatalogDto | null;
}

export interface AiRunResultDto {
  runId: string;
  providerId: string;
  providerName: string;
  modelId: string;
  status: "completed" | "error";
  output: string | null;
  error: string | null;
  latencyMs: number | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  /** Estimated USD cost from the cached catalog; null when unknown. */
  costUsd: number | null;
}

export interface AiRunGroupDto {
  runGroupId: string;
  promptId: string;
  versionId: string;
  createdAt: string;
  runs: AiRunResultDto[];
}

/** A stored run group (compare view history), from core's listRunGroups. */
export interface RunGroupDto {
  runGroupId: string;
  createdAt: string;
  runs: Array<{
    id: string;
    versionId: string;
    provider: string | null;
    providerName: string | null;
    model: string | null;
    status: "completed" | "error";
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
    judgeScores: {
      effectiveness: number;
      clarity: number;
      completeness: number;
      actionability: number;
    } | null;
    createdAt: string;
  }>;
}

export interface AiAssistResult {
  text: string;
}

/** One scored run from ai:judge (completed runs only). */
export interface AiJudgeRunResult {
  runId: string;
  modelId: string;
  scores: {
    effectiveness: number;
    clarity: number;
    completeness: number;
    actionability: number;
  };
  rationale: string;
}

/**
 * ai:judge response. Judging never writes to the DB — the renderer decides
 * what to persist. Error runs of the group are skipped (noted in `skipped`);
 * judge-call failures land in `failures` so other runs still apply.
 */
export interface AiJudgeResult {
  results: AiJudgeRunResult[];
  /** Error runs of the group — not judged. */
  skipped: Array<{ runId: string; modelId: string | null; reason: string }>;
  /** Completed runs whose judge call failed. */
  failures: Array<{ runId: string; modelId: string; error: string }>;
}

export interface AppInfo {
  version: string;
  dbPath: string;
  /** Absolute path to the built MCP server entry, or null in packaged apps. */
  mcpServerPath: string | null;
  /** Runtime versions shown in the About dialog. */
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
}

export interface FileOpResult {
  canceled: boolean;
  path?: string;
}

export interface ImportResult {
  canceled: boolean;
  summary?: Record<string, { inserted: number; merged: number; remapped: number; skipped: number }>;
}

export interface SharePreviewResult {
  payload: SnapshotPayload;
  findings: Finding[];
}

/**
 * PublishResponse minus the delete token — the token is recorded in
 * shared_snapshots by the main process and never crosses IPC.
 */
export type SharePublishResult = Omit<PublishResponse, "deleteToken">;

/** A published snapshot as the renderer sees it — the delete token stays in main. */
export interface SharedSnapshotDto {
  snapshotId: string;
  /** Null when the prompt was hard-deleted after publishing (migration v5 SET NULL). */
  promptId: string | null;
  promptTitle: string;
  portalBaseUrl: string;
  url: string;
  fullHistory: boolean;
  publishedAt: string;
  deletedAt: string | null;
}

export type ShareImportPreview = SnapshotResponse;

export interface ShareImportResult {
  promptId: string;
  title: string;
}

// ------------------------------------------------------------------- sync

export interface SyncPeerDto {
  fingerprint: string;
  name: string;
  fingerprintShort: string;
  lastSeen: string | null;
  state: "connecting" | "syncing" | "steady" | "error" | "offline";
  /** Consecutive failed sessions crossed the threshold — worth surfacing. */
  unhealthy: boolean;
}

export interface SyncNearbyDto {
  fingerprint: string;
  name: string;
  address: string;
  port: number;
}

export interface SyncStatusDto {
  enabled: boolean;
  listening: boolean;
  deviceName: string;
  fingerprintShort: string;
  pairingActive: boolean;
  pairingCode: string | null;
  peers: SyncPeerDto[];
  nearby: SyncNearbyDto[];
  pendingDirty: number;
  lastSyncedAt: string | null;
}

/** Main → renderer: another device wants to pair with this library. */
export interface SyncPairRequestEvent {
  fingerprint: string;
  fingerprintShort: string;
  name: string;
}

export interface SyncPairResult {
  ok: boolean;
  error?: string;
}

/** Narrow API surface exposed on `window.promptBuilder` by the preload. */
export interface PromptBuilderApi {
  prompts: {
    list(query?: PromptListQuery): Promise<PromptSummary[]>;
    get(id: string): Promise<PromptDetail | null>;
    create(input: PromptCreateInput): Promise<PromptDetail>;
    update(id: string, patch: { title?: string; description?: string | null; icon?: string | null }): Promise<PromptDetail>;
    setStarred(id: string, starred: boolean): Promise<void>;
    softDelete(id: string): Promise<void>;
    restore(id: string): Promise<void>;
    hardDelete(id: string): Promise<void>;
    exportJson(id: string): Promise<FileOpResult>;
  };
  versions: {
    create(input: VersionCreateInput): Promise<VersionDto>;
    list(promptId: string): Promise<VersionDto[]>;
    get(versionId: string): Promise<VersionContentDto | null>;
    setCurrent(promptId: string, versionId: string): Promise<void>;
  };
  drafts: {
    get(promptId: string): Promise<string | null>;
    set(promptId: string, content: string | null): Promise<void>;
  };
  branches: {
    list(promptId: string): Promise<BranchDto[]>;
    create(input: BranchCreateInput): Promise<BranchCreateResult>;
  };
  notes: {
    add(input: NoteAddInput): Promise<NoteDto>;
    list(promptId: string): Promise<NoteDto[]>;
    delete(noteId: string): Promise<void>;
  };
  tags: {
    create(input: TagCreateInput): Promise<TagDto>;
    list(): Promise<TagDto[]>;
    addToPrompt(promptId: string, tagId: string): Promise<void>;
    removeFromPrompt(promptId: string, tagId: string): Promise<void>;
  };
  collections: {
    create(name: string): Promise<CollectionDto>;
    list(): Promise<CollectionDto[]>;
    addPrompt(collectionId: string, promptId: string): Promise<void>;
    removePrompt(collectionId: string, promptId: string): Promise<void>;
    forPrompt(promptId: string): Promise<string[]>;
  };
  search(query: string): Promise<SearchResultDto[]>;
  ratings: {
    add(input: RatingAddInput): Promise<RatingDto>;
    latest(targetType: "prompt" | "version", targetId: string): Promise<RatingDto | null>;
    averages(targetType: "prompt" | "version", targetId: string): Promise<RatingSummaryDto>;
    /** Average ratings per version of a prompt, keyed by version id. */
    forPromptVersions(promptId: string): Promise<Record<string, RatingSummaryDto>>;
  };
  runs: {
    add(input: RunAddInput): Promise<RunDto>;
    list(promptId: string): Promise<RunDto[]>;
    delete(runId: string): Promise<void>;
    /** Sets (or clears) a run's outcome rating — used by the compare view. */
    updateOutcome(input: RunUpdateOutcomeInput): Promise<RunDto>;
    /** Shallow-merges a patch into the run's metrics_json blob. */
    updateMetrics(input: RunUpdateMetricsInput): Promise<RunDto>;
  };
  library: {
    stats(): Promise<LibraryStats>;
    exportJson(): Promise<FileOpResult>;
    importJson(): Promise<ImportResult>;
    backupNow(): Promise<string>;
    /** Hard-delete every trashed prompt; returns the number deleted. */
    emptyTrash(): Promise<number>;
    recentActivity(limit?: number): Promise<ActivityItemDto[]>;
  };
  suggestions: {
    list(): Promise<SuggestionDto[]>;
    approve(versionId: string, setAsCurrent?: boolean): Promise<void>;
    reject(versionId: string): Promise<void>;
  };
  share: {
    preview(input: ShareScopeInput): Promise<SharePreviewResult>;
    publish(input: ShareScopeInput): Promise<SharePublishResult>;
    list(): Promise<SharedSnapshotDto[]>;
    delete(snapshotId: string): Promise<void>;
    getPortalBaseUrl(): Promise<string>;
    /** Pass "" to reset to the official instance; resolves to the effective URL. */
    setPortalBaseUrl(baseUrl: string): Promise<string>;
    importPreview(url: string): Promise<ShareImportPreview>;
    import(preview: ShareImportPreview): Promise<ShareImportResult>;
    /** Main → renderer event for promptbranch://import deep links. */
    onOpenImport(callback: (url: string) => void): () => void;
  };
  sync: {
    /** Full sync status snapshot; enabled=false when the feature is off. */
    getStatus(): Promise<SyncStatusDto>;
    /** Enables or disables sync (persists; enabling bootstraps the op log). */
    setEnabled(enabled: boolean): Promise<SyncStatusDto>;
    setDeviceName(name: string): Promise<SyncStatusDto>;
    /** Opens the 10-minute pairing window; resolves to the code to show. */
    beginPairing(): Promise<SyncStatusDto>;
    cancelPairing(): Promise<SyncStatusDto>;
    /** Connects to a nearby/manual device using the code shown there. */
    pairWithCode(input: { address: string; port: number; code: string }): Promise<SyncPairResult>;
    /** Renderer's answer to an onPairRequest event. */
    respondPairing(input: { fingerprint: string; accept: boolean }): Promise<void>;
    /** Unpins a device permanently. */
    forgetDevice(fingerprint: string): Promise<SyncStatusDto>;
    /** Refines local changes and nudges connected peers now. */
    now(): Promise<SyncStatusDto>;
    /** Main → renderer status events; parse with syncStatusDtoSchemaHelper or trust main. */
    onStateChanged(callback: (status: SyncStatusDto) => void): () => void;
    /** Main → renderer: a device is asking to pair; answer via respondPairing. */
    onPairRequest(callback: (event: SyncPairRequestEvent) => void): () => void;
  };
  ai: {
    providers: {
      create(input: AiProviderCreateInput): Promise<AiProviderDto>;
      update(input: AiProviderUpdateInput): Promise<AiProviderDto>;
      delete(providerId: string): Promise<void>;
      list(): Promise<AiProviderDto[]>;
      /** Runs a tiny generation against the provider; ok=false carries a normalized error. */
      test(providerId: string, modelId?: string): Promise<AiProviderTestResult>;
      /** Creates a provider from its env-var key (read in main), then auto-tests it. */
      connectEnv(input: AiProviderConnectEnvInput): Promise<AiProviderConnectResult>;
      /** Replaces the provider's configured model list. */
      setModels(input: AiModelsSetInput): Promise<AiProviderDto>;
      /** Hides/unhides one model; hidden catalog models stay usable nowhere. */
      setModelHidden(input: AiModelHideInput): Promise<AiProviderDto>;
    };
    /** Which provider types have an API key in the environment (booleans only). */
    envDetect(): Promise<AiEnvDetectResult>;
    /** Static registry metadata (display names, doc URLs, default test models). */
    providerTypes(): Promise<AiProviderTypeInfo[]>;
    catalog: {
      /** Cached catalog, or null when never refreshed (offline-safe). */
      get(): Promise<AiCatalogDto | null>;
      /** Fetches models.dev and updates the cache; ok=false keeps stale cache. */
      refresh(): Promise<AiCatalogRefreshResult>;
    };
    /** Executes one prompt against up to 6 models concurrently; writes a run group. */
    run(input: AiRunInput): Promise<AiRunGroupDto>;
    /**
     * Subscribe to live ai:run progress events (all run groups); returns an
     * unsubscribe fn. Payloads are raw — parse with aiRunProgressEventSchema.
     */
    onRunProgress(callback: (event: AiRunProgressEvent) => void): () => void;
    /** Aborts all in-flight model streams of a run group. */
    runCancel(input: AiRunCancelInput): Promise<AiRunCancelResult>;
    /** AI-assisted authoring; no DB writes. */
    assist(input: AiAssistInput): Promise<AiAssistResult>;
    /** LLM-as-judge over a run group's completed runs; read-only, no DB writes. */
    judge(input: AiJudgeInput): Promise<AiJudgeResult>;
    /** Stored run groups of a prompt, newest first (compare view). */
    runGroups(promptId: string): Promise<RunGroupDto[]>;
  };
  app: {
    info(): Promise<AppInfo>;
    /** Subscribe to the menu's "About PromptBranch" action; returns an unsubscribe fn. */
    onOpenAbout(callback: () => void): () => void;
    /** Subscribe to the menu's "Settings…" action; returns an unsubscribe fn. */
    onOpenSettings(callback: () => void): () => void;
    /** Open an http(s) URL in the system browser. */
    openExternal(url: string): Promise<void>;
    /** The bundled THIRD_PARTY_NOTICES.md content, for the in-app licenses dialog. */
    licensesText(): Promise<string>;
  };
}
