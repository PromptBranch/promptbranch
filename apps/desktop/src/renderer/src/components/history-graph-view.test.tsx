// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { PromptDetail, VersionDto } from "../../../shared/ipc.js";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { HistoryGraphView } from "./HistoryGraphView";

const flowControls = vi.hoisted(() => ({
  fitView: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
}));

vi.mock("@xyflow/react", () => ({
  Background: () => <div data-testid="graph-background" />,
  BackgroundVariant: { Dots: "dots" },
  Handle: () => <span data-testid="graph-handle" />,
  Position: { Left: "left", Right: "right" },
  ReactFlow: ({ children, nodes, nodeTypes, ...props }: any) => (
    <div
      data-testid="react-flow"
      data-nodes-draggable={String(props.nodesDraggable)}
      data-nodes-connectable={String(props.nodesConnectable)}
      data-pan-on-drag={String(props.panOnDrag)}
    >
      {nodes.map((node: any) => {
        const Node = nodeTypes[node.type];
        return <Node key={node.id} {...node} selected={node.selected} />;
      })}
      {children}
    </div>
  ),
  useReactFlow: () => flowControls,
}));

const prompt: PromptDetail = {
  id: "prompt-1",
  title: "Greeting",
  description: null,
  icon: null,
  isStarred: false,
  versionLabel: "v2",
  tags: [],
  createdAt: "2026-08-01T09:00:00Z",
  updatedAt: "2026-08-01T10:00:00Z",
  deletedAt: null,
  currentVersionId: "v-2",
  draftContent: null,
  draftBaseVersionId: null,
  collectionIds: [],
};

const versions: VersionDto[] = [
  {
    id: "v-1",
    promptId: prompt.id,
    branchId: "main",
    branchName: "main",
    parentVersionId: null,
    number: 1,
    label: null,
    displayLabel: "v1",
    changeNote: "Initial prompt",
    author: "user",
    createdAt: "2026-08-01T09:00:00Z",
    isCurrent: false,
  },
  {
    id: "v-2",
    promptId: prompt.id,
    branchId: "main",
    branchName: "main",
    parentVersionId: "v-1",
    number: 2,
    label: null,
    displayLabel: "v2",
    changeNote: "Current prompt",
    author: "user",
    createdAt: "2026-08-01T10:00:00Z",
    isCurrent: true,
  },
  {
    id: "v-variation",
    promptId: prompt.id,
    branchId: "friendly",
    branchName: "friendly",
    parentVersionId: "v-2",
    number: 1,
    label: null,
    displayLabel: "friendly v1",
    changeNote: null,
    author: "user",
    createdAt: "2026-08-01T11:00:00Z",
    isCurrent: false,
  },
];

const actions = {
  onView: vi.fn(),
  onSetCurrent: vi.fn(),
  onDuplicate: vi.fn(),
  onDuplicateAsPrompt: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
};

beforeEach(() => {
  installMockBridge();
  vi.clearAllMocks();
});

it("renders every version with current and viewing state", () => {
  renderApp(
    <HistoryGraphView
      prompt={prompt}
      versions={versions}
      ratingsByVersion={undefined}
      viewingVersionId="v-1"
      selectedVersionId="v-1"
      compareSelection={[]}
      onSelect={vi.fn()}
      onToggleCompare={vi.fn()}
      actions={actions}
    />,
  );

  expect(screen.getByText("v1")).toBeInTheDocument();
  expect(screen.getByText("v2")).toBeInTheDocument();
  expect(screen.getByText("friendly v1")).toBeInTheDocument();
  expect(screen.getByText("Current")).toBeInTheDocument();
  expect(screen.getByText("Viewing")).toBeInTheDocument();
  expect(screen.getAllByText("main").length).toBeGreaterThan(0);
  expect(screen.getByText("friendly")).toBeInTheDocument();
});

it("selects a node with click or keyboard without opening the editor", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const onView = vi.fn();
  renderApp(
    <HistoryGraphView
      prompt={prompt}
      versions={versions}
      ratingsByVersion={undefined}
      viewingVersionId={null}
      selectedVersionId={null}
      compareSelection={[]}
      onSelect={onSelect}
      onToggleCompare={vi.fn()}
      actions={{ ...actions, onView }}
    />,
  );

  const node = screen.getByRole("button", { name: /v2.*main/i });
  await user.click(node);
  fireEvent.keyDown(node, { key: "Enter" });
  fireEvent.keyDown(node, { key: " " });

  expect(onSelect).toHaveBeenCalledWith("v-2");
  expect(onView).not.toHaveBeenCalled();
});

it("keeps compare checkboxes independent from node selection", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const onToggleCompare = vi.fn();
  renderApp(
    <HistoryGraphView
      prompt={prompt}
      versions={versions}
      ratingsByVersion={undefined}
      viewingVersionId={null}
      selectedVersionId={null}
      compareSelection={["v-1"]}
      onSelect={onSelect}
      onToggleCompare={onToggleCompare}
      actions={actions}
    />,
  );

  const checkbox = screen.getByRole("checkbox", { name: "Select v2 to compare" });
  expect(checkbox).not.toBeChecked();
  await user.click(checkbox);

  expect(onToggleCompare).toHaveBeenCalledWith("v-2");
  expect(onSelect).not.toHaveBeenCalled();
});

it("wires labeled zoom and fit controls and disables node editing", async () => {
  const user = userEvent.setup();
  renderApp(
    <HistoryGraphView
      prompt={prompt}
      versions={versions}
      ratingsByVersion={undefined}
      viewingVersionId={null}
      selectedVersionId={null}
      compareSelection={[]}
      onSelect={vi.fn()}
      onToggleCompare={vi.fn()}
      actions={actions}
    />,
  );

  expect(screen.getByTestId("react-flow")).toHaveAttribute("data-nodes-draggable", "false");
  expect(screen.getByTestId("react-flow")).toHaveAttribute("data-nodes-connectable", "false");
  expect(screen.getByTestId("react-flow")).toHaveAttribute("data-pan-on-drag", "true");

  await user.click(screen.getByRole("button", { name: "Zoom in" }));
  await user.click(screen.getByRole("button", { name: "Zoom out" }));
  await user.click(screen.getByRole("button", { name: "Fit graph" }));

  expect(flowControls.zoomIn).toHaveBeenCalledTimes(1);
  expect(flowControls.zoomOut).toHaveBeenCalledTimes(1);
  expect(flowControls.fitView).toHaveBeenCalled();
});

it("renders the existing empty state when there are no versions", () => {
  renderApp(
    <HistoryGraphView
      prompt={prompt}
      versions={[]}
      ratingsByVersion={undefined}
      viewingVersionId={null}
      selectedVersionId={null}
      compareSelection={[]}
      onSelect={vi.fn()}
      onToggleCompare={vi.fn()}
      actions={actions}
    />,
  );

  expect(screen.getByText("No versions yet")).toBeInTheDocument();
});
