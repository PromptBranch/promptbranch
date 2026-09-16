import { Copy, Eye, GitFork, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { VersionDto } from "../../../shared/ipc.js";

export interface HistoryVersionActionHandlers {
  onView(versionId: string): void;
  onSetCurrent(version: VersionDto): void;
  onDuplicate(version: VersionDto): void;
  onDuplicateAsPrompt(version: VersionDto): void;
  onRename(version: VersionDto): void;
  onDelete(version: VersionDto): void;
}

export function HistoryVersionActions({
  version,
  isCurrent,
  alwaysVisible = false,
  onView,
  onSetCurrent,
  onDuplicate,
  onDuplicateAsPrompt,
  onRename,
  onDelete,
}: HistoryVersionActionHandlers & { version: VersionDto; isCurrent: boolean; alwaysVisible?: boolean }) {
  return (
    <div
      className={
        alwaysVisible
          ? "flex min-w-0 flex-wrap items-center gap-1"
          : "items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
      }
      style={{
        display: "flex",
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
        flexWrap: "wrap",
      }}
    >
      <button
        type="button"
        onClick={() => onView(version.id)}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Eye size={12} />
        View
      </button>
      {!isCurrent && (
        <button
          type="button"
          onClick={() => onSetCurrent(version)}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <RotateCcw size={12} />
          Set as current
        </button>
      )}
      <button
        type="button"
        onClick={() => onDuplicate(version)}
        aria-label={`Duplicate ${version.displayLabel} as variation`}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <GitFork size={12} />
        Variation
      </button>
      <button
        type="button"
        onClick={() => onDuplicateAsPrompt(version)}
        aria-label={`Duplicate ${version.displayLabel} as new prompt`}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Copy size={12} />
        New prompt
      </button>
      <button
        type="button"
        onClick={() => onRename(version)}
        aria-label={`Rename ${version.displayLabel}`}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Pencil size={12} />
        Rename
      </button>
      {!isCurrent && (
        <button
          type="button"
          onClick={() => onDelete(version)}
          aria-label={`Delete ${version.displayLabel}`}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-danger transition-colors hover:bg-danger-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-danger"
        >
          <Trash2 size={12} />
          Delete
        </button>
      )}
    </div>
  );
}
