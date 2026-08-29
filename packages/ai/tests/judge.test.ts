import { describe, expect, it } from "vitest";
import { buildJudgePrompt, judgeAverage, parseJudgeVerdict } from "../src/index.js";

describe("buildJudgePrompt", () => {
  it("embeds prompt, output and the strict JSON shape", () => {
    const prompt = buildJudgePrompt({ promptContent: "Review this code", output: "Looks fine." });
    expect(prompt).toContain('"""\nReview this code\n"""');
    expect(prompt).toContain('"""\nLooks fine.\n"""');
    expect(prompt).toContain('"effectiveness":1-5');
    expect(prompt).toMatch(/ONLY a JSON object/);
    expect(prompt).not.toContain("user criteria");
  });

  it("adds the user criteria line when given", () => {
    const prompt = buildJudgePrompt({
      promptContent: "p",
      output: "o",
      criteria: "  Prefer terse answers.  ",
    });
    expect(prompt).toContain("user criteria: Prefer terse answers.");
  });
});

describe("parseJudgeVerdict", () => {
  const valid = { effectiveness: 5, clarity: 4, completeness: 4, actionability: 3, rationale: "Solid." };

  it("parses a clean JSON object", () => {
    expect(parseJudgeVerdict(JSON.stringify(valid))).toEqual(valid);
  });

  it("tolerates fences and surrounding prose", () => {
    expect(parseJudgeVerdict(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toEqual(valid);
    expect(parseJudgeVerdict(`Here you go: ${JSON.stringify(valid)} hope that helps`)).toEqual(valid);
  });

  it("rejects malformed JSON and out-of-range scores", () => {
    expect(() => parseJudgeVerdict("not json at all")).toThrow();
    expect(() => parseJudgeVerdict(JSON.stringify({ ...valid, clarity: 9 }))).toThrow();
    expect(() => parseJudgeVerdict(JSON.stringify({ ...valid, rationale: "" }))).toThrow();
  });
});

describe("judgeAverage", () => {
  it("means the four dimensions, rounded to one decimal", () => {
    expect(
      judgeAverage({ effectiveness: 5, clarity: 4, completeness: 4, actionability: 3 }),
    ).toBe(4);
    expect(
      judgeAverage({ effectiveness: 5, clarity: 5, completeness: 4, actionability: 4 }),
    ).toBe(4.5);
  });
});
