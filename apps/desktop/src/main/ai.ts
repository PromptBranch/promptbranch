/**
 * Main-process AI services on top of @promptbranch/ai + @promptbranch/core.
 *
 * Key handling: renderer sends plaintext keys over IPC; they are encrypted
 * here (Electron safeStorage, injected as KeyCipher for testability) before
 * touching the database, and decrypted only in this process at execution
 * time. The blob never leaves main.
 */
import { randomUUID } from "node:crypto";
import {
  PROVIDERS,
  buildGeneratePrompt,
  buildImprovePrompt,
  catalogBaseUrl,
  createProviderModel,
  detectCatalogEnvKeys,
  driverForCatalogId,
  estimateCost,
  fetchCatalog,
  findCatalogModel,
  findCatalogProvider,
  getProviderDescriptor,
  isProviderDriver,
  listCatalogProviders,
  runPrompt,
  streamPrompt,
  stripWrappingFences,
  runJudge,
  type ModelCatalog,
  type ProviderConfig,
  type TokenUsage,
} from "@promptbranch/ai";
import type { PromptLibrary, ProviderRow, RunRow } from "@promptbranch/core";
import type {
  AiAssistInput,
  AiAssistResult,
  AiCatalogDto,
  AiCatalogRefreshResult,
  AiEnvDetectResult,
  AiJudgeInput,
  AiJudgeResult,
  AiModelHideInput,
  AiProviderConnectEnvInput,
  AiProviderConnectResult,
  AiProviderCreateInput,
  AiProviderDto,
  AiProviderTestResult,
  AiProviderTypeInfo,
  AiProviderUpdateInput,
  AiRunGroupDto,
  AiRunInput,
  AiRunProgressEvent,
  AiRunResultDto,
} from "../shared/ipc.js";
import { isAllowedBaseUrl } from "../shared/ipc.js";

/** Encryption boundary, implemented with safeStorage in main/index.ts. */
export interface KeyCipher {
  encrypt(plaintext: string): string;
  decrypt(blob: string): string;
}

export interface AiServiceDeps {
  lib: PromptLibrary;
  cipher: KeyCipher;
  /** Overridable in tests; defaults to models.dev via packages/ai. */
  fetchCatalogImpl?: () => Promise<ModelCatalog>;
  /** Environment read for env-key detection; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Overridable in tests; defaults to the real connection test below. */
  testImpl?: (providerId: string, modelId?: string) => Promise<AiProviderTestResult>;
}

const RUN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;
const JUDGE_TIMEOUT_MS = 60_000;
/** Max concurrent judge calls — sequential judging of a 6-run group would take ~6× the per-call timeout. */
const JUDGE_CONCURRENCY = 3;

/**
 * Base URLs must be https (plaintext http would ship API keys unencrypted),
 * except on loopback hosts for local servers. Enforced here in addition to
 * the IPC zod schemas so direct callers get the same guarantee.
 */
function assertAllowedBaseUrl(baseUrl: string): void {
  if (!isAllowedBaseUrl(baseUrl)) {
    throw new Error("Base URL must use https:// (http:// is only allowed for localhost)");
  }
}

// ------------------------------------------------------------- key handling

function encryptKey(cipher: KeyCipher, plaintext: string): string {
  try {
    return cipher.encrypt(plaintext);
  } catch (error) {
    throw new Error(
      `Could not encrypt the API key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Resolves a provider row into an execution config (decrypts the key). */
function configForProvider(cipher: KeyCipher, provider: ProviderRow): ProviderConfig {
  let apiKey: string | undefined;
  if (provider.api_key_enc) {
    try {
      apiKey = cipher.decrypt(provider.api_key_enc);
    } catch {
      throw new Error(
        `Could not decrypt the stored API key for "${provider.name}" — re-enter it in Settings`,
      );
    }
  }
  return {
    driver: providerDriver(provider),
    name: provider.name,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(provider.base_url !== null ? { baseUrl: provider.base_url } : {}),
  };
}

/** The row's execution driver; pre-migration rows are backfilled from type. */
function providerDriver(provider: ProviderRow): ProviderConfig["driver"] {
  const driver = provider.driver || provider.type;
  if (!isProviderDriver(driver)) {
    throw new Error(`Provider "${provider.name}" has unsupported driver: ${driver}`);
  }
  return driver;
}

function mustGetProvider(lib: PromptLibrary, providerId: string): ProviderRow {
  const provider = lib.getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  providerDriver(provider);
  return provider;
}

// ------------------------------------------------------------------ DTO map

export function toAiProviderDto(lib: PromptLibrary, row: ProviderRow): AiProviderDto {
  return {
    id: row.id,
    type: row.type,
    driver: (row.driver || row.type) as AiProviderDto["driver"],
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    hasApiKey: row.api_key_enc !== null,
    createdAt: row.created_at,
    // The remembered connection-test model, if the user ever picked one.
    testModel: lib.getSetting(testModelKey(row.type)),
    models: lib.listProviderModels(row.id).map((m) => ({
      modelId: m.model_id,
      displayName: m.display_name,
      enabled: m.enabled === 1,
    })),
  };
}

export function providerTypesInfo(): AiProviderTypeInfo[] {
  return PROVIDERS.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    envVarHint: p.envVarHint,
    requiresBaseUrl: p.requiresBaseUrl,
    docUrl: p.docUrl,
    defaultTestModel: p.defaultTestModel,
  }));
}

// ------------------------------------------------------------------ providers

export function createProvider(deps: AiServiceDeps, input: AiProviderCreateInput): AiProviderDto {
  const driver = driverForCatalogId(input.type);
  if (driver === "openai-compatible" && !input.baseUrl) {
    // Custom endpoints and long-tail catalog providers both need a base URL
    // (the renderer pre-fills the catalog's `api` URL for the latter).
    throw new Error(
      input.type === "openai-compatible"
        ? "OpenAI-compatible providers require a base URL"
        : `Provider "${input.type}" requires a base URL — its catalog entry has none`,
    );
  }
  if (input.baseUrl !== undefined) assertAllowedBaseUrl(input.baseUrl);
  if (driver === "openai-compatible" && input.type !== "openai-compatible") {
    // Typo guard: unknown catalog ids are rejected once a catalog is cached.
    const catalog = cachedCatalog(deps.lib);
    if (catalog && !findCatalogProvider(catalog, input.type)) {
      throw new Error(`Unknown catalog provider: "${input.type}" is not in the model catalog`);
    }
  }
  const row = deps.lib.createProvider({
    type: input.type,
    driver,
    name: input.name,
    ...(input.apiKey ? { apiKeyEnc: encryptKey(deps.cipher, input.apiKey) } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  });
  return toAiProviderDto(deps.lib, row);
}

export function updateProvider(deps: AiServiceDeps, input: AiProviderUpdateInput): AiProviderDto {
  const provider = mustGetProvider(deps.lib, input.id);
  const patch: Parameters<PromptLibrary["updateProvider"]>[1] = {};
  if (input.patch.name !== undefined) patch.name = input.patch.name;
  if (input.patch.apiKey !== undefined) {
    patch.apiKeyEnc = input.patch.apiKey === null ? null : encryptKey(deps.cipher, input.patch.apiKey);
  }
  if (input.patch.baseUrl !== undefined) {
    // The openai-compatible driver cannot run without a base URL.
    if (input.patch.baseUrl === null && providerDriver(provider) === "openai-compatible") {
      throw new Error(`Provider "${provider.name}" requires a base URL — it cannot be removed`);
    }
    if (input.patch.baseUrl !== null) assertAllowedBaseUrl(input.patch.baseUrl);
    // Changing the endpoint must never silently re-point the old key at a
    // different server: clear it (hasApiKey flips to false) unless the same
    // patch supplies a replacement key.
    if (input.patch.baseUrl !== provider.base_url && input.patch.apiKey === undefined) {
      patch.apiKeyEnc = null;
    }
    patch.baseUrl = input.patch.baseUrl;
  }
  if (input.patch.enabled !== undefined) patch.enabled = input.patch.enabled;
  return toAiProviderDto(deps.lib, deps.lib.updateProvider(input.id, patch));
}

export function listProviders(deps: AiServiceDeps): AiProviderDto[] {
  return deps.lib.listProviders().map((row) => toAiProviderDto(deps.lib, row));
}

/** Tiny generation ("Reply with: ok") to verify credentials/connectivity. */
/** Settings key for a provider type's remembered connection-test model.
 * Keyed by type (unique per library), not provider id: deleting and
 * re-connecting a provider must not lose the user's choice. */
function testModelKey(providerType: string): string {
  return `ai-test-model:${providerType}`;
}

export async function testProvider(
  deps: AiServiceDeps,
  providerId: string,
  modelId?: string,
): Promise<AiProviderTestResult> {
  let testedModel: string | undefined;
  try {
    const provider = mustGetProvider(deps.lib, providerId);
    // The test model is always a user choice, remembered across calls:
    // the explicit id (connect dialog / re-test picker) is persisted, and
    // later tests fall back to it, then to models declared via Manage
    // models. No catalog heuristics — models.dev data lists e.g. Google's
    // Lyria music model with "text" output at $0, which beat every
    // price/modality pick.
    if (modelId) deps.lib.setSetting(testModelKey(provider.type), modelId);
    const remembered = deps.lib.getSetting(testModelKey(provider.type));
    const declared = deps.lib.listProviderModels(providerId, { enabledOnly: true })[0]?.model_id;
    const model = modelId ?? remembered ?? declared;
    if (!model) {
      throw new Error(
        `No test model chosen for "${provider.name}" — pick one in the connect dialog or via Re-test connection, then re-test`,
      );
    }
    testedModel = model;
    await runPrompt({
      model: createProviderModel(configForProvider(deps.cipher, provider), model),
      prompt: "Reply with: ok",
      // OpenAI's Responses API rejects max_output_tokens below 16.
      maxOutputTokens: 16,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isModelUnavailableError(message)) return { ok: false, error: message };
    return {
      ok: false,
      error: message,
      modelUnavailable: true,
      // Providers name their replacement in retirement notices ("use
      // models/gemini-3.5-flash-lite") — surface it for one-click retry.
      suggestedModel: suggestedModelFrom(message, testedModel),
    };
  }
}

/** Extracts a models/<id> mention that differs from the failed model. */
function suggestedModelFrom(message: string, failed: string | undefined): string | undefined {
  const ids = [...message.matchAll(/models\/([a-z0-9][a-z0-9._-]*)/gi)].map((match) => match[1] ?? "");
  return ids.find((id) => id !== "" && id !== failed);
}

/**
 * Distinguishes "the test model is unusable" (retired, or quota-limited to
 * zero — either way the key itself authenticated) from a bad key or
 * endpoint. Conservative on purpose: plain endpoint 404s ("Not Found", no
 * model wording) are not flagged, so the recovery picker only appears for
 * model-level failures.
 */
function isModelUnavailableError(message: string): boolean {
  return (
    (/HTTP 404/i.test(message) && /model/i.test(message)) ||
    /no longer available|has been (retired|decommissioned|deleted)|does not exist/i.test(message) ||
    /quota|rate.?limit/i.test(message)
  );
}

// -------------------------------------------------------------- env detection

/**
 * Reports which catalog providers have one of their documented env vars set,
 * keyed by models.dev provider id. Returns booleans only — the key material
 * never leaves this process. Without a cached catalog, falls back to the
 * native registry hints.
 */
export function detectEnvKeys(
  lib: PromptLibrary,
  env: Record<string, string | undefined> = process.env,
): AiEnvDetectResult {
  const catalog = cachedCatalog(lib);
  if (catalog) return detectCatalogEnvKeys(catalog, env);
  const result: AiEnvDetectResult = {};
  for (const descriptor of PROVIDERS) {
    result[descriptor.id] = descriptor.envVarHint !== null && Boolean(env[descriptor.envVarHint]?.trim());
  }
  return result;
}

/**
 * One-step "use environment key" connect: reads the key from the env in main,
 * encrypts it, creates the provider and auto-tests the connection. The
 * provider stays saved even when the test fails (the user can fix it later).
 * `catalogId` is the models.dev provider id (e.g. "groq").
 */
export async function connectEnvProvider(
  deps: AiServiceDeps,
  input: AiProviderConnectEnvInput,
): Promise<AiProviderConnectResult> {
  // Single-flight: two near-simultaneous calls would both pass the duplicate
  // check below, so a second call for the same catalog id joins the first.
  const inFlight = connectEnvInFlight.get(input.catalogId);
  if (inFlight) return inFlight;
  const promise = connectEnvProviderInner(deps, input).finally(() => {
    connectEnvInFlight.delete(input.catalogId);
  });
  connectEnvInFlight.set(input.catalogId, promise);
  return promise;
}

const connectEnvInFlight = new Map<string, Promise<AiProviderConnectResult>>();

async function connectEnvProviderInner(
  deps: AiServiceDeps,
  input: AiProviderConnectEnvInput,
): Promise<AiProviderConnectResult> {
  const catalog = cachedCatalog(deps.lib);
  const entry = catalog ? findCatalogProvider(catalog, input.catalogId) : null;
  const driver = driverForCatalogId(input.catalogId);
  // Env var conventions come from the catalog; native providers fall back to
  // the registry hint when no catalog is cached yet.
  const envNames =
    entry && entry.env.length > 0
      ? entry.env
      : (() => {
          const hint = isProviderDriver(input.catalogId)
            ? getProviderDescriptor(driver).envVarHint
            : null;
          return hint ? [hint] : [];
        })();
  const displayName = entry?.name ?? (isProviderDriver(input.catalogId) ? getProviderDescriptor(driver).displayName : input.catalogId);
  if (envNames.length === 0) {
    throw new Error(`${displayName} has no environment variable convention — connect with an API key instead`);
  }
  const env = deps.env ?? process.env;
  const key = envNames.map((name) => env[name]?.trim()).find((value) => value);
  if (!key) throw new Error(`${envNames.join(" or ")} is not set in the environment`);
  if (deps.lib.listProviders().some((p) => p.type === input.catalogId)) {
    throw new Error(`A ${displayName} provider is already connected`);
  }
  // Long-tail drivers need a base URL: the catalog's `api`, or the curated
  // fallback for known providers whose entry publishes none.
  const baseUrl = driver === "openai-compatible" && entry ? catalogBaseUrl(entry) : null;
  const provider = createProvider(deps, {
    type: input.catalogId,
    name: displayName,
    apiKey: key,
    ...(baseUrl !== null ? { baseUrl } : {}),
  });
  const test = await (deps.testImpl ?? ((id, modelId) => testProvider(deps, id, modelId)))(provider.id);
  return { provider, test };
}

// ---------------------------------------------------------------- model hiding

/**
 * Hides or unhides a single model. Hiding writes a provider_models row with
 * enabled=0, which makes an otherwise catalog-available model unusable;
 * unhiding flips it back. openai-compatible declarations are untouched in
 * structure — only the flag moves.
 */
export function setModelHidden(deps: AiServiceDeps, input: AiModelHideInput): AiProviderDto {
  const provider = mustGetProvider(deps.lib, input.providerId);
  const rows = deps.lib.listProviderModels(provider.id);
  const next = rows.map((m) => ({
    modelId: m.model_id,
    ...(m.display_name !== null ? { displayName: m.display_name } : {}),
    enabled: m.enabled === 1,
  }));
  const existing = next.find((m) => m.modelId === input.modelId);
  if (existing) {
    existing.enabled = !input.hidden;
  } else {
    next.push({ modelId: input.modelId, enabled: !input.hidden });
  }
  deps.lib.setProviderModels(provider.id, next);
  return toAiProviderDto(deps.lib, deps.lib.getProvider(provider.id)!);
}

// ------------------------------------------------------------------ catalog

function toCatalogDto(fetchedAt: string, catalog: ModelCatalog): AiCatalogDto {
  return {
    fetchedAt,
    // Providers without an api URL and no native driver are not connectable —
    // they never reach the renderer's connect list.
    providers: listCatalogProviders(catalog)
      .filter((p) => p.connectable)
      .map(({ connectable: _connectable, ...p }) => p),
    models: catalog.models,
  };
}

/**
 * The settings cache stores the *parsed* catalog (provider metadata + model
 * entries), stringified — smaller than raw models.dev and already validated.
 * This light structural check guards against corrupted (or pre-reshape)
 * cache rows.
 */
function isParsedCatalog(value: unknown): value is ModelCatalog {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record["providers"]) &&
    typeof record["models"] === "object" &&
    record["models"] !== null &&
    Object.values(record["models"]).every((models) => Array.isArray(models))
  );
}

/** Reads the cached parsed catalog, or null when absent/corrupt. */
function cachedCatalog(lib: PromptLibrary): ModelCatalog | null {
  const cache = lib.getCatalogCache();
  if (!cache) return null;
  try {
    const parsed: unknown = JSON.parse(cache.json);
    return isParsedCatalog(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Cached catalog only; null when never refreshed. Never throws. */
export function getCatalog(lib: PromptLibrary): AiCatalogDto | null {
  const cache = lib.getCatalogCache();
  const catalog = cachedCatalog(lib);
  if (!cache || !catalog) return null;
  return toCatalogDto(cache.fetchedAt, catalog);
}

/**
 * Fetches models.dev and updates the cache. Failures never throw and never
 * clobber a good cache — the stale catalog keeps being served offline.
 */
export async function refreshCatalog(deps: AiServiceDeps): Promise<AiCatalogRefreshResult> {
  try {
    const catalog = await (deps.fetchCatalogImpl ?? fetchCatalog)();
    deps.lib.setCatalogCache(JSON.stringify(catalog));
    const cache = deps.lib.getCatalogCache()!;
    return { ok: true, catalog: toCatalogDto(cache.fetchedAt, catalog) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      catalog: getCatalog(deps.lib),
    };
  }
}

// --------------------------------------------------------------------- runs

/**
 * Normalized message for a failed run; never empty — recordModelRun rejects
 * blank errors, which would abort the whole group write.
 */
export function runFailureMessage(reason: { message: string }): string {
  return reason.message.trim() || "Unknown provider error";
}

/** Substitutes {{variable}} placeholders; unknown variables are left as-is. */
export function substituteVariables(content: string, variables: Record<string, string>): string {
  return content.replace(/\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}/gu, (raw, name: string) =>
    Object.hasOwn(variables, name) ? variables[name]! : raw,
  );
}

/**
 * Validates provider + model availability for execution. Returns the row.
 *
 * Availability rules: a model is runnable when it is explicitly declared and
 * enabled in provider_models (the custom openai-compatible path), or — for
 * catalog-backed providers (any models.dev id, native or long-tail) — when it
 * exists in the cached models.dev catalog and no provider_models row hides it
 * (enabled=0). Unknown catalog models are still rejected, so typos fail fast
 * instead of at the API.
 */
function requireRunnableProvider(deps: AiServiceDeps, providerId: string, modelId: string): ProviderRow {
  const { lib } = deps;
  const provider = mustGetProvider(lib, providerId);
  if (provider.enabled !== 1) throw new Error(`Provider "${provider.name}" is disabled`);
  const models = lib.listProviderModels(providerId);
  const configured = models.find((m) => m.model_id === modelId);
  if (configured) {
    if (configured.enabled !== 1) {
      throw new Error(`Model "${modelId}" is hidden on provider "${provider.name}"`);
    }
    return provider;
  }
  const catalog = cachedCatalog(lib);
  const catalogBacked = provider.type !== "openai-compatible";
  if (catalogBacked) {
    if (catalog) {
      if (findCatalogModel(catalog, provider.type, modelId)) return provider;
      throw new Error(`Unknown ${provider.name} model: "${modelId}" is not in the model catalog`);
    }
    throw new Error(
      `Model "${modelId}" is not declared on provider "${provider.name}" and no model catalog is cached yet — refresh the catalog in Settings`,
    );
  }
  // Custom openai-compatible endpoints have no catalog — models must be declared.
  throw new Error(
    models.length === 0
      ? `Provider "${provider.name}" has no models yet — add a model id in Settings`
      : `Model "${modelId}" is not declared on provider "${provider.name}"`,
  );
}

/**
 * In-flight run groups, keyed by runGroupId — ai:run-cancel aborts the
 * controller to stop every model stream of the group.
 */
const inFlightRunGroups = new Map<string, AbortController>();

/**
 * Aborts all in-flight model streams of a run group. Aborted models settle
 * as error rows ("Cancelled by user") inside runModelGroup. Returns false
 * when the group is unknown or already finished.
 */
export function cancelRunGroup(runGroupId: string): boolean {
  const controller = inFlightRunGroups.get(runGroupId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Error message recorded for models aborted via ai:run-cancel. */
export const RUN_CANCELLED_MESSAGE = "Cancelled by user";

/** Live progress callback; receives one event per model phase change. */
export type RunProgressEmit = (event: AiRunProgressEvent) => void;

/**
 * Coalesces token-delta events: at most one send per ~50ms, or whenever
 * 500+ new chars accumulated — IPC flooding guard for fast providers.
 * Terminal events always carry the full text, so no flush is needed.
 */
function createDeltaThrottle(send: (text: string) => void): (text: string) => void {
  let lastSentAt = 0;
  let lastSentLength = 0;
  return (text) => {
    const now = Date.now();
    if (now - lastSentAt >= 50 || text.length - lastSentLength >= 500) {
      lastSentAt = now;
      lastSentLength = text.length;
      send(text);
    }
  };
}

/**
 * Executes one prompt against 1–6 models concurrently and writes one runs row
 * per model (status/output/error/latency/metrics) under a shared run group.
 *
 * Models stream token-by-token: `emit` receives queued → started → delta* →
 * completed/error per model, and each model's row is written as it settles
 * (not all at the end), so a crash mid-group keeps the finished results.
 * The returned promise resolves with the final group once every model
 * settled. Cancellation: cancelRunGroup(runGroupId) aborts all streams;
 * aborted models are recorded as error rows with RUN_CANCELLED_MESSAGE.
 */
export async function runModelGroup(
  deps: AiServiceDeps,
  input: AiRunInput,
  emit: RunProgressEmit = () => {},
): Promise<AiRunGroupDto> {
  const { lib } = deps;
  const prompt = lib.getPrompt(input.promptId);
  if (!prompt) throw new Error(`Prompt not found: ${input.promptId}`);
  const versionId = input.versionId ?? prompt.current_version_id;
  if (!versionId) throw new Error(`Prompt "${prompt.title}" has no version to run`);
  const version = lib.getVersion(versionId);
  if (!version || version.prompt_id !== prompt.id) {
    throw new Error(`Version ${versionId} not found on prompt ${input.promptId}`);
  }

  const content = substituteVariables(input.content, input.variables);
  if (!content.trim()) throw new Error("Prompt content is empty after variable substitution");

  // Cost estimates use the cached parsed catalog when available.
  const catalog = cachedCatalog(lib);

  interface Prepared {
    provider: ProviderRow;
    modelId: string;
    config: ProviderConfig;
  }
  const prepared: Prepared[] = input.modelRefs.map((ref) => {
    const provider = requireRunnableProvider(deps, ref.providerId, ref.modelId);
    return { provider, modelId: ref.modelId, config: configForProvider(deps.cipher, provider) };
  });

  const runGroupId = randomUUID();
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  inFlightRunGroups.set(runGroupId, controller);

  // "queued" fires per model at request time: the renderer learns the
  // runGroupId immediately, so Cancel works in the window before the first
  // token ("started" keeps its first-token meaning).
  for (const p of prepared) {
    emit({ runGroupId, providerId: p.provider.id, modelId: p.modelId, phase: "queued" });
  }

  try {
    const runs: AiRunResultDto[] = await Promise.all(
      prepared.map(async (p): Promise<AiRunResultDto> => {
        const base = { runGroupId, providerId: p.provider.id, modelId: p.modelId };
        // "started" fires on the first token (not at request time — that is
        // the "queued" event above): before that, the model is effectively
        // waiting on the provider, and a fast-failing request yields just the
        // error event.
        let started = false;
        let partial = "";
        const markStarted = (): void => {
          if (!started) {
            started = true;
            emit({ ...base, phase: "started" });
          }
        };
        const pushDelta = createDeltaThrottle((text) => emit({ ...base, phase: "delta", text }));
        try {
          const result = await streamPrompt({
            model: createProviderModel(p.config, p.modelId),
            prompt: content,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]),
            onDelta: (text) => {
              markStarted();
              partial = text;
              pushDelta(text);
            },
          });
          markStarted();
          const usage: TokenUsage = result.usage;
          const costUsd = catalog
            ? estimateCost(findCatalogModel(catalog, p.provider.type, p.modelId), usage)
            : null;
          const row = lib.recordModelRun({
            promptId: prompt.id,
            versionId,
            provider: p.provider.id,
            model: p.modelId,
            status: "completed",
            output: result.text,
            latencyMs: result.latencyMs,
            runGroupId,
            startedAt,
            metrics: { usage, costUsd },
          });
          emit({
            ...base,
            phase: "completed",
            text: result.text,
            latencyMs: result.latencyMs,
            usage,
            costUsd,
          });
          return {
            runId: row.id,
            providerId: p.provider.id,
            providerName: p.provider.name,
            modelId: p.modelId,
            status: "completed",
            output: result.text,
            error: null,
            latencyMs: result.latencyMs,
            usage,
            costUsd,
          };
        } catch (error) {
          // A rejected run must always carry a non-empty message —
          // recordModelRun rejects blank errors, aborting the group write.
          const message = controller.signal.aborted
            ? RUN_CANCELLED_MESSAGE
            : runFailureMessage(error instanceof Error ? error : new Error(String(error)));
          const row = lib.recordModelRun({
            promptId: prompt.id,
            versionId,
            provider: p.provider.id,
            model: p.modelId,
            status: "error",
            error: message,
            runGroupId,
            startedAt,
          });
          emit({ ...base, phase: "error", ...(partial ? { text: partial } : {}), error: message });
          return {
            runId: row.id,
            providerId: p.provider.id,
            providerName: p.provider.name,
            modelId: p.modelId,
            status: "error",
            output: null,
            error: message,
            latencyMs: null,
            usage: null,
            costUsd: null,
          };
        }
      }),
    );

    return {
      runGroupId,
      promptId: prompt.id,
      versionId,
      createdAt: runs[0] ? (lib.listRuns(prompt.id, { runGroupId })[0]?.created_at ?? startedAt) : startedAt,
      runs,
    };
  } finally {
    inFlightRunGroups.delete(runGroupId);
  }
}

// -------------------------------------------------------------------- assist

/** AI-assisted prompt authoring. No DB writes — the draft lives in the renderer. */
export async function runAssist(deps: AiServiceDeps, input: AiAssistInput): Promise<AiAssistResult> {
  const provider = requireRunnableProvider(deps, input.providerId, input.modelId);
  const meta =
    input.mode === "generate"
      ? buildGeneratePrompt(input.description!)
      : buildImprovePrompt(input.content!, input.instruction!);
  const result = await runPrompt({
    model: createProviderModel(configForProvider(deps.cipher, provider), input.modelId),
    prompt: meta,
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  return { text: stripWrappingFences(result.text) };
}

// --------------------------------------------------------------------- judge

/**
 * LLM-as-judge over a run group: the judge model scores every COMPLETED run
 * (error runs are skipped and noted in the response). Judging is read-only —
 * no DB writes; the renderer decides what to persist. Runs are judged through
 * a small fixed-concurrency pool (sequential judging would take ~6× the
 * per-call timeout in the worst case); a failed judge call lands in
 * `failures` and does not stop the rest of the group.
 */
export async function judgeRunGroup(deps: AiServiceDeps, input: AiJudgeInput): Promise<AiJudgeResult> {
  const { lib } = deps;
  const provider = requireRunnableProvider(deps, input.judge.providerId, input.judge.modelId);
  const rows = lib.listRunGroupRuns(input.runGroupId);
  if (rows.length === 0) throw new Error(`Run group not found: ${input.runGroupId}`);
  const model = createProviderModel(configForProvider(deps.cipher, provider), input.judge.modelId);

  const result: AiJudgeResult = { results: [], skipped: [], failures: [] };
  const judgeable: RunRow[] = [];
  for (const row of rows) {
    if (row.status !== "completed" || row.output === null) {
      result.skipped.push({
        runId: row.id,
        modelId: row.model,
        reason: row.error ?? "Run did not complete",
      });
    } else {
      judgeable.push(row);
    }
  }

  // Indexed slots keep results/failures in run order despite concurrency.
  const scored: Array<AiJudgeResult["results"][number] | null> = judgeable.map(() => null);
  const failed: Array<AiJudgeResult["failures"][number] | null> = judgeable.map(() => null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < judgeable.length) {
      const index = next;
      next += 1;
      const row = judgeable[index]!;
      try {
        const version = lib.getVersion(row.version_id);
        if (!version) throw new Error(`Version not found: ${row.version_id}`);
        const verdict = await runJudge({
          model,
          promptContent: version.content,
          output: row.output!,
          ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
          signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
        });
        const { rationale, ...scores } = verdict;
        scored[index] = { runId: row.id, modelId: row.model ?? "unknown", scores, rationale };
      } catch (error) {
        failed[index] = {
          runId: row.id,
          modelId: row.model ?? "unknown",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(JUDGE_CONCURRENCY, judgeable.length) }, () => worker()),
  );
  result.results = scored.filter((entry) => entry !== null);
  result.failures = failed.filter((entry) => entry !== null);
  return result;
}
