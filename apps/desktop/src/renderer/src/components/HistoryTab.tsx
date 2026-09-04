import { useState } from "react";
import { Copy, Eye, GitBranch, GitCompare, GitFork, History, Pencil, RotateCcw, Star } from "lucide-react";
import type { PromptDetail, VersionDto } from "../../../shared/ipc.js";
import { useAppMutation, useVersionRatingSummaries } from "../hooks/use-data";
import { cx, relativeTime } from "../lib/time";
import { useAppState } from "../state/app-state";
import { ConfirmDialog } from "./dialogs";
import { EmptyState } from "./ui";

export function HistoryTab({
  prompt,
  versions,
  onView,
  onCompare,
  onDuplicate,
  onDuplicateAsPrompt,
  onRename,
}: {
  prompt: PromptDetail;
  versions: VersionDto[];
  onView: (versionId: string) => void;
  onCompare: (base: VersionDto, other: VersionDto) => void;
  onDuplicate: (version: VersionDto) => void;
  onDuplicateAsPrompt: (version: VersionDto) => void;
  onRename: (version: VersionDto) => void;
}) {
  const { viewingVersionId } = useAppState();
  const [confirmVersion, setConfirmVersion] = useState<VersionDto | null>(null);
  const [compareSelection, setCompareSelection] = useState<string[]>([]);
  const { data: ratingsByVersion } = useVersionRatingSummaries(prompt.id);

  const setCurrent = useAppMutation(
    (versionId: string) => window.promptBuilder.versions.setCurrent(prompt.id, versionId),
    { toast: "Version restored as current" },
  );

  // Group by branch, branches in order of first appearance; versions newest first.
  const branchNames: string[] = [];
  const byBranch = new Map<string, VersionDto[]>();
  for (const version of versions) {
    if (!byBranch.has(version.branchName)) {
      byBranch.set(version.branchName, []);
      branchNames.push(version.branchName);
    }
    byBranch.get(version.branchName)!.push(version);
  }

  const toggleCompare = (versionId: string) => {
    setCompareSelection((current) =>
      current.includes(versionId)
        ? current.filter((id) => id !== versionId)
        : [...current.slice(-1), versionId],
    );
  };

  const selectedVersions = compareSelection
    .map((id) => versions.find((v) => v.id === id))
    .filter((v): v is VersionDto => v !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const compareBase = selectedVersions[0] ?? null;
  const compareOther = selectedVersions[1] ?? null;

  if (versions.length === 0) {
    return <EmptyState icon={<History size={16} />} title="No versions yet" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
                  const isCurrent = version.id === prompt.currentVersionId;
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
                            onChange={() => toggleCompare(version.id)}
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
                        <div className="flex shrink-0 flex-wrap items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={() => onView(version.id)}
                            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                          >
                            <Eye size={12} />
                            View
                          </button>
                          {!isCurrent && (
                            <button
                              type="button"
                              onClick={() => setConfirmVersion(version)}
                              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                            >
                              <RotateCcw size={12} />
                              Set as current
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onDuplicate(version)}
                            aria-label={`Duplicate ${version.displayLabel} as variation`}
                            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                          >
                            <GitFork size={12} />
                            Variation
                          </button>
                          <button
                            type="button"
                            onClick={() => onDuplicateAsPrompt(version)}
                            aria-label={`Duplicate ${version.displayLabel} as new prompt`}
                            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                          >
                            <Copy size={12} />
                            New prompt
                          </button>
                          <button
                            type="button"
                            onClick={() => onRename(version)}
                            aria-label={`Rename ${version.displayLabel}`}
                            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                          >
                            <Pencil size={12} />
                            Rename
                          </button>
                        </div>
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

      {/* Compare bar */}
      {compareSelection.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-line bg-panel px-5 py-2.5">
          <span className="min-w-0 text-[12px] text-ink-dim">
            {compareOther
              ? `${compareBase!.displayLabel} ↔ ${compareOther.displayLabel} selected`
              : `${compareBase!.displayLabel} selected — pick one more version to compare`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCompareSelection([])}
              className="rounded-md px-2.5 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={!compareBase || !compareOther}
              onClick={() => {
                if (compareBase && compareOther) onCompare(compareBase, compareOther);
              }}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              <GitCompare size={12} />
              Compare {compareBase?.displayLabel ?? ""} ↔ {compareOther?.displayLabel ?? "?"}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmVersion !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmVersion(null);
        }}
        title={`Restore ${confirmVersion?.displayLabel ?? ""} as current?`}
        description="The current pointer moves to this version. No history is lost — you can switch back at any time."
        confirmLabel="Set as current"
        onConfirm={() => {
          if (confirmVersion) setCurrent.mutate(confirmVersion.id);
          setConfirmVersion(null);
        }}
      />
    </div>
  );
}
