/**
 * models.dev catalog: fetch + parse + filter. This package deliberately does
 * NOT cache — callers (core/desktop) own persistence and staleness policy.
 *
 * Shape reference (https://models.dev/api.json):
 *   Record<providerKey, {
 *     id, name, env: string[], npm, api?, doc,
 *     models: Record<modelId, {
 *       id, name, attachment, reasoning, tool_call, structured_output,
 *       modalities: { input: string[], output: string[] },
 *       limit?: { context?: number, output?: number },
 *       cost?: { input?: number, output?: number, cache_read?: number, ... },
 *       ...
 *     }>
 *   }>
 * All cost figures are USD per million tokens.
 *
 * Provider-level note: entries whose `npm` package knows its own default
 * endpoint (openai, anthropic, google, groq, …) carry no `api` base URL. We
 * run the first three through their native AI SDK drivers; every other
 * provider needs `api` to be connectable (via @ai-sdk/openai-compatible),
 * with FALLBACK_BASE_URLS bridging well-known catalog gaps.
 */
import { driverForCatalogId, type ProviderDriver } from "./providers.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** One model entry from the catalog, flattened and typed. */
export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number | null;
  outputLimit: number | null;
  inputModalities: string[];
  outputModalities: string[];
  reasoning: boolean;
  toolCall: boolean;
  /** USD per million input tokens; null when pricing is unknown. */
  costInput: number | null;
  /** USD per million output tokens; null when pricing is unknown. */
  costOutput: number | null;
  /** USD per million cache-read tokens; null when the entry declares none. */
  costCacheRead: number | null;
  /** USD per million cache-write tokens; null when the entry declares none. */
  costCacheWrite: number | null;
}

/** One provider entry from the catalog (models.dev top-level key). */
export interface CatalogProvider {
  id: string;
  name: string;
  /** Environment variables that may hold this provider's API key. */
  env: string[];
  /** OpenAI-compatible base URL; null when the entry declares none. */
  api: string | null;
  /** AI SDK package models.dev recommends, e.g. "@ai-sdk/openai-compatible". */
  npm: string | null;
  doc: string | null;
  modelCount: number;
}

/** Parsed catalog: provider metadata + models per provider key. */
export interface ModelCatalog {
  providers: CatalogProvider[];
  /** models.dev provider key → models (id-sorted). */
  models: Record<string, CatalogModel[]>;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function parseModel(id: string, raw: unknown): CatalogModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const limit = (record["limit"] ?? {}) as Record<string, unknown>;
  const cost = (record["cost"] ?? {}) as Record<string, unknown>;
  const modalities = (record["modalities"] ?? {}) as Record<string, unknown>;
  return {
    id,
    name: typeof record["name"] === "string" ? record["name"] : id,
    contextWindow: asNumber(limit["context"]),
    outputLimit: asNumber(limit["output"]),
    inputModalities: asStringArray(modalities["input"]),
    outputModalities: asStringArray(modalities["output"]),
    reasoning: record["reasoning"] === true,
    toolCall: record["tool_call"] === true,
    costInput: asNumber(cost["input"]),
    costOutput: asNumber(cost["output"]),
    costCacheRead: asNumber(cost["cache_read"]),
    costCacheWrite: asNumber(cost["cache_write"]),
  };
}

/**
 * Parses raw models.dev JSON into a typed catalog. Unknown providers/models
 * with unexpected shapes are skipped rather than failing the whole parse.
 */
export function parseCatalog(raw: unknown): ModelCatalog {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("models.dev payload is not an object");
  }
  const providers: CatalogProvider[] = [];
  const models: Record<string, CatalogModel[]> = {};
  for (const [providerKey, providerValue] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof providerValue !== "object" || providerValue === null) continue;
    const record = providerValue as Record<string, unknown>;
    const rawModels = record["models"];
    if (typeof rawModels !== "object" || rawModels === null) continue;
    const parsed: CatalogModel[] = [];
    for (const [modelId, modelValue] of Object.entries(rawModels as Record<string, unknown>)) {
      const model = parseModel(modelId, modelValue);
      if (model) parsed.push(model);
    }
    parsed.sort((a, b) => a.id.localeCompare(b.id));
    providers.push({
      id: providerKey,
      name: asString(record["name"]) ?? providerKey,
      env: asStringArray(record["env"]),
      api: asString(record["api"]),
      npm: asString(record["npm"]),
      doc: asString(record["doc"]),
      modelCount: parsed.length,
    });
    models[providerKey] = parsed;
  }
  providers.sort((a, b) => a.id.localeCompare(b.id));
  return { providers, models };
}

export type FetchImpl = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Fetches and parses the models.dev catalog. Throws on network/HTTP errors.
 * The default fetch times out after `timeoutMs` (overridable); injected
 * implementations own their own timeout.
 */
export async function fetchCatalog(fetchImpl?: FetchImpl, timeoutMs = 15_000): Promise<ModelCatalog> {
  const doFetch: FetchImpl =
    fetchImpl ??
    ((url: string) => fetch(url, { signal: AbortSignal.timeout(timeoutMs) }) as unknown as ReturnType<FetchImpl>);
  const response = await doFetch(MODELS_DEV_URL);
  if (!response.ok) {
    throw new Error(`models.dev request failed with HTTP ${response.status}`);
  }
  return parseCatalog(await response.json());
}

// ----------------------------------------------------------- provider listing

/** Catalog providers pinned to the top of connect lists, in this order. */
export const POPULAR_PROVIDER_IDS = ["openai", "anthropic", "google"] as const;

/** A catalog provider annotated for the connect-provider list. */
export interface CatalogProviderInfo extends CatalogProvider {
  /** Pinned in the "Popular" group. */
  popular: boolean;
  /** Execution driver this provider would run through. */
  driver: ProviderDriver;
  /**
   * False when the provider has no https `api` base URL and no native
   * driver — there is no safe endpoint to talk to, so it is not offered for
   * connecting.
   */
  connectable: boolean;
}

/**
 * Catalog endpoints must be https — a plaintext http api URL would ship API
 * keys unencrypted, so such providers are not offered for connecting.
 */
function isHttpsUrl(value: string | null): boolean {
  if (value === null) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Built-in base URLs for well-known providers whose models.dev entry
 * currently publishes no `api` (each URL verified against the provider's
 * official docs). Gap-filler ONLY: the catalog's own `api` always wins when
 * present — see catalogBaseUrl.
 */
const FALLBACK_BASE_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  perplexity: "https://api.perplexity.ai",
};

/**
 * The OpenAI-compatible base URL for a catalog provider: its own `api` when
 * the catalog publishes one, else the curated fallback for known providers,
 * else null (not connectable without a user-supplied URL).
 */
export function catalogBaseUrl(provider: CatalogProvider): string | null {
  return provider.api ?? FALLBACK_BASE_URLS[provider.id] ?? null;
}

/**
 * Every catalog provider, annotated and sorted for display: popular providers
 * first (in POPULAR_PROVIDER_IDS order), then the rest alphabetically by name.
 */
export function listCatalogProviders(catalog: ModelCatalog): CatalogProviderInfo[] {
  const popularRank = new Map<string, number>(POPULAR_PROVIDER_IDS.map((id, index) => [id, index]));
  return catalog.providers
    .map((provider): CatalogProviderInfo => {
      const driver = driverForCatalogId(provider.id);
      // Surface the fallback URL in `api` so connect flows prefill it; the
      // catalog's own `api` takes precedence inside catalogBaseUrl.
      const api = catalogBaseUrl(provider);
      return {
        ...provider,
        api,
        popular: popularRank.has(provider.id),
        driver,
        connectable: driver !== "openai-compatible" || isHttpsUrl(api),
      };
    })
    .sort((a, b) => {
      const aRank = popularRank.get(a.id);
      const bRank = popularRank.get(b.id);
      if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
      if (aRank !== undefined) return -1;
      if (bRank !== undefined) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

/** Finds one catalog provider entry by models.dev id, or null. */
export function findCatalogProvider(catalog: ModelCatalog, providerId: string): CatalogProvider | null {
  return catalog.providers.find((p) => p.id === providerId) ?? null;
}

/**
 * Reports which catalog providers have at least one of their documented env
 * vars set. Booleans only — key material is never read beyond presence.
 */
export function detectCatalogEnvKeys(
  catalog: ModelCatalog,
  env: Record<string, string | undefined>,
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const provider of catalog.providers) {
    result[provider.id] = provider.env.some((name) => Boolean(env[name]?.trim()));
  }
  return result;
}

// ------------------------------------------------------------------ models

/** Models of one catalog provider key; unknown keys yield an empty list. */
export function modelsForProvider(catalog: ModelCatalog, providerKey: string): CatalogModel[] {
  return catalog.models[providerKey] ?? [];
}

/** Finds a single catalog entry for cost estimation, or null. */
export function findCatalogModel(
  catalog: ModelCatalog,
  providerKey: string,
  modelId: string,
): CatalogModel | null {
  return modelsForProvider(catalog, providerKey).find((m) => m.id === modelId) ?? null;
}
