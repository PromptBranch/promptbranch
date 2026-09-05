import { describe, expect, it } from "vitest";
import {
  extractPromptVariables,
  missingPromptVariables,
  substitutePromptVariables,
} from "../src/variables.js";

describe("prompt variables", () => {
  it("extracts supported names once in first-appearance order", () => {
    expect(
      extractPromptVariables(
        "{{ target }} {{number_of_agents}} {{target}} {{Sprache}} {{a.b}} {{code-snippet_1}}",
      ),
    ).toEqual(["target", "number_of_agents", "Sprache", "a.b", "code-snippet_1"]);
  });

  it("ignores malformed placeholders", () => {
    expect(extractPromptVariables("{{}} {{ }} {{has spaces}} {single} plain text")).toEqual([]);
  });

  it("reports absent and empty values while accepting other scalar values", () => {
    expect(
      missingPromptVariables("{{target}} {{count}} {{enabled}} {{note}} {{whitespace}}", {
        target: "packages/core",
        count: 0,
        enabled: false,
        note: "",
        whitespace: "   ",
      }),
    ).toEqual(["note"]);
  });

  it("substitutes strings, numbers and booleans without evaluating their contents", () => {
    expect(
      substitutePromptVariables(
        "Review {{target}} with {{count}} agents; enabled={{enabled}}; literal={{literal}}",
        {
          target: "packages/core",
          count: 3,
          enabled: false,
          literal: "{{do_not_expand}}",
        },
      ),
    ).toBe(
      "Review packages/core with 3 agents; enabled=false; literal={{do_not_expand}}",
    );
  });

  it("leaves missing placeholders unchanged", () => {
    expect(substitutePromptVariables("Hi {{name}} from {{place}}", { name: "Ada" })).toBe(
      "Hi Ada from {{place}}",
    );
  });
});
