import { describe, expect, it } from "vitest";
import { estimateCost, parseCatalog } from "../src/index.js";
import fs from "node:fs";
import path from "node:path";

const catalog = parseCatalog(
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "models-dev.sample.json"), "utf8")),
);
const mini = catalog.models["openai"]!.find((m) => m.id === "gpt-4o-mini")!; // $0.15 in / $0.60 out per 1M

describe("estimateCost", () => {
  it("computes USD from per-million-token pricing", () => {
    // 100k input ($0.015) + 10k output ($0.006) = $0.021
    expect(estimateCost(mini, { inputTokens: 100_000, outputTokens: 10_000 })).toBeCloseTo(0.021, 8);
  });

  it("returns null when pricing is unknown", () => {
    expect(estimateCost({ costInput: null, costOutput: 0.6 }, { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(estimateCost({ costInput: 0.15, costOutput: null }, { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(estimateCost(null, { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });

  it("returns null when usage is missing", () => {
    expect(estimateCost(mini, { inputTokens: null, outputTokens: 10 })).toBeNull();
    expect(estimateCost(mini, { inputTokens: 10, outputTokens: null })).toBeNull();
  });

  it("handles zero-token runs", () => {
    expect(estimateCost(mini, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});
