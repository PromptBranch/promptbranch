import { describe, expect, it } from "vitest";
import type { VersionDto } from "../../../shared/ipc.js";
import { buildHistoryGraph } from "./history-graph";

function version(
  overrides: Partial<VersionDto> & Pick<VersionDto, "id" | "branchId" | "branchName" | "number">,
): VersionDto {
  return {
    promptId: "prompt-1",
    parentVersionId: null,
    label: null,
    displayLabel: `v${overrides.number}`,
    changeNote: null,
    author: "user",
    createdAt: `2026-09-15T10:0${overrides.number}:00.000Z`,
    isCurrent: false,
    ...overrides,
  };
}

describe("buildHistoryGraph", () => {
  it("lays out a linear branch by version number and emits continuation edges", () => {
    const graph = buildHistoryGraph([
      version({ id: "main-2", branchId: "main", branchName: "main", number: 2, parentVersionId: "main-1" }),
      version({ id: "main-1", branchId: "main", branchName: "main", number: 1 }),
      version({ id: "main-3", branchId: "main", branchName: "main", number: 3, parentVersionId: "main-2" }),
    ]);

    expect(graph.nodes.map(({ id, lane, generation }) => ({ id, lane, generation }))).toEqual([
      { id: "main-1", lane: 0, generation: 0 },
      { id: "main-2", lane: 0, generation: 1 },
      { id: "main-3", lane: 0, generation: 2 },
    ]);
    expect(graph.edges).toEqual([
      { id: "main-1->main-2", source: "main-1", target: "main-2", kind: "continuation" },
      { id: "main-2->main-3", source: "main-2", target: "main-3", kind: "continuation" },
    ]);
    expect(graph.nodes[0]?.position.x).toBeLessThan(graph.nodes[1]?.position.x ?? 0);
    expect(graph.nodes[1]?.position.x).toBeLessThan(graph.nodes[2]?.position.x ?? 0);
  });

  it("keeps branch lanes stable and marks variation edges", () => {
    const graph = buildHistoryGraph([
      version({ id: "main-1", branchId: "main", branchName: "main", number: 1 }),
      version({ id: "main-2", branchId: "main", branchName: "main", number: 2, parentVersionId: "main-1" }),
      version({
        id: "concise-1",
        branchId: "concise",
        branchName: "concise",
        number: 1,
        parentVersionId: "main-2",
      }),
      version({
        id: "strict-1",
        branchId: "strict",
        branchName: "strict",
        number: 1,
        parentVersionId: "main-1",
      }),
    ]);

    expect(graph.nodes.map(({ id, lane, generation }) => ({ id, lane, generation }))).toEqual([
      { id: "main-1", lane: 0, generation: 0 },
      { id: "main-2", lane: 0, generation: 1 },
      { id: "concise-1", lane: 1, generation: 2 },
      { id: "strict-1", lane: 2, generation: 1 },
    ]);
    expect(graph.edges.filter((edge) => edge.kind === "variation")).toEqual([
      { id: "main-2->concise-1", source: "main-2", target: "concise-1", kind: "variation" },
      { id: "main-1->strict-1", source: "main-1", target: "strict-1", kind: "variation" },
    ]);
  });

  it("uses actual parentage when a new same-branch version starts from history", () => {
    const graph = buildHistoryGraph([
      version({ id: "main-1", branchId: "main", branchName: "main", number: 1 }),
      version({ id: "main-2", branchId: "main", branchName: "main", number: 2, parentVersionId: "main-1" }),
      version({ id: "main-3", branchId: "main", branchName: "main", number: 3, parentVersionId: "main-2" }),
      version({ id: "main-4", branchId: "main", branchName: "main", number: 4, parentVersionId: "main-1" }),
    ]);

    expect(graph.edges).toContainEqual({
      id: "main-1->main-4",
      source: "main-1",
      target: "main-4",
      kind: "continuation",
    });
    expect(graph.edges).not.toContainEqual({
      id: "main-3->main-4",
      source: "main-3",
      target: "main-4",
      kind: "continuation",
    });
    expect(graph.nodes.find((node) => node.id === "main-4")?.generation).toBe(3);
  });

  it("treats missing parents as roots and does not infer edges across number gaps", () => {
    const graph = buildHistoryGraph([
      version({ id: "main-1", branchId: "main", branchName: "main", number: 1 }),
      version({ id: "main-3", branchId: "main", branchName: "main", number: 3, parentVersionId: "missing" }),
      version({ id: "main-4", branchId: "main", branchName: "main", number: 4, parentVersionId: "main-3" }),
    ]);

    expect(graph.edges).toEqual([
      { id: "main-3->main-4", source: "main-3", target: "main-4", kind: "continuation" },
    ]);
    expect(graph.nodes.find((node) => node.id === "main-3")?.generation).toBe(1);
  });

  it("keeps the first duplicate ID and remains finite for parent cycles", () => {
    const graph = buildHistoryGraph([
      version({ id: "a", branchId: "main", branchName: "main", number: 1, parentVersionId: "b" }),
      version({ id: "b", branchId: "main", branchName: "main", number: 2, parentVersionId: "a" }),
      version({ id: "a", branchId: "other", branchName: "other", number: 1 }),
    ]);

    expect(graph.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(graph.edges).toEqual([]);
    expect(graph.nodes.every((node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(true);
  });
});
