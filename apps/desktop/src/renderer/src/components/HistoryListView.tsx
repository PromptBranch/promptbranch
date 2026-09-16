import { GitBranch, Star } from "lucide-react";
import type { RatingSummaryDto, VersionDto } from "../../../shared/ipc.js";
import { relativeTime } from "../lib/time";
import { cx } from "../lib/time";
import { HistoryVersionActions, type HistoryVersionActionHandlers } from "./HistoryVersionActions";

export function HistoryListView({
  currentVersionId,
  versions,
  viewingVersionId,
  compareSelection,
  ratingsByVersion,
  onToggleCompare,
  actions,
}: {
  currentVersionId: string | null;
  versions: VersionDto[];
  viewingVersionId: string | null;
  compareSelection: string[];
  ratingsByVersion: Record<string, RatingSummaryDto> | undefined;
  onToggleCompare(versionId: string): void;
  actions: HistoryVersionActionHandlers;
}) {
  const branchNames: string[] = [];
  const byBranch = new Map<string, VersionDto[]>();
  for (const version of versions) {
    if (!byBranch.has(version.branchName)) {
      byBranch.set(version.branchName, []);
      branchNames.push(version.branchName);
    }
    byBranch.get(version.branchName)!.push(version);
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {branchNames.map((branchName) => {
        const branchVersions = [...(byBranch.get(branchName) ?? [])].sort((a, b) => b.number - a.number);
        return (
          <div key={branchName} className="mb-6">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              <GitBranch size={12} />
              {branchName}
            </div>
            <div className="space-y-1.5 border-l border-line pl-4">
              {branchVersions.map((version) => {
                const isCurrent = version.id === currentVersionId;
                const isViewing = viewingVersionId === version.id;
                const isSelected = compareSelection.includes(version.id);
                const rating = ratingsByVersion?.[version.id];
                return (
                  <div
                    key={version.id}
                    className={cx(
                      "group relative rounded-lg border p-3 transition-colors",
                      isCurrent ? "border-accent/40 bg-accent-soft/40" : "border-line bg-panel hover:border-line-strong",
                      isViewing && "ring-1 ring-accent/40",
                      isSelected && "border-accent/60",
                    )}
                  >
                    <div className="absolute -left-[21px] top-4 h-2 w-2 rounded-full border-2 border-app bg-ink-faint" />
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggleCompare(version.id)}
                          title="Select to compare"
                          aria-label={`Select ${version.displayLabel} to compare`}
                          className="shrink-0 accent-accent"
                        />
                        <span className="text-[13px] font-semibold text-ink">{version.displayLabel}</span>
                        {isCurrent && (
                          <span className="rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-medium text-accent">
                            Current
                          </span>
                        )}
                        <span className="text-[11px] text-ink-faint">{relativeTime(version.createdAt)}</span>
                      </div>
                      <HistoryVersionActions version={version} isCurrent={isCurrent} {...actions} />
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">
                      {version.changeNote ?? <span className="italic text-ink-faint">No change note</span>}
                    </p>
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-faint">
                      {rating && rating.overall !== null ? (
                        <>
                          <Star size={10} className="text-star" fill="currentColor" />
                          <span className="tabular-nums text-ink-dim">{rating.overall.toFixed(1)} avg</span>
                          <span>· {rating.count} rating{rating.count > 1 ? "s" : ""}</span>
                        </>
                      ) : (
                        "Not rated"
                      )}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
