import { useEffect, useState } from "react";
import { History } from "lucide-react";
import type { PromptDetail, VersionDto } from "../../../shared/ipc.js";
import { useAppMutation, useVersionRatingSummaries } from "../hooks/use-data";
import { useAppState } from "../state/app-state";
import { ConfirmDialog } from "./dialogs";
import { EmptyState } from "./ui";
import { HistoryCompareBar } from "./HistoryCompareBar";
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
  const [confirmVersion, setConfirmVersion] = useState<VersionDto | null>(null);
  const [compareSelection, setCompareSelection] = useState<string[]>([]);
  const { data: ratingsByVersion } = useVersionRatingSummaries(prompt.id);

  useEffect(() => {
    const liveIds = new Set(versions.map((version) => version.id));
    setConfirmVersion((target) => (target && liveIds.has(target.id) ? target : null));
    setCompareSelection((selection) => selection.filter((id) => liveIds.has(id)));
  }, [versions]);

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
      <HistoryListView
        currentVersionId={prompt.currentVersionId}
        versions={versions}
        viewingVersionId={viewingVersionId}
        compareSelection={compareSelection}
        ratingsByVersion={ratingsByVersion}
        onToggleCompare={toggleCompare}
        actions={actions}
      />

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
