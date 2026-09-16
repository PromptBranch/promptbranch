import { useEffect, useState } from "react";
import { History } from "lucide-react";
import type { PromptDetail, VersionDto } from "../../../shared/ipc.js";
import { useAppMutation, useVersionRatingSummaries } from "../hooks/use-data";
import { usePref } from "../lib/prefs";
import { useAppState } from "../state/app-state";
import { ConfirmDialog } from "./dialogs";
import { EmptyState } from "./ui";
import { HistoryCompareBar } from "./HistoryCompareBar";
import { HistoryGraphView } from "./HistoryGraphView";
import { HistoryListView } from "./HistoryListView";
import type { HistoryVersionActionHandlers } from "./HistoryVersionActions";

export function HistoryTab({
  prompt,
  versions,
  onView,
  onCompare,
  onDuplicate,
  onDuplicateAsPrompt,
  onRename,
  onDelete,
}: {
  prompt: PromptDetail;
  versions: VersionDto[];
  onView: (versionId: string) => void;
  onCompare: (base: VersionDto, other: VersionDto) => void;
  onDuplicate: (version: VersionDto) => void;
  onDuplicateAsPrompt: (version: VersionDto) => void;
  onRename: (version: VersionDto) => void;
  onDelete: (version: VersionDto) => void;
}) {
  const { viewingVersionId } = useAppState();
  const [historyView, setHistoryView] = usePref("prompt-history-view");
  const [confirmVersion, setConfirmVersion] = useState<VersionDto | null>(null);
  const [compareSelection, setCompareSelection] = useState<string[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const { data: ratingsByVersion } = useVersionRatingSummaries(prompt.id);

  useEffect(() => {
    const liveIds = new Set(versions.map((version) => version.id));
    setConfirmVersion((target) => (target && liveIds.has(target.id) ? target : null));
    setCompareSelection((selection) => selection.filter((id) => liveIds.has(id)));
    setSelectedVersionId((selected) => (selected && liveIds.has(selected) ? selected : null));
  }, [versions]);

  useEffect(() => {
    if (historyView !== "graph") return;
    const liveIds = new Set(versions.map((version) => version.id));
    setSelectedVersionId((selected) => {
      if (selected && liveIds.has(selected)) return selected;
      const fallback = [viewingVersionId, prompt.currentVersionId, versions.at(-1)?.id].find(
        (id): id is string => id !== null && id !== undefined && liveIds.has(id),
      );
      return fallback ?? null;
    });
  }, [historyView, prompt.currentVersionId, versions, viewingVersionId]);

  const setCurrent = useAppMutation(
    (versionId: string) => window.promptBuilder.versions.setCurrent(prompt.id, versionId),
    { toast: "Version restored as current" },
  );

  const toggleCompare = (versionId: string) => {
    setCompareSelection((current) =>
      current.includes(versionId)
        ? current.filter((id) => id !== versionId)
        : [...current.slice(-1), versionId],
    );
  };

  const selectedVersions = compareSelection
    .map((id) => versions.find((version) => version.id === id))
    .filter((version): version is VersionDto => version !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const compareBase = selectedVersions[0] ?? null;
  const compareOther = selectedVersions[1] ?? null;

  const actions: HistoryVersionActionHandlers = {
    onView,
    onSetCurrent: setConfirmVersion,
    onDuplicate,
    onDuplicateAsPrompt,
    onRename,
    onDelete,
  };

  if (versions.length === 0) {
    return <EmptyState icon={<History size={16} />} title="No versions yet" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-2">
        <span className="text-[11px] font-medium text-ink-faint">History view</span>
        <div
          role="group"
          aria-label="History view"
          className="flex items-center rounded-md border border-line bg-panel p-0.5"
        >
          {(["list", "graph"] as const).map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={historyView === view}
              onClick={() => setHistoryView(view)}
              className="rounded px-2.5 py-1 text-[11px] font-medium capitalize text-ink-dim transition-colors hover:bg-hover hover:text-ink aria-pressed:bg-accent-soft aria-pressed:text-accent"
            >
              {view === "list" ? "List" : "Graph"}
            </button>
          ))}
        </div>
      </div>

      {historyView === "graph" ? (
        <HistoryGraphView
          prompt={prompt}
          versions={versions}
          ratingsByVersion={ratingsByVersion}
          viewingVersionId={viewingVersionId}
          selectedVersionId={selectedVersionId}
          compareSelection={compareSelection}
          onSelect={setSelectedVersionId}
          onToggleCompare={toggleCompare}
          actions={actions}
        />
      ) : (
        <HistoryListView
          currentVersionId={prompt.currentVersionId}
          versions={versions}
          viewingVersionId={viewingVersionId}
          compareSelection={compareSelection}
          ratingsByVersion={ratingsByVersion}
          onToggleCompare={toggleCompare}
          actions={actions}
        />
      )}

      <HistoryCompareBar
        base={compareBase}
        other={compareOther}
        onClear={() => setCompareSelection([])}
        onCompare={onCompare}
      />

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
