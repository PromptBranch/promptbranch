import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  createProviderModel,
  driverForCatalogId,
  getProviderDescriptor,
  isProviderDriver,
  type ProviderDriver,
} from "../src/index.js";

describe("provider registry", () => {
  it("covers the four execution drivers", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(["openai", "anthropic", "google", "openai-compatible"]);
  });

  it("every descriptor has display name, doc url and a models.dev mapping decision", () => {
    for (const provider of PROVIDERS) {
      expect(provider.displayName.length).toBeGreaterThan(0);
      expect(provider.docUrl).toMatch(/^https:/);
      // modelsDevKey is either a real key or explicitly null (openai-compatible).
      expect(provider).toHaveProperty("modelsDevKey");
      if (provider.id === "openai-compatible") {
        expect(provider.modelsDevKey).toBeNull();
        expect(provider.requiresBaseUrl).toBe(true);
        expect(provider.defaultTestModel).toBeNull();
      } else {
        expect(provider.modelsDevKey).toBe(provider.id);
        expect(provider.requiresBaseUrl).toBe(false);
        expect(provider.defaultTestModel).not.toBeNull();
      }
    }
  });

  it("default test models point at cheap tiers", () => {
    expect(getProviderDescriptor("openai").defaultTestModel).toBe("gpt-4o-mini");
    expect(getProviderDescriptor("anthropic").defaultTestModel).toContain("haiku");
    expect(getProviderDescriptor("google").defaultTestModel).toContain("flash");
  });

  it("isProviderDriver guards unknown values", () => {
    expect(isProviderDriver("openai")).toBe(true);
    expect(isProviderDriver("mistral")).toBe(false);
    expect(() => getProviderDescriptor("mistral" as ProviderDriver)).toThrow(/Unknown provider driver/);
  });
});

describe("driverForCatalogId", () => {
  it("keeps native drivers for the three first-party providers", () => {
    expect(driverForCatalogId("openai")).toBe("openai");
    expect(driverForCatalogId("anthropic")).toBe("anthropic");
    expect(driverForCatalogId("google")).toBe("google");
  });

  it("routes every other catalog id through the openai-compatible driver", () => {
    expect(driverForCatalogId("groq")).toBe("openai-compatible");
    expect(driverForCatalogId("openrouter")).toBe("openai-compatible");
    expect(driverForCatalogId("openai-compatible")).toBe("openai-compatible");
  });
});

describe("createProviderModel", () => {
  it("builds a model for each driver", () => {
    for (const provider of PROVIDERS) {
      const model = createProviderModel(
        { driver: provider.id, apiKey: "test-key", baseUrl: provider.requiresBaseUrl ? "http://localhost:1/v1" : undefined },
        provider.defaultTestModel ?? "any-model",
      );
      expect(model).toBeDefined();
    }
  });

  it("builds a long-tail catalog provider through the openai-compatible driver", () => {
    const model = createProviderModel(
      {
        driver: driverForCatalogId("groq"),
        apiKey: "gsk_test",
        baseUrl: "https://api.groq.com/openai/v1",
        name: "Groq",
      },
      "llama-3.3-70b-versatile",
    );
    expect(model).toBeDefined();
  });

  it("rejects openai-compatible without a base URL", () => {
    expect(() => createProviderModel({ driver: "openai-compatible" }, "llama3")).toThrow(/base URL/);
  });

  it("rejects unknown drivers", () => {
    expect(() => createProviderModel({ driver: "wat" as ProviderDriver }, "m")).toThrow(
      /Unknown provider driver/,
    );
  });
});
