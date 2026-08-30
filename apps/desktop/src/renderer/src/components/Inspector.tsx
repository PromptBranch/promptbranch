import { memo } from "react";
import { Clock, GitCompare, PanelRightClose, PanelRightOpen, Play, Star } from "lucide-react";
import type { PromptDetail, RunGroupDto, VersionDto } from "../../../shared/ipc.js";
import { useAiProviders, useLatestRating, useRatingAverages, useRunGroups, useRuns, useVersions } from "../hooks/use-data";
import { relativeTime } from "../lib/time";
import { TagEditor } from "./TagEditor";
import { Stars } from "./ui";

const DIMENSIONS: Array<{ key: "effectiveness" | "clarity" | "completeness" | "actionability"; label: string }> = [
  { key: "effectiveness", label: "Effectiveness" },
  { key: "clarity", label: "Clarity" },
  { key: "completeness", label: "Completeness" },
  { key: "actionability", label: "Actionability" },
];

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Mean of a rating's non-null dimension scores; null when none are set. */
function ratingOverall(rating: {
  effectiveness: number | null;
  clarity: number | null;
  completeness: number | null;
  actionability: number | null;
}): number | null {
  const values = [rating.effectiveness, rating.clarity, rating.completeness, rating.actionability].filter(
    (v): v is number => v !== null,
  );
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function EvalSummary({
  version,
  onRate,
}: {
  version: VersionDto | null;
  onRate: (version: VersionDto) => void;
}) {
  const versionId = version?.id ?? null;
  const { data: latest } = useLatestRating("version", versionId);
  const { data: averages } = useRatingAverages(versionId);

  const hasLatest = latest !== null && latest !== undefined;
  const latestOverall = hasLatest ? ratingOverall(latest) : null;
  const ratingCount = averages?.count ?? 0;

  return (
    <Card
      title="Evaluation Summary"
      action={
        version ? (
          <button
            type="button"
            onClick={() => onRate(version)}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-star"
          >
            <Star size={11} />
            Rate
          </button>
        ) : null
      }
    >
      <div className="space-y-1.5">
        {DIMENSIONS.map((dim) => {
          const value = hasLatest ? latest[dim.key] : null;
          return (
            <div key={dim.key} className="flex items-center justify-between text-[12px]">
              <span className="text-ink-dim">{dim.label}</span>
              {value !== null ? (
                <span className="flex items-center gap-2">
                  <span className="h-1 w-16 overflow-hidden rounded-full bg-raised">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${(value / 5) * 100}%` }}
                    />
                  </span>
                  <span className="w-6 text-right tabular-nums text-ink">{value.toFixed(1)}</span>
                </span>
              ) : (
                <span className="tabular-nums text-ink-faint">—</span>
              )}
            </div>
          );
        })}
        <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-[12px]">
          <span className="font-medium text-ink">Average</span>
          <span className="tabular-nums text-ink">
            {latestOverall !== null ? latestOverall.toFixed(1) : "—"}
          </span>
        </div>
        {ratingCount > 1 && averages?.overall !== null && averages?.overall !== undefined && (
          <p className="text-right text-[10px] tabular-nums text-ink-faint">
            avg {averages.overall.toFixed(1)} of {ratingCount} ratings
          </p>
        )}
        {!hasLatest && (
          <p className="pt-1 text-[11px] leading-relaxed text-ink-faint">
            No ratings yet for {version?.displayLabel ?? "this version"} — use Rate above after trying it.
          </p>
        )}
      </div>
    </Card>
  );
}

interface ModelPerf {
  modelId: string;
  runs: number;
  avgOutcome: number | null;
  avgLatencyMs: number | null;
  /** Mean estimated USD cost across runs with cost data; null when none. */
  avgCostUsd: number | null;
  /** Newest run group containing this model (groups arrive newest-first). */
  latestGroupId: string;
}

/** Per-model aggregates over the prompt's stored run groups. */
function aggregateModelPerformance(groups: RunGroupDto[]): ModelPerf[] {
  const byModel = new Map<
    string,
    ModelPerf & { outcomeSum: number; outcomes: number; latencySum: number; latencies: number; costSum: number; costs: number }
  >();
  for (const group of groups) {
    for (const run of group.runs) {
      const modelId = run.model ?? "unknown";
      let agg = byModel.get(modelId);
      if (!agg) {
        agg = {
          modelId,
          runs: 0,
          avgOutcome: null,
          avgLatencyMs: null,
          avgCostUsd: null,
          latestGroupId: group.runGroupId,
          outcomeSum: 0,
          outcomes: 0,
          latencySum: 0,
          latencies: 0,
          costSum: 0,
          costs: 0,
        };
        byModel.set(modelId, agg);
      }
      agg.runs += 1;
      if (run.outcomeRating !== null) {
        agg.outcomeSum += run.outcomeRating;
        agg.outcomes += 1;
      }
      if (run.latencyMs !== null) {
        agg.latencySum += run.latencyMs;
        agg.latencies += 1;
      }
      if (run.costUsd !== null) {
        agg.costSum += run.costUsd;
        agg.costs += 1;
      }
    }
  }
  return [...byModel.values()]
    .map((agg) => ({
      modelId: agg.modelId,
      runs: agg.runs,
      avgOutcome: agg.outcomes > 0 ? agg.outcomeSum / agg.outcomes : null,
      avgLatencyMs: agg.latencies > 0 ? Math.round(agg.latencySum / agg.latencies) : null,
      avgCostUsd: agg.costs > 0 ? agg.costSum / agg.costs : null,
      latestGroupId: agg.latestGroupId,
    }))
    .sort((a, b) => b.runs - a.runs);
}

/** Compact cost for the model-performance rows (matches RunCompareView). */
function formatAvgCost(costUsd: number): string {
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(3)}`;
}

/** Per-model stats from AI runs; clicking a row opens its latest run group. */
function ModelPerformance({
  promptId,
  onOpenRunGroup,
}: {
  promptId: string;
  onOpenRunGroup: (runGroupId: string) => void;
}) {
  const { data: groups } = useRunGroups(promptId);
  const { data: providers } = useAiProviders();

  const models = aggregateModelPerformance(groups ?? []);
  // The empty state only makes sense once AI is set up at all.
  if (models.length === 0 && (providers ?? []).length === 0) return null;

  return (
    <Card title="Model performance">
      {models.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          No model runs yet — use the Run button in the prompt header to compare models.
        </p>
      ) : (
        <div className="space-y-0.5">
          {models.map((model) => (
            <button
              key={model.modelId}
              type="button"
              onClick={() => onOpenRunGroup(model.latestGroupId)}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{model.modelId}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
                {model.runs} run{model.runs > 1 ? "s" : ""}
                {model.avgLatencyMs !== null ? ` · ${model.avgLatencyMs} ms` : ""}
                {model.avgCostUsd !== null ? ` · ${formatAvgCost(model.avgCostUsd)} avg` : ""}
              </span>
              {model.avgOutcome !== null && <Stars value={model.avgOutcome} size={10} />}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Memoized: MainPane re-renders on every streamed run delta; the Inspector's
 * props keep identity across those renders (query-cached objects, useCallback
 * handlers), so it renders once and stays put while a run streams.
 */
export const Inspector = memo(function Inspector({
  prompt,
  viewingVersion,
  collapsed = false,
  onToggleCollapse,
  onRateVersion,
  onCompare,
  onOpenRunGroup,
}: {
  prompt: PromptDetail;
  viewingVersion: VersionDto | null;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onRateVersion: (version: VersionDto) => void;
  onCompare: (base: VersionDto, other: VersionDto) => void;
  onOpenRunGroup: (runGroupId: string) => void;
}) {
  const { data: runs } = useRuns(prompt.id);
  const { data: versions } = useVersions(prompt.id);
  const lastRun = runs?.[0] ?? null;

  // Previous version on the same branch as the viewed version.
  const previousVersion =
    viewingVersion && versions
      ? (versions.find(
          (v) => v.branchId === viewingVersion.branchId && v.number === viewingVersion.number - 1,
        ) ?? null)
      : null;

  // Slim strip shown when the inspector panel is collapsed.
  if (collapsed) {
    return (
      <aside className="flex h-full w-full flex-col items-center bg-app py-2">
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand inspector"
          aria-label="Expand inspector"
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        >
          <PanelRightOpen size={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-full flex-col gap-3 overflow-y-auto bg-app p-3">
      <div className="flex items-center justify-between">
        <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
          Inspector
        </span>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Collapse inspector"
          aria-label="Collapse inspector"
          className="rounded p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        >
          <PanelRightClose size={13} />
        </button>
      </div>
      <EvalSummary version={viewingVersion} onRate={onRateVersion} />

      <ModelPerformance promptId={prompt.id} onOpenRunGroup={onOpenRunGroup} />

      <Card title="Usage">
        <dl className="space-y-1.5 text-[12px]">
          {[
            { label: "Runs", value: String(runs?.length ?? 0) },
            {
              label: "Last run",
              value: lastRun ? relativeTime(lastRun.startedAt ?? lastRun.createdAt) : "—",
            },
            { label: "First added", value: relativeTime(prompt.createdAt) },
            { label: "Last updated", value: relativeTime(prompt.updatedAt) },
          ].map((row) => (
            <div key={row.label} className="flex items-center justify-between">
              <dt className="flex items-center gap-1.5 text-ink-dim">
                {row.label === "Runs" && <Play size={11} className="text-ink-faint" />}
                {row.label !== "Runs" && <Clock size={11} className="text-ink-faint" />}
                {row.label}
              </dt>
              <dd className="tabular-nums text-ink">{row.value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {previousVersion && viewingVersion && (
        <Card title="Compare">
          <p className="mb-2 text-[12px] leading-relaxed text-ink-dim">
            Diff {viewingVersion.displayLabel} against{" "}
            <span className="font-medium text-ink">{previousVersion.displayLabel}</span>.
          </p>
          <button
            type="button"
            onClick={() => onCompare(previousVersion, viewingVersion)}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink transition-colors hover:border-line-strong hover:bg-hover"
          >
            <GitCompare size={12} className="shrink-0" />
            <span className="min-w-0 truncate">Compare with {previousVersion.displayLabel}</span>
          </button>
        </Card>
      )}

      <Card title="Linked Tags">
        <TagEditor prompt={prompt} compact />
      </Card>
    </aside>
  );
});
