import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Columns2, Minus, Plus, Rows3, X } from "lucide-react";
import type { VersionDto } from "../../../shared/ipc.js";
import { useVersionContent } from "../hooks/use-data";
import { computeLineDiff, type DiffLine } from "../lib/diff";
import { cx } from "../lib/time";
import { Spinner } from "./ui";

const LINE_HEIGHT = "leading-5";

function lineClass(type: DiffLine["type"]): string {
  switch (type) {
    case "added":
      return "bg-diff-add-bg text-diff-add-text";
    case "removed":
      return "bg-diff-del-bg text-diff-del-text";
    default:
      return "text-ink-dim";
  }
}

function gutterClass(type: DiffLine["type"]): string {
  switch (type) {
    case "added":
      return "bg-diff-add-bg text-diff-add-gutter";
    case "removed":
      return "bg-diff-del-bg text-diff-del-gutter";
    default:
      return "text-ink-faint";
  }
}

function VersionMeta({ version, side }: { version: VersionDto; side: "left" | "right" }) {
  return (
    <div className={cx("min-w-0 flex-1", side === "right" && "text-right")}>
      <div className={cx("flex items-baseline gap-2", side === "right" && "justify-end")}>
        <span className="text-[13px] font-semibold text-ink">{version.displayLabel}</span>
        <span className="flex items-center gap-1 text-[11px] text-ink-faint">
          {version.branchName !== "main" && (
            <span className="rounded-full border border-line px-1.5 py-px text-[10px] text-ink-dim">
              {version.branchName}
            </span>
          )}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[11px] italic text-ink-faint">
        {version.changeNote ?? "No change note"}
      </p>
    </div>
  );
}

/**
 * Side-by-side (or unified) line diff of two versions' content. Both panes
 * live in one scroll container, so they stay row-aligned by construction.
 */
export function CompareDialog({
  base,
  other,
  open,
  onOpenChange,
}: {
  /** Left/base side (typically the older version). */
  base: VersionDto | null;
  /** Right side (typically the newer version). */
  other: VersionDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<"split" | "unified">("split");
  const baseQuery = useVersionContent(open ? (base?.id ?? null) : null);
  const otherQuery = useVersionContent(open ? (other?.id ?? null) : null);

  const diff = useMemo(
    () =>
      baseQuery.data && otherQuery.data
        ? computeLineDiff(baseQuery.data.content, otherQuery.data.content)
        : null,
    [baseQuery.data, otherQuery.data],
  );

  if (!base || !other) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pb-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="pb-dialog fixed left-1/2 top-1/2 z-50 flex h-[85vh] w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/50 focus:outline-none">
          {/* Header */}
          <div className="flex items-center gap-4 border-b border-line px-5 py-3">
            <VersionMeta version={base} side="left" />
            <div className="flex shrink-0 flex-col items-center gap-1">
              <Dialog.Title className="text-sm font-semibold text-ink">
                {base.displayLabel} ↔ {other.displayLabel}
              </Dialog.Title>
              {diff && (
                <span className="flex items-center gap-2 text-[11px] tabular-nums">
                  <span className="flex items-center gap-0.5 text-success">
                    <Plus size={11} />
                    {diff.addedCount}
                  </span>
                  <span className="flex items-center gap-0.5 text-danger">
                    <Minus size={11} />
                    {diff.removedCount}
                  </span>
                </span>
              )}
            </div>
            <VersionMeta version={other} side="right" />
            <div className="flex shrink-0 items-center gap-2">
              <div className="flex rounded-md border border-line p-0.5">
                {(
                  [
                    { value: "split", label: "Side by side", icon: <Columns2 size={12} /> },
                    { value: "unified", label: "Unified", icon: <Rows3 size={12} /> },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setMode(option.value)}
                    className={cx(
                      "flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors",
                      mode === option.value
                        ? "bg-accent-soft text-accent"
                        : "text-ink-dim hover:text-ink",
                    )}
                  >
                    {option.icon}
                    {option.label}
                  </button>
                ))}
              </div>
              <Dialog.Close
                aria-label="Close"
                className="rounded-md p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
              >
                <X size={15} />
              </Dialog.Close>
            </div>
          </div>

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-y-auto px-0 py-2 font-mono text-[12px]">
            {!diff ? (
              <Spinner />
            ) : diff.rows.length === 0 ? (
              <p className="px-5 py-8 text-center font-sans text-[12px] text-ink-faint">
                Both versions are empty.
              </p>
            ) : mode === "split" ? (
              <div className="grid grid-cols-[3rem_minmax(0,1fr)_3rem_minmax(0,1fr)]">
                {diff.rows.map((row, i) => (
                  <div key={i} className="contents">
                    <span
                      className={cx(
                        "select-none px-2 text-right tabular-nums",
                        LINE_HEIGHT,
                        row.left ? gutterClass(row.left.type) : "bg-app/40",
                      )}
                    >
                      {row.left?.lineNumber ?? ""}
                    </span>
                    <span
                      className={cx(
                        "whitespace-pre-wrap break-words px-3",
                        LINE_HEIGHT,
                        row.left ? lineClass(row.left.type) : "bg-app/40",
                      )}
                    >
                      {row.left?.text ?? ""}
                    </span>
                    <span
                      className={cx(
                        "select-none px-2 text-right tabular-nums",
                        LINE_HEIGHT,
                        row.right ? gutterClass(row.right.type) : "bg-app/40",
                      )}
                    >
                      {row.right?.lineNumber ?? ""}
                    </span>
                    <span
                      className={cx(
                        "whitespace-pre-wrap break-words px-3",
                        LINE_HEIGHT,
                        row.right ? lineClass(row.right.type) : "bg-app/40",
                      )}
                    >
                      {row.right?.text ?? ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-[3rem_minmax(0,1fr)]">
                {diff.unified.map((line, i) => (
                  <div key={i} className="contents">
                    <span
                      className={cx("select-none px-2 text-right tabular-nums", LINE_HEIGHT, gutterClass(line.type))}
                    >
                      {line.lineNumber ?? ""}
                    </span>
                    <span className={cx("whitespace-pre-wrap break-words px-3", LINE_HEIGHT, lineClass(line.type))}>
                      {line.type === "added" ? "+ " : line.type === "removed" ? "- " : "  "}
                      {line.text}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
