/**
 * Line-level diff computation for the version compare view. Pure functions
 * over strings so they can be unit-tested without a DOM.
 */
import { diffLines } from "diff";

export type DiffLineType = "added" | "removed" | "context";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 1-based line number within its own version; null for padding cells. */
  lineNumber: number | null;
}

/** One row of the side-by-side view: old version left, new version right. */
export interface DiffRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

export interface LineDiff {
  /** Side-by-side rows (old left, new right), removed/added lines paired up. */
  rows: DiffRow[];
  /** Unified view lines in document order. */
  unified: DiffLine[];
  addedCount: number;
  removedCount: number;
}

/** Splits a diff part value into lines, dropping the artifact of a trailing newline. */
function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Computes a line diff of `oldText` -> `newText`. Removed and added lines of
 * the same change block are paired into the same side-by-side row.
 */
export function computeLineDiff(oldText: string, newText: string): LineDiff {
  const parts = diffLines(oldText, newText);
  const unified: DiffLine[] = [];
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  let addedCount = 0;
  let removedCount = 0;
  let pendingRemoved: DiffLine[] = [];
  let pendingAdded: DiffLine[] = [];

  const flushPending = () => {
    const length = Math.max(pendingRemoved.length, pendingAdded.length);
    for (let i = 0; i < length; i += 1) {
      rows.push({ left: pendingRemoved[i] ?? null, right: pendingAdded[i] ?? null });
    }
    pendingRemoved = [];
    pendingAdded = [];
  };

  for (const part of parts) {
    const lines = splitLines(part.value);
    if (part.removed) {
      for (const text of lines) {
        const line: DiffLine = { type: "removed", text, lineNumber: oldLine };
        unified.push(line);
        pendingRemoved.push(line);
        oldLine += 1;
        removedCount += 1;
      }
    } else if (part.added) {
      for (const text of lines) {
        const line: DiffLine = { type: "added", text, lineNumber: newLine };
        unified.push(line);
        pendingAdded.push(line);
        newLine += 1;
        addedCount += 1;
      }
    } else {
      flushPending();
      for (const text of lines) {
        const line: DiffLine = { type: "context", text, lineNumber: oldLine };
        unified.push({ type: "context", text, lineNumber: oldLine });
        rows.push({
          left: line,
          right: { type: "context", text, lineNumber: newLine },
        });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  flushPending();

  return { rows, unified, addedCount, removedCount };
}
