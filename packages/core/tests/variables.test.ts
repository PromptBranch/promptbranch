import { describe, expect, it } from "vitest";
import {
  extractPromptVariables,
  missingPromptVariables,
  renderPromptVariablesBounded,
  substitutePromptVariables,
} from "../src/variables.js";

describe("prompt variables", () => {
  it("rejects more than 100 distinct names during discovery", () => {
    const content = Array.from({ length: 101 }, (_, i) => `{{v${i}}}`).join("");
    expect(() => extractPromptVariables(content)).toThrowError(
      expect.objectContaining({ code: "too-many-variables" }),
    );
  });

  it.each([
    ["template names", Array.from({ length: 101 }, (_, i) => `{{v${i}}}`).join(""), {}, "too-many-variables"],
    ["supplied entries", "plain", Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`v${i}`, ""])), "too-many-variables"],
    ["one value", "{{a}}", { a: "x".repeat(100_001) }, "variable-input-too-large"],
    ["supplied names", "plain", { ["a".repeat(500_000)]: "", ["b".repeat(500_001)]: "" }, "variable-input-too-large"],
    ["aggregate values", "plain", Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`v${i}`, "x".repeat(100_000)])), "variable-input-too-large"],
    ["amplification", "{{a}}".repeat(11), { a: "x".repeat(100_000) }, "rendered-content-too-large"],
    ["literal output", "x".repeat(1_000_001), {}, "rendered-content-too-large"],
  ] as const)("rejects %s overflow with a structured error", (_label, content, values, code) => {
    expect(() => substitutePromptVariables(content, values)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("accepts exact count, per-value, aggregate input and rendered UTF-16 limits", () => {
    const names = Array.from({ length: 100 }, (_, i) => `v${i}`);
    expect(extractPromptVariables(names.map((name) => `{{${name}}}`).join(" "))).toEqual(names);
    expect(substitutePromptVariables("plain", Object.fromEntries(names.map((name) => [name, ""])))).toBe("plain");
    expect(substitutePromptVariables("{{a}}".repeat(10), { a: "😀".repeat(50_000) })).toHaveLength(1_000_000);
    const exactInput = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`v${i}`, "x".repeat(99_998)]));
    expect(substitutePromptVariables("plain", exactInput)).toBe("plain");
    expect(substitutePromptVariables("x".repeat(1_000_000), {})).toHaveLength(1_000_000);
  });

  it("preserves unknown literals, empty values and non-recursive substitutions", () => {
    expect(substitutePromptVariables("{{a}}/{{another}}/{{empty}}/{{ unknown }}", {
      a: "{{another}}", another: "done", empty: "",
    })).toBe("{{another}}/done//{{ unknown }}");
    expect(substitutePromptVariables("{{constructor}}", {})).toBe("{{constructor}}");
  });

  it("honors custom limits in the public bounded renderer", () => {
    const limits = { maxVariables: 1, maxValueLength: 3, maxInputLength: 4, maxRenderedLength: 6 };
    expect(renderPromptVariablesBounded("{{a}}{{a}}", { a: "xyz" }, limits)).toBe("xyzxyz");
    expect(() => renderPromptVariablesBounded("{{a}}{{a}}!", { a: "xyz" }, limits))
      .toThrowError(expect.objectContaining({ code: "rendered-content-too-large" }));
    expect(() => renderPromptVariablesBounded("{{a}}{{b}}", {}, limits))
      .toThrowError(expect.objectContaining({ code: "too-many-variables" }));
    expect(() => renderPromptVariablesBounded("", { a: "", b: "" }, limits))
      .toThrowError(expect.objectContaining({ code: "too-many-variables" }));
    expect(() => renderPromptVariablesBounded("", { a: "long" }, limits))
      .toThrowError(expect.objectContaining({ code: "variable-input-too-large" }));
    expect(() => renderPromptVariablesBounded("", { aa: "xyz" }, limits))
      .toThrowError(expect.objectContaining({ code: "variable-input-too-large" }));
  });
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
