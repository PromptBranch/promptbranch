import { beforeAll, describe, expect, it } from "vitest";
import { getHighlighter, highlightCacheSize, highlightCode, resolveLanguage } from "./highlight";

describe("highlightCode", () => {
  beforeAll(async () => {
    await getHighlighter();
  });

  it("highlights a known language with dual-theme CSS vars", () => {
    const html = highlightCode("const a: number = 1", "typescript");
    expect(html).toContain("--shiki-dark");
    expect(html).toContain("--shiki-light");
  });

  it("resolves common aliases", () => {
    expect(resolveLanguage("ts")).toBe("ts");
    expect(resolveLanguage("py")).toBe("py");
    expect(resolveLanguage("sh")).toBe("sh");
    expect(highlightCode("print('hi')", "py")).toContain("--shiki-dark");
  });

  it("returns null for unknown languages (plain-block fallback, no crash)", () => {
    expect(resolveLanguage("cobol")).toBeNull();
    expect(highlightCode("MOVE A TO B.", "cobol")).toBeNull();
  });

  it("returns null for explicit plaintext fences", () => {
    expect(highlightCode("hello", "text")).toBeNull();
    expect(highlightCode("hello", "plaintext")).toBeNull();
  });

  it("returns null when no language is given", () => {
    expect(highlightCode("plain block", null)).toBeNull();
  });

  it("never caches partial (still-growing streaming) blocks", () => {
    const before = highlightCacheSize();
    // A long stream of unique growing blocks must not grow (or churn) the cache.
    for (let i = 0; i < 400; i++) {
      const html = highlightCode(`let streaming_value = ${i};`, "typescript", { partial: true });
      expect(html).not.toBeNull();
    }
    expect(highlightCacheSize()).toBe(before);
    // Settled renders still cache (one new entry).
    expect(highlightCode("let settled_after_stream = 1;", "typescript")).not.toBeNull();
    expect(highlightCacheSize()).toBe(before + 1);
  });
});
