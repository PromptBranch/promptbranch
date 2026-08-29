import { describe, expect, it } from "vitest";
import { buildGeneratePrompt, buildImprovePrompt, stripWrappingFences } from "../src/index.js";

describe("assist prompt builders", () => {
  it("buildGeneratePrompt embeds the description and asks for prompt-only output", () => {
    const prompt = buildGeneratePrompt("  summarize support tickets  ");
    expect(prompt).toContain("summarize support tickets");
    expect(prompt).toContain("{{variable}}");
    expect(prompt).toMatch(/ONLY the prompt text/);
  });

  it("buildImprovePrompt embeds content and instruction, preserving placeholders rule", () => {
    const prompt = buildImprovePrompt("Summarize {{ticket}}.", "Make it more formal");
    expect(prompt).toContain("Summarize {{ticket}}.");
    expect(prompt).toContain("Make it more formal");
    expect(prompt).toContain("{{variable}} placeholders intact");
  });
});

describe("stripWrappingFences", () => {
  it("strips a wrapping code fence", () => {
    expect(stripWrappingFences("```markdown\nhello {{name}}\n```")).toBe("hello {{name}}");
    expect(stripWrappingFences("```\nplain\n```")).toBe("plain");
  });

  it("trims plain output and leaves inner fences alone", () => {
    expect(stripWrappingFences("  padded  ")).toBe("padded");
    expect(stripWrappingFences("before\n```\ncode\n```\nafter")).toBe("before\n```\ncode\n```\nafter");
  });
});
