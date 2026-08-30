import { describe, expect, it } from "vitest";
import { computeLineDiff } from "./diff";

describe("computeLineDiff", () => {
  it("returns only context rows for identical inputs", () => {
    const diff = computeLineDiff("a\nb\nc\n", "a\nb\nc\n");
    expect(diff.addedCount).toBe(0);
    expect(diff.removedCount).toBe(0);
    expect(diff.rows).toHaveLength(3);
    expect(diff.rows[0]).toEqual({
      left: { type: "context", text: "a", lineNumber: 1 },
      right: { type: "context", text: "a", lineNumber: 1 },
    });
  });

  it("pairs removed and added lines of one change block side by side", () => {
    const diff = computeLineDiff("one\ntwo\nthree\n", "one\n2\nthree\n");
    expect(diff.removedCount).toBe(1);
    expect(diff.addedCount).toBe(1);
    const changeRow = diff.rows[1]!;
    expect(changeRow.left).toEqual({ type: "removed", text: "two", lineNumber: 2 });
    expect(changeRow.right).toEqual({ type: "added", text: "2", lineNumber: 2 });
  });

  it("pads the shorter side when block sizes differ", () => {
    const diff = computeLineDiff("a\nx\n", "a\ny\nz\n");
    // rows: context a, removed x + added y, padded + added z
    expect(diff.rows).toHaveLength(3);
    expect(diff.rows[2]!.left).toBeNull();
    expect(diff.rows[2]!.right).toEqual({ type: "added", text: "z", lineNumber: 3 });
  });

  it("produces a unified view in document order with correct line numbers", () => {
    const diff = computeLineDiff("a\nb\n", "b\nc\n");
    expect(diff.unified).toEqual([
      { type: "removed", text: "a", lineNumber: 1 },
      { type: "context", text: "b", lineNumber: 2 },
      { type: "added", text: "c", lineNumber: 2 },
    ]);
  });

  it("handles empty inputs", () => {
    expect(computeLineDiff("", "").rows).toHaveLength(0);
    const diff = computeLineDiff("", "new\n");
    expect(diff.addedCount).toBe(1);
    expect(diff.rows[0]).toEqual({
      left: null,
      right: { type: "added", text: "new", lineNumber: 1 },
    });
  });
});
