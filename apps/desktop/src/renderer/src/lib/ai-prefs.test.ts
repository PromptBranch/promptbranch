// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  extractVariableNames,
  getRunModelSelection,
  getRunVariables,
  projectRunVariables,
  setRunModelSelection,
  setRunVariables,
} from "./ai-prefs";

beforeEach(() => {
  localStorage.clear();
});

describe("extractVariableNames", () => {
  it("returns names in order of first appearance, deduplicated", () => {
    expect(extractVariableNames("Hi {{name}}, meet {{topic}}. Again: {{ name }}")).toEqual([
      "name",
      "topic",
    ]);
  });

  it("tolerates whitespace and unicode names", () => {
    expect(extractVariableNames("{{  code_snippet-1 }} {{ Sprache }} {{a.b}}")).toEqual([
      "code_snippet-1",
      "Sprache",
      "a.b",
    ]);
  });

  it("ignores empty or malformed placeholders", () => {
    expect(extractVariableNames("{{}} {{ }} {single} plain text")).toEqual([]);
  });
});

describe("run model selection prefs", () => {
  it("returns null when never set", () => {
    expect(getRunModelSelection("p1")).toBeNull();
  });

  it("round-trips a selection scoped per prompt", () => {
    const refs = [
      { providerId: "prov-1", modelId: "claude-opus" },
      { providerId: "prov-2", modelId: "gpt-x" },
    ];
    setRunModelSelection("p1", refs);
    expect(getRunModelSelection("p1")).toEqual(refs);
    expect(getRunModelSelection("p2")).toBeNull();
  });

  it("rejects corrupt or malformed stored values", () => {
    localStorage.setItem("promptbuilder:pref:run-models:p1", "{not json");
    expect(getRunModelSelection("p1")).toBeNull();
    localStorage.setItem(
      "promptbuilder:pref:run-models:p1",
      JSON.stringify([{ providerId: "prov-1" }]), // missing modelId
    );
    expect(getRunModelSelection("p1")).toBeNull();
  });
});

describe("run variable prefs", () => {
  it("projects own saved values onto current names in template order", () => {
    const saved = { stale: "secret", second: "B", first: "A", empty: "" };
    const values = projectRunVariables(["first", "missing", "second", "empty", "first", "constructor"], saved);
    expect(values).toEqual({ first: "A", second: "B", empty: "" });
    expect(Object.keys(values)).toEqual(["first", "second", "empty"]);
    expect(projectRunVariables([], saved)).toEqual({});
    expect(saved.stale).toBe("secret");
  });
  it("defaults to an empty object and round-trips values", () => {
    expect(getRunVariables("p1")).toEqual({});
    setRunVariables("p1", { name: "Ada", topic: "testing" });
    expect(getRunVariables("p1")).toEqual({ name: "Ada", topic: "testing" });
  });

  it("rejects non-string values", () => {
    localStorage.setItem(
      "promptbuilder:pref:run-variables:p1",
      JSON.stringify({ name: 42 }),
    );
    expect(getRunVariables("p1")).toEqual({});
  });
});
