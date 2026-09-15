import { useEffect, useMemo } from "react";
import { GitBranch, Maximize2, Minus, Plus, Star } from "lucide-react";
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { PromptDetail, RatingSummaryDto, VersionDto } from "../../../shared/ipc.js";
import { buildHistoryGraph, type HistoryGraphNodeModel } from "../lib/history-graph";
import { cx, relativeTime } from "../lib/time";
import { EmptyState } from "./ui";
import { HistoryVersionActions, type HistoryVersionActionHandlers } from "./HistoryVersionActions";

type HistoryGraphNodeData = {
  version: VersionDto;
  isCurrent: boolean;
  isViewing: boolean;
  isCompareSelected: boolean;
  rating: RatingSummaryDto | undefined;
  onSelect(versionId: string): void;
  onToggleCompare(versionId: string): void;
};

type HistoryGraphNode = Node<HistoryGraphNodeData, "historyVersion">;

function HistoryVersionNode({ data, selected }: NodeProps<HistoryGraphNode>) {
  const { version } = data;
  const stateLabels = [
    data.isCurrent ? "Current" : null,
    data.isViewing ? "Viewing" : null,
    selected ? "Selected" : null,
  ].filter((label): label is string => label !== null);
  const accessibleName = `${version.displayLabel} on ${version.branchName}${stateLabels.length ? `, ${stateLabels.join(", ")}` : ""}`;

  const selectNode = () => data.onSelect(version.id);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={accessibleName}
      aria-pressed={selected}
      onClick={selectNode}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectNode();
        }
      }}
      className={cx(
        "pb-history-node relative w-[232px] rounded-xl border bg-panel p-3 text-left shadow-lg shadow-black/10 transition-colors",
        data.isCurrent ? "border-accent/70 bg-accent-soft/50" : "border-line-strong",
        data.isViewing && "ring-1 ring-accent/45",
        selected && "ring-2 ring-accent",
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-ink-faint" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-ink-faint" />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-ink" title={version.displayLabel}>
              {version.displayLabel}
            </span>
            {data.isCurrent && (
              <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-medium text-accent">
                Current
              </span>
            )}
            {data.isViewing && <span className="shrink-0 text-[10px] font-medium text-success">Viewing</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-faint">
            <GitBranch size={11} aria-hidden="true" />
            <span className="truncate" title={version.branchName}>
              {version.branchName}
            </span>
          </div>
        </div>
        <input
          type="checkbox"
          checked={data.isCompareSelected}
          onChange={() => data.onToggleCompare(version.id)}
          onClick={(event) => event.stopPropagation()}
          aria-label={`Select ${version.displayLabel} to compare`}
          title="Select to compare"
          className="nodrag mt-0.5 shrink-0 accent-accent"
        />
      </div>
      <p className="mt-2 line-clamp-2 min-h-[2.25rem] text-[11px] leading-relaxed text-ink-dim">
        {version.changeNote ?? <span className="italic text-ink-faint">No change note</span>}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-ink-faint">
        <span>{relativeTime(version.createdAt)}</span>
        {data.rating && data.rating.overall !== null ? (
          <span className="flex items-center gap-1 text-ink-dim">
            <Star size={10} className="text-star" fill="currentColor" aria-hidden="true" />
            {data.rating.overall.toFixed(1)} · {data.rating.count}
          </span>
        ) : (
          <span>Not rated</span>
        )}
      </div>
    </div>
  );
}

const historyNodeTypes = { historyVersion: HistoryVersionNode };

function useReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function HistoryGraphControls({ graphKey }: { graphKey: string }) {
  const { fitView, zoomIn, zoomOut } = useReactFlow<HistoryGraphNode>();
  const reducedMotion = useReducedMotion();
  const fitOptions = {
    padding: 0.18,
    minZoom: 0.45,
    maxZoom: 1.15,
    duration: reducedMotion ? 0 : 200,
  };

  useEffect(() => {
    void fitView(fitOptions);
    // The graph key deliberately excludes selection, ratings, and timestamps.
    // Those changes must not take control of a user's current viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey]);

  return (
    <div
      role="group"
      aria-label="Graph controls"
      className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-1 rounded-lg border border-line bg-panel/95 p-1 shadow-lg shadow-black/15"
    >
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => void zoomOut({ duration: reducedMotion ? 0 : 120 })}
        className="pointer-events-auto rounded-md p-2 text-ink-dim transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => void zoomIn({ duration: reducedMotion ? 0 : 120 })}
        className="pointer-events-auto rounded-md p-2 text-ink-dim transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Plus size={14} />
      </button>
      <button
        type="button"
        aria-label="Fit graph"
        title="Fit graph"
        onClick={() => void fitView(fitOptions)}
        className="pointer-events-auto rounded-md p-2 text-ink-dim transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Maximize2 size={14} />
      </button>
    </div>
  );
}

export interface HistoryGraphViewProps {
  prompt: PromptDetail;
  versions: readonly VersionDto[];
  ratingsByVersion: Readonly<Record<string, RatingSummaryDto>> | undefined;
  viewingVersionId: string | null;
  selectedVersionId: string | null;
  compareSelection: readonly string[];
  onSelect(versionId: string): void;
  onToggleCompare(versionId: string): void;
  actions: HistoryVersionActionHandlers;
}

function toReactFlowNode(
  model: HistoryGraphNodeModel,
  prompt: PromptDetail,
  viewingVersionId: string | null,
  selectedVersionId: string | null,
  compareSelection: readonly string[],
  ratingsByVersion: Readonly<Record<string, RatingSummaryDto>> | undefined,
  onSelect: (versionId: string) => void,
  onToggleCompare: (versionId: string) => void,
): HistoryGraphNode {
  return {
    id: model.id,
    type: "historyVersion",
    position: model.position,
    selected: model.id === selectedVersionId,
    data: {
      version: model.version,
      isCurrent: model.version.id === prompt.currentVersionId,
      isViewing: model.version.id === viewingVersionId,
      isCompareSelected: compareSelection.includes(model.version.id),
      rating: ratingsByVersion?.[model.version.id],
      onSelect,
      onToggleCompare,
    },
  };
}

export function HistoryGraphView({
  prompt,
  versions,
  ratingsByVersion,
  viewingVersionId,
  selectedVersionId,
  compareSelection,
  onSelect,
  onToggleCompare,
  actions,
}: HistoryGraphViewProps) {
  const graph = useMemo(() => buildHistoryGraph(versions), [versions]);
  const graphKey = graph.nodes.map((node) => node.id).join("|");
  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? null;
  const nodes = useMemo(
    () =>
      graph.nodes.map((node) =>
        toReactFlowNode(
          node,
          prompt,
          viewingVersionId,
          selectedVersionId,
          compareSelection,
          ratingsByVersion,
          onSelect,
          onToggleCompare,
        ),
      ),
    [compareSelection, graph.nodes, onSelect, onToggleCompare, prompt, ratingsByVersion, selectedVersionId, viewingVersionId],
  );
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.kind === "variation" ? "smoothstep" : "default",
        className: edge.kind === "variation" ? "pb-history-edge-variation" : "pb-history-edge-continuation",
        selectable: false,
      })),
    [graph.edges],
  );

  if (versions.length === 0) {
    return <EmptyState icon={<HistoryGraphIcon />} title="No versions yet" />;
  }

  return (
    <div
      className="pb-history-graph flex min-h-0 flex-1 flex-col overflow-hidden bg-app"
      role="region"
      aria-label={`History graph for ${prompt.title}`}
    >
      {selectedVersion && (
        <div
          data-selected-version-actions
          role="region"
          aria-label="Selected version actions"
          className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-4 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Selected version</div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
              <span className="font-semibold text-ink">{selectedVersion.displayLabel}</span>
              <span className="text-ink-faint">· {selectedVersion.branchName}</span>
              <span className="text-ink-faint">· {relativeTime(selectedVersion.createdAt)}</span>
              {selectedVersion.changeNote && (
                <span className="min-w-0 truncate text-ink-dim" title={selectedVersion.changeNote}>
                  · {selectedVersion.changeNote}
                </span>
              )}
            </div>
          </div>
          <HistoryVersionActions
            version={selectedVersion}
            isCurrent={selectedVersion.id === prompt.currentVersionId}
            alwaysVisible
            {...actions}
          />
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          role="group"
          aria-label="Graph legend"
          className="pb-history-graph-legend pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-3 rounded-lg border border-line bg-panel/95 px-2.5 py-2 text-[10px] text-ink-faint shadow-lg shadow-black/10"
        >
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-px w-4 bg-line-strong" />
            Continuation
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="w-4 border-t border-dashed border-accent" />
            Variation
          </span>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={historyNodeTypes}
          className="pb-history-flow"
          fitView
          fitViewOptions={{ padding: 0.18, minZoom: 0.45, maxZoom: 1.15 }}
          minZoom={0.35}
          maxZoom={1.75}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          deleteKeyCode={null}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <HistoryGraphControls graphKey={graphKey} />
        </ReactFlow>
      </div>
    </div>
  );
}

function HistoryGraphIcon() {
  return <GitBranch size={16} />;
}
