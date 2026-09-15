import type { VersionDto } from "../../../shared/ipc.js";

export type HistoryEdgeKind = "continuation" | "variation";

export interface HistoryGraphNodeModel {
  id: string;
  version: VersionDto;
  position: { x: number; y: number };
  lane: number;
  generation: number;
}

export interface HistoryGraphEdgeModel {
  id: string;
  source: string;
  target: string;
  kind: HistoryEdgeKind;
}

export interface HistoryGraphModel {
  nodes: HistoryGraphNodeModel[];
  edges: HistoryGraphEdgeModel[];
}

const NODE_WIDTH = 232;
const NODE_HEIGHT = 126;
const COLUMN_GAP = 92;
const LANE_GAP = 52;

function compareVersions(a: VersionDto, b: VersionDto): number {
  return a.number - b.number || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function findCyclicIds(versions: readonly VersionDto[], byId: ReadonlyMap<string, VersionDto>): Set<string> {
  const state = new Map<string, "unvisited" | "visiting" | "visited">();
  const stack: string[] = [];
  const cyclicIds = new Set<string>();

  const visit = (id: string): void => {
    const currentState = state.get(id);
    if (currentState === "visited") return;
    if (currentState === "visiting") {
      const cycleStart = stack.indexOf(id);
      for (const cycleId of stack.slice(cycleStart)) cyclicIds.add(cycleId);
      return;
    }

    state.set(id, "visiting");
    stack.push(id);
    const parentId = byId.get(id)?.parentVersionId;
    if (parentId && byId.has(parentId)) visit(parentId);
    stack.pop();
    state.set(id, "visited");
  };

  for (const version of versions) visit(version.id);
  return cyclicIds;
}

/**
 * Builds a deterministic, read-only layout for one prompt's active versions.
 * Parent IDs are the only source of edges; branch order is used solely for lanes
 * and to prevent same-lane nodes from overlapping when history is edited from
 * an older version.
 */
export function buildHistoryGraph(versions: readonly VersionDto[]): HistoryGraphModel {
  const uniqueVersions: VersionDto[] = [];
  const byId = new Map<string, VersionDto>();
  for (const version of versions) {
    if (byId.has(version.id)) continue;
    byId.set(version.id, version);
    uniqueVersions.push(version);
  }

  const branchOrder: string[] = [];
  const versionsByBranch = new Map<string, VersionDto[]>();
  for (const version of uniqueVersions) {
    let branchVersions = versionsByBranch.get(version.branchId);
    if (!branchVersions) {
      branchVersions = [];
      versionsByBranch.set(version.branchId, branchVersions);
      branchOrder.push(version.branchId);
    }
    branchVersions.push(version);
  }
  for (const branchVersions of versionsByBranch.values()) branchVersions.sort(compareVersions);

  const previousById = new Map<string, VersionDto>();
  for (const branchVersions of versionsByBranch.values()) {
    for (let index = 1; index < branchVersions.length; index += 1) {
      const version = branchVersions[index];
      const previous = branchVersions[index - 1];
      if (version && previous) previousById.set(version.id, previous);
    }
  }

  const cyclicIds = findCyclicIds(uniqueVersions, byId);
  const generationCache = new Map<string, number>();

  const resolveGeneration = (id: string): number => {
    const cached = generationCache.get(id);
    if (cached !== undefined) return cached;

    const version = byId.get(id);
    if (!version) return 0;

    const parent = version.parentVersionId ? byId.get(version.parentVersionId) : undefined;
    const parentGeneration = parent && !cyclicIds.has(id) ? resolveGeneration(parent.id) + 1 : 0;
    const previous = previousById.get(id);
    const previousGeneration = previous ? resolveGeneration(previous.id) + 1 : 0;
    const generation = Math.max(parentGeneration, previousGeneration);
    generationCache.set(id, generation);
    return generation;
  };

  const laneByBranch = new Map(branchOrder.map((branchId, lane) => [branchId, lane]));
  const nodes: HistoryGraphNodeModel[] = [];
  for (const branchId of branchOrder) {
    const lane = laneByBranch.get(branchId) ?? 0;
    for (const version of versionsByBranch.get(branchId) ?? []) {
      const generation = resolveGeneration(version.id);
      nodes.push({
        id: version.id,
        version,
        position: {
          x: generation * (NODE_WIDTH + COLUMN_GAP),
          y: lane * (NODE_HEIGHT + LANE_GAP),
        },
        lane,
        generation,
      });
    }
  }

  const edges: HistoryGraphEdgeModel[] = [];
  for (const version of uniqueVersions) {
    const parent = version.parentVersionId ? byId.get(version.parentVersionId) : undefined;
    if (!parent || cyclicIds.has(version.id) || cyclicIds.has(parent.id)) continue;
    edges.push({
      id: `${parent.id}->${version.id}`,
      source: parent.id,
      target: version.id,
      kind: parent.branchId === version.branchId ? "continuation" : "variation",
    });
  }

  return { nodes, edges };
}
