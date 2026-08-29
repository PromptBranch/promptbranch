/**
 * Provider registry: the single place that knows how to turn a stored provider
 * config into an AI SDK LanguageModel.
 *
 * Driver model: a stored provider's `type` is its models.dev catalog id
 * (e.g. "openai", "groq", "openrouter"; "openai-compatible" for fully custom
 * endpoints), while its `driver` decides execution. The three native drivers
 * (openai/anthropic/google) use their dedicated AI SDK packages; every other
 * catalog provider runs through @ai-sdk/openai-compatible against the base
 * URL recorded at connect time — that's how the long tail is supported
 * without per-provider packages.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/** Execution drivers — how a provider talks to its endpoint. */
export type ProviderDriver = "openai" | "anthropic" | "google" | "openai-compatible";

export interface ProviderDescriptor {
  id: ProviderDriver;
  displayName: string;
  /** Environment variable users would recognize the API key by. */
  envVarHint: string | null;
  /** True when a base URL must be supplied (custom/self-hosted endpoints). */
  requiresBaseUrl: boolean;
  docUrl: string;
  /** Key in the models.dev catalog, or null when the driver has no entry. */
  modelsDevKey: string | null;
  /** Cheap model used by the connection test when no model id is given. */
  defaultTestModel: string | null;
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    envVarHint: "OPENAI_API_KEY",
    requiresBaseUrl: false,
    docUrl: "https://platform.openai.com/docs/models",
    modelsDevKey: "openai",
    defaultTestModel: "gpt-4o-mini",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    envVarHint: "ANTHROPIC_API_KEY",
    requiresBaseUrl: false,
    docUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
    modelsDevKey: "anthropic",
    defaultTestModel: "claude-haiku-4-5",
  },
  {
    id: "google",
    displayName: "Google",
    envVarHint: "GOOGLE_GENERATIVE_AI_API_KEY",
    requiresBaseUrl: false,
    docUrl: "https://ai.google.dev/gemini-api/docs/models",
    modelsDevKey: "google",
    defaultTestModel: "gemini-2.5-flash-lite",
  },
  {
    id: "openai-compatible",
    displayName: "OpenAI-compatible",
    envVarHint: null,
    requiresBaseUrl: true,
    docUrl: "https://ai-sdk.dev/providers/openai-compatible-providers",
    modelsDevKey: null,
    defaultTestModel: null,
  },
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

const NATIVE_DRIVER_IDS = new Set<string>(["openai", "anthropic", "google"]);

export function getProviderDescriptor(driver: ProviderDriver): ProviderDescriptor {
  const descriptor = byId.get(driver);
  if (!descriptor) throw new Error(`Unknown provider driver: ${driver}`);
  return descriptor;
}

export function isProviderDriver(value: string): value is ProviderDriver {
  return byId.has(value as ProviderDriver);
}

/**
 * Resolves the execution driver for a models.dev catalog id: the three
 * first-party providers keep their native drivers; everything else (including
 * fully custom endpoints) runs through the OpenAI-compatible driver.
 */
export function driverForCatalogId(catalogId: string): ProviderDriver {
  return NATIVE_DRIVER_IDS.has(catalogId) ? (catalogId as ProviderDriver) : "openai-compatible";
}

/** Stored configuration for one provider instance (post-decryption). */
export interface ProviderConfig {
  driver: ProviderDriver;
  apiKey?: string;
  baseUrl?: string;
  /** Provider name, used as the OpenAI-compatible client name. */
  name?: string;
}

/**
 * Builds an AI SDK LanguageModel for `modelId` on the given provider.
 * Throws on unknown drivers or a missing base URL for openai-compatible
 * endpoints.
 */
export function createProviderModel(config: ProviderConfig, modelId: string): LanguageModel {
  switch (config.driver) {
    case "openai":
      return createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl })(modelId);
    case "anthropic":
      return createAnthropic({ apiKey: config.apiKey, baseURL: config.baseUrl })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: config.baseUrl })(modelId);
    case "openai-compatible": {
      if (!config.baseUrl) {
        throw new Error(`Provider driver "openai-compatible" requires a base URL`);
      }
      return createOpenAICompatible({
        name: config.name ?? "custom",
        baseURL: config.baseUrl,
        // Ollama/LM Studio and friends usually need no key; the SDK still
        // wants a string, so fall back to a placeholder.
        apiKey: config.apiKey ?? "not-required",
      })(modelId);
    }
    default:
      throw new Error(`Unknown provider driver: ${String(config.driver)}`);
  }
}
