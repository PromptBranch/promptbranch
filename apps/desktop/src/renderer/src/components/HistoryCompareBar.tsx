import { GitCompare } from "lucide-react";
import type { VersionDto } from "../../../shared/ipc.js";

export function HistoryCompareBar({
  base,
  other,
  onClear,
  onCompare,
}: {
  base: VersionDto | null;
  other: VersionDto | null;
  onClear(): void;
  onCompare(base: VersionDto, other: VersionDto): void;
}) {
  if (!base) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-line bg-panel px-5 py-2.5">
      <span className="min-w-0 text-[12px] text-ink-dim">
        {other
          ? `${base.displayLabel} ↔ ${other.displayLabel} selected`
          : `${base.displayLabel} selected — pick one more version to compare`}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClear}
          className="rounded-md px-2.5 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
        >
          Clear
        </button>
        <button
          type="button"
          disabled={!other}
          onClick={() => {
            if (other) onCompare(base, other);
          }}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
        >
          <GitCompare size={12} />
          Compare {base.displayLabel} ↔ {other?.displayLabel ?? "?"}
        </button>
      </div>
    </div>
  );
}
