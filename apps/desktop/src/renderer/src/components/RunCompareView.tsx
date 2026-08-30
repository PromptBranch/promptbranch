import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Bookmark, ChevronDown, ChevronRight, CircleStop, Play, RefreshCw, Scale, X } from "lucide-react";
import { judgeAverage, type JudgeScores } from "@promptbranch/ai/judge-average";
import type { AiJudgeResult, AiRunGroupDto, RunGroupDto } from "../../../shared/ipc.js";
import { useAppMutation } from "../hooks/use-data";
import { cx, relativeTime } from "../lib/time";
import type { ModelRef } from "../lib/ai-prefs";
import { useToast } from "../lib/toast";
import { ConfirmDialog } from "./dialogs";
import { MarkdownPreview } from "./MarkdownPreview";
import { ModelPicker } from "./model-picker";
import { StarRatingInput } from "./ui";

/**
 * Normalized per-run row for the compare view (live runs, fresh runs and
 * history share it). "pending"/"streaming" only occur while a run is in
 * flight; `partial` carries the accumulated streamed text.
 */
export interface CompareRun {
  runId: string;
  versionId: string;
  providerId: string | null;
  providerName: string;
  modelId: string;
  status: "pending" | "streaming" | "completed" | "error";
  output: string | null;
  error: string | null;
  latencyMs: number | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  costUsd: number | null;
  outcomeRating: number | null;
  /** Accumulated output while streaming (and the partial output on error). */
  partial: string | null;
  /** Judge rationale persisted in metrics_json (null until applied). */
  judgeRationale: string | null;
  /** Judge dimension scores persisted in metrics_json (null until applied). */
  judgeScores: JudgeScores | null;
}

export interface CompareGroup {
  runGroupId: string;
  versionId: string;
  createdAt: string;
  runs: CompareRun[];
}

/** Fresh ai:run result → compare rows (ratings start unrated). */
export function fromRunResult(group: AiRunGroupDto): CompareGroup {
  return {
    runGroupId: group.runGroupId,
    versionId: group.versionId,
    createdAt: group.createdAt,
    runs: group.runs.map((run) => ({
      runId: run.runId,
      versionId: group.versionId,
      providerId: run.providerId,
      providerName: run.providerName,
      modelId: run.modelId,
      status: run.status,
      output: run.output,
      error: run.error,
      latencyMs: run.latencyMs,
      usage: run.usage,
      costUsd: run.costUsd,
      outcomeRating: null,
      partial: null,
      judgeRationale: null,
      judgeScores: null,
    })),
  };
}

/** Stored run group (run:group-list) → compare rows. */
export function fromStoredGroup(group: RunGroupDto): CompareGroup {
  return {
    runGroupId: group.runGroupId,
    versionId: group.runs[0]?.versionId ?? "",
    createdAt: group.createdAt,
    runs: group.runs.map((run) => ({
      runId: run.id,
      versionId: run.versionId,
      providerId: run.provider,
      providerName: run.providerName ?? "Deleted provider",
      modelId: run.model ?? "unknown",
      status: run.status,
      output: run.output,
      error: run.error,
      latencyMs: run.latencyMs,
      usage: run.usage,
      costUsd: run.costUsd,
      outcomeRating: run.outcomeRating,
      partial: null,
      judgeRationale: run.judgeRationale,
      judgeScores: run.judgeScores,
    })),
  };
}

/**
 * Placeholder columns for a run that just started: one "pending" row per
 * selected model, updated live as ai:run-progress events arrive. Rows have
 * no runId yet (it exists only once the model settles and its row is
 * written), so star rating stays disabled until the final DTO replaces the
 * live group.
 */
export function placeholderGroup(
  refs: Array<ModelRef & { providerName: string }>,
  versionId: string,
): CompareGroup {
  return {
    runGroupId: "",
    versionId,
    createdAt: new Date().toISOString(),
    runs: refs.map((ref) => ({
      runId: "",
      versionId,
      providerId: ref.providerId,
      providerName: ref.providerName,
      modelId: ref.modelId,
      status: "pending",
      output: null,
      error: null,
      latencyMs: null,
      usage: null,
      costUsd: null,
      outcomeRating: null,
      partial: null,
      judgeRationale: null,
      judgeScores: null,
    })),
  };
}

function formatCost(costUsd: number | null): string | null {
  if (costUsd === null) return null;
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(3)}`;
}

function formatTokens(usage: CompareRun["usage"]): string | null {
  if (!usage) return null;
  const input = usage.inputTokens ?? "—";
  const output = usage.outputTokens ?? "—";
  return `${input}→${output} tok`;
}

/** Live status chip in the column header. */
function StatusChip({ run }: { run: CompareRun }) {
  switch (run.status) {
    case "pending":
      return <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-[10px] text-ink-faint">Queued</span>;
    case "streaming":
      return (
        <span className="flex shrink-0 items-center gap-1 rounded-full border border-accent/40 bg-accent-soft px-1.5 py-px text-[10px] font-medium text-accent">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          Streaming
        </span>
      );
    case "error":
      return <span className="shrink-0 rounded-full border border-danger/30 bg-danger-soft px-1.5 py-px text-[10px] font-medium text-danger">Failed</span>;
    case "completed":
      return (
        <span className="shrink-0 rounded-full border border-success/30 bg-success-soft px-1.5 py-px text-[10px] font-medium text-success">
          Done{run.latencyMs !== null ? ` · ${run.latencyMs} ms` : ""}
        </span>
      );
  }
}

// ------------------------------------------------------------------ judging

/** Per-run judge outcome held in the compare view (nothing persisted yet). */
export type JudgeEntry =
  | { status: "scored"; scores: AiJudgeResult["results"][number]["scores"]; rationale: string; average: number }
  | { status: "failed" };

/** Badge data for a run whose judge scores were applied (persisted in metrics_json). */
function storedJudgeEntry(run: CompareRun): JudgeEntry | undefined {
  if (run.judgeScores === null || run.judgeRationale === null) return undefined;
  return {
    status: "scored",
    scores: run.judgeScores,
    rationale: run.judgeRationale,
    average: judgeAverage(run.judgeScores),
  };
}

const JUDGE_DIMS: Array<{ key: "effectiveness" | "clarity" | "completeness" | "actionability"; label: string }> = [
  { key: "effectiveness", label: "Effectiveness" },
  { key: "clarity", label: "Clarity" },
  { key: "completeness", label: "Completeness" },
  { key: "actionability", label: "Actionability" },
];

/** Expandable judge score badge + dimension details for one column. */
function JudgeBadge({ entry }: { entry: JudgeEntry }) {
  const [open, setOpen] = useState(false);
  if (entry.status === "failed") {
    return <div className="border-t border-line px-3 py-1.5 text-[11px] text-danger">Judge failed</div>;
  }
  return (
    <div className="border-t border-line">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors hover:bg-hover"
      >
        <Scale size={11} className="shrink-0 text-accent" />
        <span className="rounded-full border border-accent/40 bg-accent-soft px-1.5 py-px text-[10px] font-semibold tabular-nums text-accent">
          {entry.average.toFixed(1)}
        </span>
        <span className="text-[10px] text-ink-faint">AI judge</span>
        <span className="ml-auto text-ink-faint">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 px-3 pb-2.5">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {JUDGE_DIMS.map((dim) => (
              <div key={dim.key} className="flex items-center justify-between text-[11px]">
                <span className="text-ink-faint">{dim.label}</span>
                <span className="font-medium tabular-nums text-ink-dim">{entry.scores[dim.key]}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-ink-dim">{entry.rationale}</p>
        </div>
      )}
    </div>
  );
}

/** Judge setup dialog: single judge model + optional criteria. */
function JudgeDialog({
  open,
  onOpenChange,
  busy,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onRun: (judge: ModelRef, criteria: string) => void;
}) {
  const [judgeModel, setJudgeModel] = useState<ModelRef | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [criteria, setCriteria] = useState("");
  useEffect(() => {
    if (open) setCriteria("");
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pb-overlay fixed inset-0 z-[60] bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="pb-dialog fixed left-1/2 top-1/2 z-[70] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line-strong bg-panel p-5 shadow-2xl shadow-black/50 focus:outline-none"
        >
          <div className="mb-4 flex items-center justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold text-ink">Judge with AI</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="rounded-md p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <X size={15} />
            </Dialog.Close>
          </div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-ink-dim">Judge model</span>
              <ModelPicker
                multi={false}
                selection={judgeModel ? [judgeModel] : []}
                onChange={(next) => setJudgeModel(next[0] ?? null)}
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                align="start"
                fullWidthTrigger
              />
            </div>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-ink-dim">
                Criteria <span className="font-normal text-ink-faint">(optional)</span>
              </span>
              <textarea
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                placeholder="What makes a good response?"
                rows={3}
                className="w-full resize-y rounded-md border border-line bg-app px-2.5 py-1.5 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={judgeModel === null || busy}
                onClick={() => {
                  if (judgeModel) onRun(judgeModel, criteria.trim());
                }}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy && <RefreshCw size={11} className="animate-spin" />}
                Run judge
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RunColumn({
  run,
  judging,
  judgeEntry,
  onRate,
  onSaveNote,
}: {
  run: CompareRun;
  /** True while the judge is scoring this group (completed columns only). */
  judging: boolean;
  judgeEntry: JudgeEntry | undefined;
  onRate: (runId: string, outcomeRating: number | null) => void;
  onSaveNote: (run: CompareRun) => void;
}) {
  const stats = [
    run.latencyMs !== null ? `${run.latencyMs} ms` : null,
    formatTokens(run.usage),
    formatCost(run.costUsd) ?? (run.status === "completed" && run.usage ? "cost —" : null),
  ].filter(Boolean);
  // Star rating only for settled runs with a persisted row — live
  // placeholders have no runId yet.
  const rateable = run.status === "completed" && run.runId !== "";

  return (
    <div className="flex w-80 shrink-0 flex-col rounded-lg border border-line bg-panel">
      <div className="flex items-start justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-medium text-ink">{run.modelId}</p>
          <p className="truncate text-[11px] text-ink-faint">{run.providerName}</p>
        </div>
        <StatusChip run={run} />
      </div>
      {run.status === "pending" ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-faint">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
          Waiting to start…
        </div>
      ) : run.status === "streaming" || run.status === "completed" ? (
        // One MarkdownPreview container across the streaming → settled
        // transition: only the autoScroll prop flips off, so the DOM node
        // (and its scroll position) survives the column settling.
        <div className="min-h-0 flex-1 overflow-hidden">
          <MarkdownPreview
            content={run.status === "completed" ? (run.output ?? "") : (run.partial ?? "")}
            autoScroll={run.status === "streaming"}
          />
        </div>
      ) : (
        <div className="m-3 flex items-start gap-2 rounded-md border border-danger/20 bg-danger-soft p-3">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
          <p className="text-[12px] leading-relaxed text-danger">{run.error ?? "Run failed"}</p>
        </div>
      )}
      {judging && run.status === "completed" && (
        <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[11px] text-ink-faint">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
          Judging…
        </div>
      )}
      {!judging && judgeEntry && run.status === "completed" && <JudgeBadge entry={judgeEntry} />}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-line px-3 py-2">
        <span className="min-w-0 truncate text-[10px] tabular-nums text-ink-faint">
          {stats.length > 0 ? stats.join(" · ") : "—"}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {rateable && (
            <button
              type="button"
              onClick={() => onSaveNote(run)}
              aria-label="Save as note"
              title="Save output as note"
              className="rounded p-0.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <Bookmark size={13} />
            </button>
          )}
          {rateable && (
            <StarRatingInput
              value={run.outcomeRating}
              onChange={(value) => onRate(run.runId, value)}
              size={14}
            />
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * Side-by-side model outputs of one run group. Opens live while a run
 * streams (status chips, token-by-token output, Cancel) and settles into
 * the final state when every model finished; history groups from the
 * Results tab / Inspector open directly in the final state. Settled groups
 * can be scored by an LLM judge and saved to Notes.
 */
export function RunCompareView({
  group,
  promptId,
  promptTitle,
  versionLabel,
  open,
  onOpenChange,
  running,
  live = false,
  cancelling = false,
  onCancel,
  onRerun,
  onChangeModels,
}: {
  group: CompareGroup | null;
  promptId: string;
  promptTitle: string;
  versionLabel: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** True while a (re)run is in flight; disables the footer actions. */
  running: boolean;
  /** True while this group is the in-flight run (enables Cancel + live columns). */
  live?: boolean;
  cancelling?: boolean;
  onCancel?: () => void;
  onRerun: (modelRefs: ModelRef[]) => void;
  onChangeModels: () => void;
}) {
  const [runs, setRuns] = useState<CompareRun[]>(group?.runs ?? []);
  const [judgeOpen, setJudgeOpen] = useState(false);
  const [judgeEntries, setJudgeEntries] = useState<Record<string, JudgeEntry>>({});
  const [judgeModelLabel, setJudgeModelLabel] = useState<string | null>(null);
  const [judgeSkippedCount, setJudgeSkippedCount] = useState(0);
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const { toast } = useToast();
  useEffect(() => {
    setRuns(group?.runs ?? []);
    // Judge scores belong to one group — never leak into another.
    setJudgeEntries({});
    setJudgeModelLabel(null);
    setJudgeSkippedCount(0);
  }, [group]);

  const rate = useAppMutation(
    (input: { runId: string; outcomeRating: number | null }) =>
      window.promptBuilder.runs.updateOutcome(input),
    {
      quiet: true,
      onSuccess: (_, input) =>
        setRuns((current) =>
          current.map((run) => (run.runId === input.runId ? { ...run, outcomeRating: input.outcomeRating } : run)),
        ),
    },
  );

  const judge = useAppMutation(
    // runGroupId is captured per call so a stale completion can be detected.
    (input: { runGroupId: string; judge: ModelRef; criteria: string }) =>
      window.promptBuilder.ai.judge({
        runGroupId: input.runGroupId,
        judge: input.judge,
        ...(input.criteria ? { criteria: input.criteria } : {}),
      }),
    {
      quiet: true,
      // Read-only call — no DB writes, so no invalidation storm mid-judge.
      invalidate: false,
      onSuccess: (result, input) => {
        setJudgeOpen(false);
        // The user reran/switched/opened another group while judging —
        // applying these scores to the now-visible group would be wrong.
        if (input.runGroupId !== group?.runGroupId) {
          toast("Judge results discarded — group changed", "error");
          return;
        }
        const next: Record<string, JudgeEntry> = {};
        for (const scored of result.results) {
          next[scored.runId] = {
            status: "scored",
            scores: scored.scores,
            rationale: scored.rationale,
            average: judgeAverage(scored.scores),
          };
        }
        for (const failure of result.failures) {
          next[failure.runId] = { status: "failed" };
        }
        setJudgeEntries(next);
        setJudgeModelLabel(input.judge.modelId);
        setJudgeSkippedCount(result.skipped.length);
      },
    },
  );

  const saveNote = useAppMutation(
    (run: CompareRun) =>
      window.promptBuilder.notes.add({
        promptId,
        versionId: run.versionId,
        body: `Model output — ${run.modelId} (${new Date().toISOString().slice(0, 10)})\n\n${run.output ?? ""}`,
      }),
    { toast: "Saved to Notes" },
  );

  const applyRatings = useAppMutation(
    async (entries: Array<{ runId: string; average: number; rationale: string; scores: JudgeScores }>) => {
      for (const entry of entries) {
        await window.promptBuilder.runs.updateOutcome({ runId: entry.runId, outcomeRating: entry.average });
        // Persist rationale + dimension scores so the badge survives refetches
        // and reopens from history.
        await window.promptBuilder.runs.updateMetrics({
          runId: entry.runId,
          patch: { judgeRationale: entry.rationale, judgeScores: entry.scores },
        });
      }
    },
    {
      toast: "Judge ratings applied",
      onSuccess: (_, entries) => {
        // The fresh judge state is persisted now — keep the badges visible by
        // moving scores/rationale onto the rows, then drop the transient state.
        setRuns((current) =>
          current.map((run) => {
            const entry = entries.find((e) => e.runId === run.runId);
            return entry
              ? {
                  ...run,
                  outcomeRating: entry.average,
                  judgeRationale: entry.rationale,
                  judgeScores: entry.scores,
                }
              : run;
          }),
        );
        setJudgeEntries({});
        setJudgeModelLabel(null);
        setJudgeSkippedCount(0);
      },
    },
  );

  if (!group) return null;

  const rerunnable: ModelRef[] = runs
    .filter((run): run is CompareRun & { providerId: string } => run.providerId !== null)
    .map((run) => ({ providerId: run.providerId, modelId: run.modelId }));
  const okCount = runs.filter((run) => run.status === "completed").length;
  const settledCount = runs.filter((run) => run.status === "completed" || run.status === "error").length;

  // Judging only makes sense on a settled, persisted group with outputs.
  const judgeable = !live && !running && group.runGroupId !== "" && okCount > 0;
  const scoredEntries = Object.entries(judgeEntries).filter(
    (entry): entry is [string, JudgeEntry & { status: "scored" }] => entry[1].status === "scored",
  );
  const failedJudgeCount = Object.values(judgeEntries).filter((e) => e.status === "failed").length;

  const applyJudgeRatings = () => {
    applyRatings.mutate(
      scoredEntries.map(([runId, entry]) => ({
        runId,
        average: entry.average,
        rationale: entry.rationale,
        scores: entry.scores,
      })),
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pb-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="pb-dialog fixed left-1/2 top-1/2 z-50 flex h-[85vh] w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line-strong bg-app shadow-2xl shadow-black/50 focus:outline-none"
        >
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-line bg-panel px-5 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-sm font-semibold text-ink">{promptTitle}</Dialog.Title>
              <p className="text-[11px] text-ink-faint">
                {versionLabel ?? "—"} · {relativeTime(group.createdAt)} ·{" "}
                {live
                  ? `Running ${settledCount}/${runs.length}…`
                  : `${okCount}/${runs.length} succeeded`}
              </p>
            </div>
            {live && onCancel && (
              <button
                type="button"
                onClick={onCancel}
                disabled={cancelling || group.runGroupId === ""}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-danger/40 px-2.5 py-1.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                <CircleStop size={12} />
                {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            )}
            {judgeable && (
              <button
                type="button"
                onClick={() => setJudgeOpen(true)}
                disabled={judge.isPending}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Scale size={12} />
                Judge with AI
              </button>
            )}
            <button
              type="button"
              onClick={onChangeModels}
              disabled={running}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              Change models
            </button>
            <button
              type="button"
              onClick={() => onRerun(rerunnable)}
              disabled={running || rerunnable.length === 0}
              className={cx(
                "flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors",
                "hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              {running ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
              Rerun
            </button>
            <Dialog.Close
              aria-label="Close"
              className="rounded-md p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <X size={15} />
            </Dialog.Close>
          </div>

          {/* Columns */}
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
            {runs.map((run) => (
              <RunColumn
                // Stable across the live → settled transition: placeholder
                // rows have no runId yet, and the final DTO assigns one —
                // keying by runId would remount every column at settle,
                // dropping scroll/expand state. Deleted-provider history rows
                // (providerId null) fall back to the unique runId.
                key={run.providerId !== null ? `${run.providerId}:${run.modelId}` : run.runId}
                run={run}
                judging={judge.isPending}
                judgeEntry={judgeEntries[run.runId] ?? storedJudgeEntry(run)}
                onRate={(runId, outcomeRating) => rate.mutate({ runId, outcomeRating })}
                onSaveNote={(target) => saveNote.mutate(target)}
              />
            ))}
          </div>

          {/* Judge footer */}
          {scoredEntries.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-t border-line bg-panel px-5 py-2.5">
              <span className="text-[11px] text-ink-faint">
                Judged by {judgeModelLabel ?? "AI"} — {scoredEntries.length} scored
                {failedJudgeCount > 0 ? `, ${failedJudgeCount} failed` : ""}
                {judgeSkippedCount > 0 ? `, ${judgeSkippedCount} skipped` : ""} · not saved until applied
              </span>
              <button
                type="button"
                onClick={() => {
                  // Replacing existing human ratings asks for confirmation.
                  const wouldOverwrite = runs.some(
                    (run) => judgeEntries[run.runId]?.status === "scored" && run.outcomeRating !== null,
                  );
                  if (wouldOverwrite) {
                    setApplyConfirmOpen(true);
                  } else {
                    applyJudgeRatings();
                  }
                }}
                disabled={applyRatings.isPending}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
              >
                {applyRatings.isPending && <RefreshCw size={11} className="animate-spin" />}
                Apply as ratings
              </button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>

      <JudgeDialog
        open={judgeOpen}
        onOpenChange={setJudgeOpen}
        busy={judge.isPending}
        onRun={(judgeModel, criteria) => judge.mutate({ runGroupId: group.runGroupId, judge: judgeModel, criteria })}
      />
      <ConfirmDialog
        open={applyConfirmOpen}
        onOpenChange={setApplyConfirmOpen}
        title="Replace existing ratings?"
        description="Some runs already have an outcome rating. Applying the judge scores overwrites them."
        confirmLabel="Apply ratings"
        onConfirm={applyJudgeRatings}
      />
    </Dialog.Root>
  );
}
