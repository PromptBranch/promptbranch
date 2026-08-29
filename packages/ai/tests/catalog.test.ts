import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MODELS_DEV_URL,
  detectCatalogEnvKeys,
  fetchCatalog,
  findCatalogModel,
  findCatalogProvider,
  listCatalogProviders,
  modelsForProvider,
  parseCatalog,
} from "../src/index.js";

const fixture: unknown = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "models-dev.sample.json"), "utf8"),
);

describe("catalog parsing", () => {
  const catalog = parseCatalog(fixture);

  it("parses the recorded models.dev fixture", () => {
    expect(Object.keys(catalog.models).sort()).toEqual(["anthropic", "google", "groq", "openai", "v0"]);
    expect(catalog.models["openai"]!.length).toBe(3);
  });

  it("parses provider-level metadata (name, env, api, npm, doc, model count)", () => {
    const groq = findCatalogProvider(catalog, "groq")!;
    expect(groq).toMatchObject({
      id: "groq",
      name: "Groq",
      env: ["GROQ_API_KEY"],
      api: "https://api.groq.com/openai/v1",
      npm: "@ai-sdk/openai-compatible",
      doc: "https://console.groq.com/docs/models",
      modelCount: 2,
    });
    // Providers without an `api` field parse it as null, not undefined.
    expect(findCatalogProvider(catalog, "openai")!.api).toBeNull();
    expect(findCatalogProvider(catalog, "nope")).toBeNull();
  });

  it("flattens the real models.dev model shape", () => {
    const mini = catalog.models["openai"]!.find((m) => m.id === "gpt-4o-mini")!;
    expect(mini.name).toBe("GPT-4o mini");
    expect(mini.contextWindow).toBe(128000);
    expect(mini.outputLimit).toBe(16384);
    expect(mini.inputModalities).toContain("text");
    expect(mini.reasoning).toBe(false);
    expect(mini.toolCall).toBe(true);
    expect(mini.costInput).toBe(0.15);
    expect(mini.costOutput).toBe(0.6);
  });

  it("parses cached-token pricing, null when absent", () => {
    const full = catalog.models["anthropic"]!.find((m) => m.id === "claude-haiku-4-5")!;
    expect(full.costCacheRead).toBe(0.1);
    expect(full.costCacheWrite).toBe(1.25);
    // cache_read only — cache_write parses as null, not undefined.
    const mini = catalog.models["openai"]!.find((m) => m.id === "gpt-4o-mini")!;
    expect(mini.costCacheRead).toBe(0.075);
    expect(mini.costCacheWrite).toBeNull();
    const plain = catalog.models["groq"]!.find((m) => m.id === "llama-3.3-70b-versatile")!;
    expect(plain.costCacheRead).toBeNull();
    expect(plain.costCacheWrite).toBeNull();
  });

  it("handles entries without pricing or limits", () => {
    const nano = catalog.models["openai"]!.find((m) => m.id === "gpt-5-nano");
    expect(nano).toBeDefined();
    // Fields missing in the JSON become null, not undefined/NaN.
    for (const model of Object.values(catalog.models).flat()) {
      expect(model.costInput === null || typeof model.costInput === "number").toBe(true);
      expect(model.contextWindow === null || typeof model.contextWindow === "number").toBe(true);
    }
  });

  it("rejects non-object payloads and skips malformed entries", () => {
    expect(() => parseCatalog(null)).toThrow();
    expect(() => parseCatalog("nope")).toThrow();
    const partial = parseCatalog({ broken: 42, empty: { models: null }, ok: { models: { m1: { name: "M1" } } } });
    expect(partial.models["broken"]).toBeUndefined();
    expect(partial.models["empty"]).toBeUndefined();
    expect(partial.models["ok"]).toEqual([
      expect.objectContaining({ id: "m1", name: "M1", costInput: null, contextWindow: null }),
    ]);
    expect(partial.providers).toHaveLength(1);
    expect(partial.providers[0]).toMatchObject({ id: "ok", name: "ok", env: [], api: null, modelCount: 1 });
  });
});

describe("listCatalogProviders", () => {
  const catalog = parseCatalog(fixture);
  const providers = listCatalogProviders(catalog);

  it("pins popular providers first (in fixed order), then sorts A-Z by name", () => {
    expect(providers.map((p) => p.id)).toEqual(["openai", "anthropic", "google", "groq", "v0"]);
    expect(providers.filter((p) => p.popular).map((p) => p.id)).toEqual(["openai", "anthropic", "google"]);
  });

  it("annotates the execution driver per provider", () => {
    const byId = new Map(providers.map((p) => [p.id, p]));
    expect(byId.get("openai")!.driver).toBe("openai");
    expect(byId.get("anthropic")!.driver).toBe("anthropic");
    expect(byId.get("google")!.driver).toBe("google");
    expect(byId.get("groq")!.driver).toBe("openai-compatible");
  });

  it("marks providers without an api URL and no native driver as not connectable", () => {
    const byId = new Map(providers.map((p) => [p.id, p]));
    expect(byId.get("groq")!.connectable).toBe(true); // api URL present
    expect(byId.get("openai")!.connectable).toBe(true); // native driver
    expect(byId.get("v0")!.connectable).toBe(false); // no api, no native driver
  });

  it("marks providers with a non-https api URL as not connectable", () => {
    const catalog = parseCatalog({
      secure: { id: "secure", name: "Secure", env: [], api: "https://api.example.com/v1", models: { m: { id: "m" } } },
      insecure: { id: "insecure", name: "Insecure", env: [], api: "http://api.example.com/v1", models: { m: { id: "m" } } },
      broken: { id: "broken", name: "Broken", env: [], api: "not a url", models: { m: { id: "m" } } },
    });
    const byId = new Map(listCatalogProviders(catalog).map((p) => [p.id, p]));
    expect(byId.get("secure")!.connectable).toBe(true);
    // Plaintext http would ship API keys unencrypted — not connectable.
    expect(byId.get("insecure")!.connectable).toBe(false);
    expect(byId.get("broken")!.connectable).toBe(false);
  });

  it("bridges well-known providers with no catalog api via the built-in fallback", () => {
    const catalog = parseCatalog({
      xai: { id: "xai", name: "xAI", env: ["XAI_API_KEY"], models: { "grok-4": { id: "grok-4" } } },
    });
    const xai = listCatalogProviders(catalog).find((p) => p.id === "xai")!;
    expect(xai.connectable).toBe(true);
    expect(xai.api).toBe("https://api.x.ai/v1");
  });

  it("lets the catalog api take precedence over the built-in fallback", () => {
    const catalog = parseCatalog({
      groq: {
        id: "groq",
        name: "Groq",
        env: ["GROQ_API_KEY"],
        api: "https://groq.example.com/custom/v1",
        models: { m: { id: "m" } },
      },
    });
    const groq = listCatalogProviders(catalog).find((p) => p.id === "groq")!;
    expect(groq.api).toBe("https://groq.example.com/custom/v1");
    // The fixture's own groq api is used, never the fallback.
    const fromFixture = listCatalogProviders(parseCatalog(fixture)).find((p) => p.id === "groq")!;
    expect(fromFixture.api).toBe("https://api.groq.com/openai/v1");
  });
});

describe("detectCatalogEnvKeys", () => {
  it("matches any catalog provider whose env vars intersect the environment", () => {
    const catalog = parseCatalog(fixture);
    const result = detectCatalogEnvKeys(catalog, { GROQ_API_KEY: "gsk_x", OPENAI_API_KEY: "  " });
    expect(result).toEqual({ anthropic: false, google: false, groq: true, openai: false, v0: false });
    expect(JSON.stringify(result)).not.toContain("gsk_x");
  });
});

describe("modelsForProvider", () => {
  const catalog = parseCatalog(fixture);

  it("returns the models of any catalog provider key", () => {
    expect(modelsForProvider(catalog, "openai").map((m) => m.id)).toContain("gpt-4o-mini");
    expect(modelsForProvider(catalog, "anthropic").map((m) => m.id)).toContain("claude-haiku-4-5");
    expect(modelsForProvider(catalog, "google").map((m) => m.id)).toContain("gemini-2.5-flash-lite");
    expect(modelsForProvider(catalog, "groq").map((m) => m.id)).toContain("llama-3.3-70b-versatile");
  });

  it("returns an empty list for keys without a catalog entry", () => {
    expect(modelsForProvider(catalog, "openai-compatible")).toEqual([]);
    expect(modelsForProvider(catalog, "nope")).toEqual([]);
  });

  it("finds single entries for cost estimation", () => {
    expect(findCatalogModel(catalog, "anthropic", "claude-haiku-4-5")?.costInput).toBe(1);
    expect(findCatalogModel(catalog, "anthropic", "nonexistent")).toBeNull();
  });
});

describe("fetchCatalog", () => {
  it("uses the injected fetch implementation and parses the body", async () => {
    const catalog = await fetchCatalog(async (url) => {
      expect(url).toBe(MODELS_DEV_URL);
      return { ok: true, status: 200, json: async () => fixture };
    });
    expect(Object.keys(catalog.models)).toContain("openai");
  });

  it("throws on HTTP errors", async () => {
    await expect(
      fetchCatalog(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("throws on network errors", async () => {
    await expect(
      fetchCatalog(async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(/ENOTFOUND/);
  });
});

