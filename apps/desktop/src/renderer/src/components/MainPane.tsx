import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tabs from "@radix-ui/react-tabs";
import { useQueryClient } from "@tanstack/react-query";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  FileText,
  FolderInput,
  GitFork,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCcw,
  Share2,
  Star,
  Trash2,
} from "lucide-react";
import type { PromptDetail, VersionDto } from "../../../shared/ipc.js";
import { aiRunProgressEventSchema } from "../../../shared/ipc.js";
import { useAppMutation, useNotes, useRunGroups, useRuns, useVersionContent, useVersions } from "../hooks/use-data";
import {
  extractVariableNames,
  getRunModelSelection,
  getRunVariables,
  setRunModelSelection,
  setRunVariables,
  type ModelRef,
} from "../lib/ai-prefs";
import { togglePanel } from "../lib/panels";
import { cx } from "../lib/time";
import { useToast } from "../lib/toast";
import { useAppState } from "../state/app-state";
import { CompareDialog } from "./CompareDialog";
import { ConfirmDialog, DuplicateBranchDialog, NameDialog, RateDialog, type RatingScores } from "./dialogs";
import { EditorTab } from "./EditorTab";
import { HistoryTab } from "./HistoryTab";
import { Inspector } from "./Inspector";
import { NotesTab } from "./NotesTab";
import { ResultsTab } from "./ResultsTab";
import { fromRunResult, fromStoredGroup, placeholderGroup, RunCompareView, type CompareGroup, type CompareRun } from "./RunCompareView";
import { ShareDialog } from "./ShareDialog";
import { ModelPicker, modelRefKey, useAvailableModels } from "./model-picker";
import { MoveToCollectionDialog } from "./MoveToCollectionDialog";
import { RunVariablesDialog } from "./run-controls";
import { TagEditor } from "./TagEditor";
import { EmptyState, Spinner } from "./ui";

function MenuItem({
  icon,
  label,
  danger,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cx(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] outline-none",
        danger
          ? "text-danger data-[highlighted]:bg-danger-soft"
          : "text-ink-dim data-[highlighted]:bg-hover data-[highlighted]:text-ink",
      )}
    >
      {icon}
      {label}
    </DropdownMenu.Item>
  );
}

function VersionDropdown({
  prompt,
  versions,
  viewingVersion,
  onDuplicate,
}: {
  prompt: PromptDetail;
  versions: VersionDto[];
  viewingVersion: VersionDto | null;
  onDuplicate: (version: VersionDto) => void;
}) {
  const { setViewingVersionId } = useAppState();
  const current = versions.find((v) => v.id === prompt.currentVersionId) ?? null;
  const shown = viewingVersion ?? current;

  // Group by branch, preserving order of first appearance.
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
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex min-w-0 max-w-36 items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px] text-ink transition-colors hover:border-line-strong @max-lg:max-w-28 @max-md:max-w-20"
        >
          <span className="min-w-0 truncate tabular-nums">
            {shown ? shown.displayLabel : "—"}
            {shown && shown.id === prompt.currentVersionId && (
              <span className="ml-1 text-ink-faint">(Current)</span>
            )}
          </span>
          <ChevronDown size={12} className="shrink-0 text-ink-faint" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="pb-menu z-50 max-h-80 w-60 overflow-y-auto rounded-lg border border-line-strong bg-raised p-1 shadow-xl shadow-black/40"
        >
          {branchNames.map((branchName) => (
            <DropdownMenu.Group key={branchName}>
              {branchNames.length > 1 && (
                <DropdownMenu.Label className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                  {branchName}
                </DropdownMenu.Label>
              )}
              {[...(byBranch.get(branchName) ?? [])]
                .sort((a, b) => b.number - a.number)
                .map((version) => (
                  <DropdownMenu.Item
                    key={version.id}
                    onSelect={() => setViewingVersionId(version.id === prompt.currentVersionId ? null : version.id)}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[12px] text-ink-dim outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
                  >
                    <span className="min-w-0 truncate">
                      {version.displayLabel}
                      {version.id === prompt.currentVersionId && (
                        <span className="ml-1 text-ink-faint">(Current)</span>
                      )}
                    </span>
                    {version.id === (shown?.id ?? prompt.currentVersionId) && (
                      <Check size={12} className="shrink-0 text-accent" />
                    )}
                  </DropdownMenu.Item>
                ))}
            </DropdownMenu.Group>
          ))}
          {shown && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item
                onSelect={() => onDuplicate(shown)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-ink-dim outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
              >
                <GitFork size={12} />
                Duplicate {shown.displayLabel} as variation…
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MainPane({ prompt }: { prompt: PromptDetail }) {
  const { viewingVersionId, setViewingVersionId, selectPrompt, openSettings } = useAppState();
  const { data: versions } = useVersions(prompt.id);
  const { data: notes } = useNotes(prompt.id);
  const { data: runs } = useRuns(prompt.id);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("prompt");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameVersionTarget, setRenameVersionTarget] = useState<VersionDto | null>(null);
  const [deleteVersionTarget, setDeleteVersionTarget] = useState<VersionDto | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [hardDeleteOpen, setHardDeleteOpen] = useState(false);
  const [rateTarget, setRateTarget] = useState<{ type: "prompt" } | { type: "version"; version: VersionDto } | null>(null);
  const [comparePair, setComparePair] = useState<{ base: VersionDto; other: VersionDto } | null>(null);
  const [duplicateSource, setDuplicateSource] = useState<VersionDto | null>(null);
  const [duplicatePromptSource, setDuplicatePromptSource] = useState<VersionDto | null>(null);

  useEffect(() => {
    setActiveTab("prompt");
  }, [prompt.id]);

  const versionList = versions ?? [];
  useEffect(() => {
    if (!versions) return;
    const liveIds = new Set(versions.map((version) => version.id));
    const keepVersion = (target: VersionDto | null) =>
      target !== null && liveIds.has(target.id) ? target : null;
    setRenameVersionTarget(keepVersion);
    setDeleteVersionTarget(keepVersion);
    setDuplicateSource(keepVersion);
    setDuplicatePromptSource(keepVersion);
    setRateTarget((target) =>
      target?.type === "version" && !liveIds.has(target.version.id) ? null : target,
    );
    setComparePair((pair) =>
      pair && liveIds.has(pair.base.id) && liveIds.has(pair.other.id) ? pair : null,
    );
  }, [versions]);
  const viewingVersion =
    (viewingVersionId ? versionList.find((v) => v.id === viewingVersionId) : null) ??
    versionList.find((v) => v.id === prompt.currentVersionId) ??
    null;
  const isViewingCurrent = viewingVersion !== null && viewingVersion.id === prompt.currentVersionId;

  const { data: versionContent } = useVersionContent(viewingVersion?.id ?? null);

  // ------------------------------------------------------------- AI run flow
  const liveContentRef = useRef<string | null>(null);
  const availableModels = useAvailableModels();
  const { data: runGroups } = useRunGroups(prompt.id);
  const [modelSelection, setModelSelection] = useState<ModelRef[]>(
    () => getRunModelSelection(prompt.id) ?? [],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [variableNames, setVariableNames] = useState<string[]>([]);
  // Captured when the variables dialog opens — a stable prop, so focus
  // refetches no longer reset values already typed into the dialog.
  const [variableInitialValues, setVariableInitialValues] = useState<Record<string, string>>({});
  const [pendingRefs, setPendingRefs] = useState<ModelRef[]>([]);
  const [compare, setCompare] = useState<
    { kind: "fresh"; group: CompareGroup } | { kind: "history"; runGroupId: string } | null
  >(null);
  // The in-flight run, shown live in the compare view: placeholder columns
  // created when the run starts, updated by ai:run-progress events until
  // the final DTO (kind "fresh") replaces them. runGroupId is adopted from
  // the first event — the per-model "queued" event, emitted at request time,
  // so Cancel works before the first token (the ai:run invoke resolves only
  // at the end). Closing the view mid-run only dismisses it — tracking
  // continues so the Run button keeps showing "Running n/m…"; completion
  // reopens the settled view unless another group was opened meanwhile.
  const [live, setLive] = useState<{
    group: CompareGroup;
    cancelling: boolean;
    dismissed: boolean;
  } | null>(null);

  useEffect(() => {
    setModelSelection(getRunModelSelection(prompt.id) ?? []);
    setCompare(null);
    // Mid-run prompt switch (F13): the run keeps going in the background —
    // the live view is dropped and the completion toast reroutes instead.
    setLive(null);
  }, [prompt.id]);

  // Live progress side channel. Zod-parsed here (defense in depth — the
  // sandboxed preload forwards the raw payload). Events for other groups
  // (e.g. late events of a finished run) are ignored.
  useEffect(() => {
    return window.promptBuilder.ai.onRunProgress((raw) => {
      const parsed = aiRunProgressEventSchema.safeParse(raw);
      if (!parsed.success) return;
      const event = parsed.data;
      setLive((current) => {
        if (!current) return current;
        // NOTE: while runGroupId is still "" (before the first queued event),
        // any group's events would be adopted — accepted as a known narrow
        // window (queued events arrive at request time).
        if (current.group.runGroupId !== "" && current.group.runGroupId !== event.runGroupId) return current;
        const runs = current.group.runs.map((run): CompareRun => {
          if (run.providerId !== event.providerId || run.modelId !== event.modelId) return run;
          switch (event.phase) {
            case "queued":
              // Carries the runGroupId at request time (Cancel works before
              // the first token); the row stays pending until "started".
              return run;
            case "started":
              return { ...run, status: "streaming" };
            case "delta":
              return { ...run, status: "streaming", partial: event.text ?? run.partial };
            case "completed":
              return {
                ...run,
                status: "completed",
                output: event.text ?? run.partial,
                partial: event.text ?? run.partial,
                latencyMs: event.latencyMs ?? null,
                usage: event.usage ?? null,
                costUsd: event.costUsd ?? null,
              };
            case "error":
              return {
                ...run,
                status: "error",
                error: event.error ?? "Run failed",
                partial: event.text ?? run.partial,
              };
          }
        });
        return { ...current, group: { ...current.group, runGroupId: event.runGroupId, runs } };
      });
    });
  }, []);

  // Which prompt the in-flight run was started on — a mid-run switch must not
  // pop the compare dialog on an unrelated prompt.
  const runStartRef = useRef<{ promptId: string; title: string } | null>(null);

  const runModels = useAppMutation(
    (input: { refs: ModelRef[]; variables: Record<string, string> }) => {
      runStartRef.current = { promptId: prompt.id, title: prompt.title };
      return window.promptBuilder.ai.run({
        promptId: prompt.id,
        ...(viewingVersion ? { versionId: viewingVersion.id } : {}),
        content: liveContentRef.current ?? prompt.draftContent ?? versionContent?.content ?? "",
        variables: input.variables,
        modelRefs: input.refs,
      });
    },
    {
      toast: (group) => {
        const started = runStartRef.current;
        if (started && started.promptId !== prompt.id) {
          return `Run finished for "${started.title}" — open it from Results`;
        }
        const summary = `Run complete — ${group.runs.filter((r) => r.status === "completed").length}/${group.runs.length} succeeded`;
        // Another group was opened while this run was dismissed — the toast
        // reroutes instead of hijacking the open view.
        return compare !== null ? `${summary} — open it from Results` : summary;
      },
      onSuccess: (group) => {
        const started = runStartRef.current;
        setLive(null);
        if (started && started.promptId !== prompt.id) return;
        // The user explicitly opened another group while this run was in
        // flight (dismissed live view) — don't clobber it with the result.
        if (compare !== null) return;
        setCompare({ kind: "fresh", group: fromRunResult(group) });
      },
      onError: () => setLive(null),
    },
  );

  const cancelRun = useAppMutation(
    (runGroupId: string) => window.promptBuilder.ai.runCancel({ runGroupId }),
    {
      toast: (result) => (result.cancelled ? "Run cancelled" : "Run already finished"),
      // Both failure and "already finished" must release the Cancelling… state.
      onSuccess: (result) => {
        if (!result.cancelled) {
          setLive((current) => (current ? { ...current, cancelling: false } : current));
        }
      },
      onError: () => setLive((current) => (current ? { ...current, cancelling: false } : current)),
    },
  );

  /**
   * Starts a run: opens the compare view immediately with placeholder
   * columns, then fires the ai:run invoke (resolves when ALL models settle;
   * live progress arrives via events meanwhile).
   */
  const beginRun = (refs: ModelRef[], variables: Record<string, string>) => {
    const withNames = refs.map((ref) => ({
      ...ref,
      providerName:
        availableModels.find((m) => modelRefKey(m) === modelRefKey(ref))?.providerName ?? ref.providerId,
    }));
    setCompare(null);
    setLive({
      group: placeholderGroup(withNames, viewingVersion?.id ?? ""),
      cancelling: false,
      dismissed: false,
    });
    runModels.mutate({ refs, variables });
  };

  /**
   * Runs the current (possibly unsaved) content against the given models.
   * With `skipVariables`, reuses the last variable values (rerun path);
   * otherwise {{variables}} in the content open the variables dialog first.
   */
  const startRun = (refs: ModelRef[], skipVariables = false) => {
    if (availableModels.length === 0) {
      toast("No models available — connect a provider first", "error");
      openSettings("ai");
      return;
    }
    const valid = refs.filter((ref) => availableModels.some((m) => modelRefKey(m) === modelRefKey(ref)));
    if (valid.length === 0) {
      setPickerOpen(true);
      return;
    }
    setModelSelection(valid);
    setRunModelSelection(prompt.id, valid);
    const content = liveContentRef.current ?? prompt.draftContent ?? versionContent?.content ?? "";
    const names = extractVariableNames(content);
    if (!skipVariables && names.length > 0) {
      setPendingRefs(valid);
      setVariableNames(names);
      setVariableInitialValues(getRunVariables(prompt.id));
      setVariablesOpen(true);
      return;
    }
    beginRun(valid, getRunVariables(prompt.id));
  };

  // Memoized: a fresh object every render would reset RunCompareView's
  // local star-rating state via its group-sync effect.
  const compareGroup: CompareGroup | null = useMemo(() => {
    if (compare === null) return null;
    if (compare.kind === "fresh") return compare.group;
    const stored = runGroups?.find((g) => g.runGroupId === compare.runGroupId);
    return stored ? fromStoredGroup(stored) : null;
  }, [compare, runGroups]);
  // An explicitly opened group (fresh result or history) takes precedence
  // over the in-flight live view; the final DTO (kind "fresh") replaces the
  // live group only when nothing else was opened meanwhile.
  const activeGroup = compareGroup ?? live?.group ?? null;
  const compareVersionLabel =
    (activeGroup && versionList.find((v) => v.id === activeGroup.versionId)?.displayLabel) ?? null;
  // "Running n/m…" on the Run button, derived from progress events.
  const liveSettled = live?.group.runs.filter((r) => r.status === "completed" || r.status === "error").length ?? 0;
  const runLabel = runModels.isPending
    ? live !== null
      ? `Running ${liveSettled}/${live.group.runs.length}…`
      : "Running…"
    : "Run";

  const setStarred = useAppMutation(
    (starred: boolean) => window.promptBuilder.prompts.setStarred(prompt.id, starred),
    { quiet: true },
  );
  const rename = useAppMutation(
    (title: string) => window.promptBuilder.prompts.update(prompt.id, { title }),
    { toast: "Prompt renamed" },
  );
  const renameVersion = useAppMutation(
    ({ versionId, label }: { versionId: string; label: string | null }) =>
      window.promptBuilder.versions.updateLabel(versionId, label),
    { toast: "Version renamed" },
  );
  const deleteVersion = useAppMutation(
    (versionId: string) => window.promptBuilder.versions.delete(versionId),
    {
      toast: "Version deleted",
      onSuccess: (_result, versionId) => {
        if (viewingVersionId === versionId) setViewingVersionId(null);
      },
    },
  );
  const duplicatePrompt = useAppMutation(
    ({ versionId, title }: { versionId: string; title: string }) =>
      window.promptBuilder.prompts.duplicate({ promptId: prompt.id, versionId, title }),
    {
      toast: "Prompt duplicated",
      onSuccess: (created) => selectPrompt(created.id),
    },
  );
  const updateDescription = useAppMutation(
    (description: string) => window.promptBuilder.prompts.update(prompt.id, { description }),
    { toast: "Description updated" },
  );
  const softDelete = useAppMutation(() => window.promptBuilder.prompts.softDelete(prompt.id), {
    toast: "Moved to Trash",
    onSuccess: () => selectPrompt(null),
  });
  const restore = useAppMutation(() => window.promptBuilder.prompts.restore(prompt.id), {
    toast: "Prompt restored",
  });
  const hardDelete = useAppMutation(() => window.promptBuilder.prompts.hardDelete(prompt.id), {
    toast: "Prompt permanently deleted",
    onSuccess: () => selectPrompt(null),
  });
  const setCurrent = useAppMutation(
    () => window.promptBuilder.versions.setCurrent(prompt.id, viewingVersion!.id),
    {
      toast: "Version restored as current",
      onSuccess: () => setViewingVersionId(null),
    },
  );
  const exportPrompt = useAppMutation(() => window.promptBuilder.prompts.exportJson(prompt.id), {
    toast: (r) => (r.canceled ? "Export canceled" : `Exported to ${r.path}`),
  });
  const rate = useAppMutation(
    (input: { targetType: "prompt" | "version"; targetId: string; scores: RatingScores }) =>
      window.promptBuilder.ratings.add({ targetType: input.targetType, targetId: input.targetId, ...input.scores }),
    { toast: "Rating saved" },
  );

  // "Duplicate as variation": branch from the source version, make the new
  // branch head current so it is immediately editable, then switch to it.
  const duplicateAsVariation = async (name: string, description: string) => {
    const source = duplicateSource;
    if (!source) return;
    const result = await window.promptBuilder.branches.create({
      promptId: prompt.id,
      name,
      fromVersionId: source.id,
      ...(description ? { description } : {}),
    });
    await window.promptBuilder.versions.setCurrent(prompt.id, result.version.id);
    await queryClient.invalidateQueries();
    toast(`Variation "${name}" created`);
    setViewingVersionId(null);
    setActiveTab("prompt");
  };

  const inTrash = prompt.deletedAt !== null;

  // Editor | inspector split: resizable via drag separator, collapsible.
  const inspectorRef = usePanelRef();
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const mainLayout = useDefaultLayout({ id: "promptbuilder-main", storage: localStorage });
  // First run only (no persisted layout): on narrow windows, start with the
  // inspector collapsed. The collapse itself is then persisted and respected.
  useEffect(() => {
    if (mainLayout.defaultLayout === undefined && window.innerWidth < 1150) {
      inspectorRef.current?.collapse();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Stable callbacks: the memoized Inspector (and EditorTab above) must not
  // re-render on each streamed run delta — inline arrows would defeat memo.
  const toggleInspector = useCallback(() => {
    togglePanel(inspectorRef.current, setInspectorCollapsed);
  }, [inspectorRef]);
  const rateVersion = useCallback((version: VersionDto) => setRateTarget({ type: "version", version }), []);
  const compareVersions = useCallback(
    (base: VersionDto, other: VersionDto) => setComparePair({ base, other }),
    [],
  );
  const openRunGroup = useCallback((runGroupId: string) => setCompare({ kind: "history", runGroupId }), []);

  return (
    <>
      <Group
        orientation="horizontal"
        className="h-full"
        defaultLayout={mainLayout.defaultLayout}
        onLayoutChanged={mainLayout.onLayoutChanged}
      >
        <Panel id="editor" minSize={320} className="min-h-0 min-w-0">
          <div className="@container flex h-full w-full min-w-0 flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent @max-md:hidden">
            <FileText size={16} />
          </div>
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink" title={prompt.title}>{prompt.title}</h2>
          {viewingVersion && viewingVersion.branchName !== "main" && (
            <span className="flex min-w-0 max-w-32 shrink items-center gap-1 rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent @max-2xl:hidden">
              <GitFork size={10} className="shrink-0" />
              <span className="truncate">{viewingVersion.branchName}</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => setStarred.mutate(!prompt.isStarred)}
            className={cx(
              "shrink-0 rounded-md p-1.5 transition-colors",
              prompt.isStarred ? "text-star" : "text-ink-faint hover:text-star",
            )}
            aria-label={prompt.isStarred ? "Unstar" : "Star"}
          >
            <Star size={16} fill={prompt.isStarred ? "currentColor" : "none"} />
          </button>
          <VersionDropdown prompt={prompt} versions={versionList} viewingVersion={isViewingCurrent ? null : viewingVersion} onDuplicate={(v) => setDuplicateSource(v)} />
          {!inTrash && (
            <>
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                disabled={!isViewingCurrent && !versionContent}
                title="Share prompt…"
                aria-label="Share prompt"
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Share2 size={12} />
                <span className="@max-md:hidden">Share</span>
              </button>
              <ModelPicker
                multi
                selection={modelSelection}
                onChange={(next) => {
                  setModelSelection(next);
                  setRunModelSelection(prompt.id, next);
                }}
                recents={getRunModelSelection(prompt.id) ?? []}
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                disabled={runModels.isPending}
              />
              <button
                type="button"
                onClick={() => {
                  if (runModels.isPending) {
                    setCompare(null);
                    setLive((current) =>
                      current ? { ...current, dismissed: false } : current,
                    );
                    return;
                  }
                  startRun(modelSelection);
                }}
                disabled={runModels.isPending && live === null}
                title={runModels.isPending ? "Open running evaluation" : "Run with selected models"}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
              >
                {runModels.isPending ? (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                ) : (
                  <Play size={12} />
                )}
                <span className="@max-md:hidden">{runLabel}</span>
              </button>
            </>
          )}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="shrink-0 rounded-md p-1.5 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                aria-label="More actions"
              >
                <MoreHorizontal size={16} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="pb-menu z-50 w-52 rounded-lg border border-line-strong bg-raised p-1 shadow-xl shadow-black/40"
              >
                <MenuItem icon={<Pencil size={13} />} label="Rename prompt" onSelect={() => setRenameOpen(true)} />
                <MenuItem icon={<FileText size={13} />} label="Edit description" onSelect={() => setDescriptionOpen(true)} />
                <MenuItem icon={<FolderInput size={13} />} label="Move to collection…" onSelect={() => setCollectionsOpen(true)} />
                <MenuItem icon={<Star size={13} />} label="Rate prompt…" onSelect={() => setRateTarget({ type: "prompt" })} />
                <MenuItem
                  icon={<Copy size={13} />}
                  label="Duplicate as new prompt…"
                  onSelect={() => {
                    if (viewingVersion) setDuplicatePromptSource(viewingVersion);
                  }}
                />
                <MenuItem
                  icon={<GitFork size={13} />}
                  label="Duplicate as variation…"
                  onSelect={() => {
                    if (viewingVersion) setDuplicateSource(viewingVersion);
                  }}
                />
                <MenuItem
                  icon={<Pencil size={13} />}
                  label="Rename version…"
                  onSelect={() => {
                    if (viewingVersion) setRenameVersionTarget(viewingVersion);
                  }}
                />
                {!isViewingCurrent && viewingVersion && (
                  <MenuItem
                    icon={<Trash2 size={13} />}
                    label="Delete version…"
                    danger
                    onSelect={() => setDeleteVersionTarget(viewingVersion)}
                  />
                )}
                <MenuItem
                  icon={<Download size={13} />}
                  label="Export prompt JSON"
                  onSelect={() => exportPrompt.mutate(undefined)}
                />
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <MenuItem icon={<Trash2 size={13} />} label="Delete prompt" danger onSelect={() => setDeleteOpen(true)} />
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>

        {/* Tag row */}
        <div className="border-b border-line px-4 py-2">
          <TagEditor prompt={prompt} />
        </div>

        {/* Trash banner */}
        {inTrash && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-danger/20 bg-danger-soft px-4 py-2">
            <span className="min-w-0 text-[12px] text-danger">
              This prompt is in Trash. Content is read-only until restored.
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => restore.mutate(undefined)}
                className="flex items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-raised"
              >
                <RotateCcw size={12} />
                Restore
              </button>
              <button
                type="button"
                onClick={() => setHardDeleteOpen(true)}
                className="rounded-md bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-red-500"
              >
                Delete permanently
              </button>
            </div>
          </div>
        )}

        {/* Non-current version banner */}
        {!inTrash && !isViewingCurrent && viewingVersion && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-accent/20 bg-accent-soft/60 px-4 py-2">
            <span className="min-w-0 text-[12px] text-ink-dim">
              You're viewing <span className="font-medium text-ink">{viewingVersion.displayLabel}</span> — read-only.
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrent.mutate(undefined)}
                className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong"
              >
                Restore as current
              </button>
              <button
                type="button"
                onClick={() => setViewingVersionId(null)}
                className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
              >
                Back to current
              </button>
            </div>
          </div>
        )}

        {/* Tabs */}
        <Tabs.Root
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex min-h-0 flex-1 flex-col"
        >
          <Tabs.List className="flex items-center gap-1 overflow-x-auto border-b border-line px-3 pt-1.5">
            {[
              { value: "prompt", label: "Prompt" },
              { value: "history", label: `History (${versionList.length})` },
              // Matches the manual-log list in ResultsTab: model runs
              // (tool "prompthub-run") have their own "Model runs" section.
              { value: "results", label: `Results (${(runs ?? []).filter((r) => r.tool !== "prompthub-run").length})` },
              { value: "notes", label: `Notes (${notes?.length ?? 0})` },
            ].map((tab) => (
              <Tabs.Trigger
                key={tab.value}
                value={tab.value}
                className={cx(
                  "shrink-0 whitespace-nowrap rounded-t-md border-b-2 border-transparent px-3 py-1.5 text-[12px] font-medium transition-colors",
                  "text-ink-dim hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink",
                )}
              >
                {tab.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <Tabs.Content value="prompt" className="flex min-h-0 flex-1 flex-col outline-none">
            {versionContent && viewingVersion ? (
              <EditorTab
                key={`${prompt.id}:${viewingVersion.id}`}
                prompt={prompt}
                version={versionContent}
                isCurrent={isViewingCurrent && !inTrash}
                liveContentRef={liveContentRef}
              />
            ) : (
              <Spinner />
            )}
          </Tabs.Content>
          <Tabs.Content value="history" className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none">
            <HistoryTab
              prompt={prompt}
              versions={versionList}
              onView={(versionId) => {
                setViewingVersionId(versionId === prompt.currentVersionId ? null : versionId);
                setActiveTab("prompt");
              }}
              onCompare={compareVersions}
              onDuplicate={(version) => setDuplicateSource(version)}
              onDuplicateAsPrompt={(version) => setDuplicatePromptSource(version)}
              onRename={(version) => setRenameVersionTarget(version)}
              onDelete={(version) => setDeleteVersionTarget(version)}
            />
          </Tabs.Content>
          <Tabs.Content value="results" className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none">
            <ResultsTab
              prompt={prompt}
              currentVersionLabel={
                versionList.find((v) => v.id === prompt.currentVersionId)?.displayLabel ?? "current"
              }
              onOpenRunGroup={openRunGroup}
            />
          </Tabs.Content>
          <Tabs.Content value="notes" className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none">
            <NotesTab prompt={prompt} versions={versionList} viewingVersion={viewingVersion} />
          </Tabs.Content>
        </Tabs.Root>
      </div>

        </Panel>
        <Separator className="w-px shrink-0" />
        <Panel
          id="inspector"
          collapsible
          collapsedSize={36}
          minSize={240}
          maxSize={400}
          defaultSize={288}
          groupResizeBehavior="preserve-pixel-size"
          panelRef={inspectorRef}
          onResize={(size) => setInspectorCollapsed(size.inPixels <= 37)}
          className="min-h-0"
        >
          <Inspector
            prompt={prompt}
            viewingVersion={viewingVersion}
            collapsed={inspectorCollapsed}
            onToggleCollapse={toggleInspector}
            onRateVersion={rateVersion}
            onCompare={compareVersions}
            onOpenRunGroup={openRunGroup}
          />
        </Panel>
      </Group>

      {/* Dialogs */}
      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        prompt={prompt}
        content={
          isViewingCurrent
            ? (liveContentRef.current ?? prompt.draftContent ?? versionContent?.content)
            : versionContent?.content
        }
      />
      <NameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename prompt"
        label="Title"
        initialValue={prompt.title}
        submitLabel="Rename"
        onSubmit={(title) => rename.mutate(title)}
      />
      <NameDialog
        open={descriptionOpen}
        onOpenChange={setDescriptionOpen}
        title="Edit description"
        label="Description"
        initialValue={prompt.description ?? ""}
        placeholder="What is this prompt for?"
        onSubmit={(value) => updateDescription.mutate(value)}
      />
      <NameDialog
        open={duplicatePromptSource !== null}
        onOpenChange={(open) => {
          if (!open) setDuplicatePromptSource(null);
        }}
        title={`Duplicate ${duplicatePromptSource?.displayLabel ?? "version"} as new prompt`}
        label="Title"
        initialValue={`${prompt.title} copy`}
        submitLabel="Duplicate"
        onSubmit={(title) => {
          if (duplicatePromptSource) {
            duplicatePrompt.mutate({ versionId: duplicatePromptSource.id, title });
          }
        }}
      />
      <NameDialog
        open={renameVersionTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameVersionTarget(null);
        }}
        title={`Rename ${renameVersionTarget?.displayLabel ?? "version"}`}
        label="Version name"
        initialValue={renameVersionTarget?.label ?? ""}
        placeholder={renameVersionTarget ? `Automatic: v${renameVersionTarget.number}` : undefined}
        submitLabel="Rename"
        allowEmpty
        onSubmit={(label) => {
          if (renameVersionTarget) {
            renameVersion.mutate({ versionId: renameVersionTarget.id, label: label || null });
          }
        }}
      />
      <MoveToCollectionDialog prompt={prompt} open={collectionsOpen} onOpenChange={setCollectionsOpen} />
      <ConfirmDialog
        open={deleteVersionTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteVersionTarget(null);
        }}
        title={`Delete ${deleteVersionTarget?.displayLabel ?? "version"}?`}
        description="Run results and ratings will be permanently removed. Version notes become prompt-level notes, published shares stay live, and surviving version numbers stay unchanged. This cannot be undone."
        confirmLabel="Delete version"
        danger
        onConfirm={() => {
          if (deleteVersionTarget) deleteVersion.mutate(deleteVersionTarget.id);
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete “${prompt.title}”?`}
        description="The prompt moves to Trash with its full history. You can restore it from there."
        confirmLabel="Move to Trash"
        danger
        onConfirm={() => softDelete.mutate(undefined)}
      />
      <ConfirmDialog
        open={hardDeleteOpen}
        onOpenChange={setHardDeleteOpen}
        title={`Permanently delete “${prompt.title}”?`}
        description="All versions, notes, ratings and runs are removed. This cannot be undone."
        confirmLabel="Delete permanently"
        danger
        onConfirm={() => hardDelete.mutate(undefined)}
      />
      <RateDialog
        open={rateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRateTarget(null);
        }}
        title={
          rateTarget?.type === "version" ? `Rate ${rateTarget.version.displayLabel}` : "Rate prompt"
        }
        onSubmit={(scores) => {
          if (!rateTarget) return;
          rate.mutate({
            targetType: rateTarget.type,
            targetId: rateTarget.type === "version" ? rateTarget.version.id : prompt.id,
            scores,
          });
        }}
      />
      <DuplicateBranchDialog
        open={duplicateSource !== null}
        onOpenChange={(open) => {
          if (!open) setDuplicateSource(null);
        }}
        sourceLabel={duplicateSource?.displayLabel ?? ""}
        onSubmit={duplicateAsVariation}
      />
      <CompareDialog
        open={comparePair !== null}
        onOpenChange={(open) => {
          if (!open) setComparePair(null);
        }}
        base={comparePair?.base ?? null}
        other={comparePair?.other ?? null}
      />
      <RunVariablesDialog
        open={variablesOpen}
        onOpenChange={setVariablesOpen}
        names={variableNames}
        initialValues={variableInitialValues}
        onSubmit={(values) => {
          setRunVariables(prompt.id, values);
          beginRun(pendingRefs, values);
        }}
      />
      <RunCompareView
        group={activeGroup}
        promptId={prompt.id}
        promptTitle={prompt.title}
        versionLabel={compareVersionLabel}
        open={compare !== null || (live !== null && !live.dismissed)}
        onOpenChange={(open) => {
          if (!open) {
            setCompare(null);
            // Closing mid-run only dismisses the view: progress tracking
            // continues (Run button keeps its n/m label) and completion
            // reopens the settled compare view.
            setLive((current) => (current ? { ...current, dismissed: true } : current));
          }
        }}
        running={runModels.isPending}
        live={live !== null && !live.dismissed}
        cancelling={live?.cancelling ?? false}
        onCancel={() => {
          const runGroupId = live?.group.runGroupId;
          if (!runGroupId) return;
          setLive((current) => (current ? { ...current, cancelling: true } : current));
          cancelRun.mutate(runGroupId);
        }}
        onRerun={(refs) => startRun(refs, true)}
        onChangeModels={() => {
          setCompare(null);
          setLive(null);
          setPickerOpen(true);
        }}
      />
    </>
  );
}

export function MainPaneEmpty() {
  const { view } = useAppState();
  return (
    <div className="flex h-full w-full min-w-0 items-center justify-center">
      <EmptyState
        icon={<FileText size={16} />}
        title={view.kind === "trash" ? "Nothing selected" : "Select a prompt"}
        hint="Pick a prompt from the list, or press ⌘K to search."
      />
    </div>
  );
}
