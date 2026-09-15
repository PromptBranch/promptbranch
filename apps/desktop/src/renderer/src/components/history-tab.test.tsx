// @vitest-environment jsdom
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PromptDetail, VersionDto } from "../../../shared/ipc.js";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { HistoryTab } from "./HistoryTab";
import { HistoryVersionActions } from "./HistoryVersionActions";

vi.mock("./HistoryGraphView", () => ({
  HistoryGraphView: ({ compareSelection }: { compareSelection: string[] }) => (
    <div data-testid="history-graph-view">Graph selection: {compareSelection.join(",")}</div>
  ),
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

const historicalVersion: VersionDto = {
  id: "v-1",
  promptId: prompt.id,
  branchId: "branch-1",
  branchName: "main",
  parentVersionId: null,
  number: 1,
  label: null,
  displayLabel: "v1",
  changeNote: null,
  author: "user",
  createdAt: "2026-08-01T09:00:00Z",
  isCurrent: false,
};

const currentVersion: VersionDto = {
  id: "v-2",
  promptId: prompt.id,
  branchId: "branch-1",
  branchName: "main",
  parentVersionId: historicalVersion.id,
  number: 2,
  label: null,
  displayLabel: "v2",
  changeNote: "Current revision",
  author: "user",
  createdAt: "2026-08-01T10:00:00Z",
  isCurrent: true,
};

it("constrains the version actions to the card so they wrap instead of overflowing", async () => {
  installMockBridge();
  renderApp(
    <HistoryTab
      prompt={prompt}
      versions={[historicalVersion]}
      onView={vi.fn()}
      onCompare={vi.fn()}
      onDuplicate={vi.fn()}
      onDuplicateAsPrompt={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    />,
  );

  const actions = (await screen.findByRole("button", { name: "Delete v1" })).parentElement;
  expect(actions).not.toBeNull();
  expect(getComputedStyle(actions!).width).toBe("100%");
  expect(getComputedStyle(actions!).maxWidth).toBe("100%");
  expect(getComputedStyle(actions!).flexWrap).toBe("wrap");
});

it("keeps the list actions attached to the exact version card", async () => {
  const user = userEvent.setup();
  installMockBridge();
  const onView = vi.fn();
  const onDuplicate = vi.fn();
  const onDuplicateAsPrompt = vi.fn();
  const onRename = vi.fn();
  const onDelete = vi.fn();

  renderApp(
    <HistoryTab
      prompt={prompt}
      versions={[historicalVersion, currentVersion]}
      onView={onView}
      onCompare={vi.fn()}
      onDuplicate={onDuplicate}
      onDuplicateAsPrompt={onDuplicateAsPrompt}
      onRename={onRename}
      onDelete={onDelete}
    />,
  );

  await user.click(screen.getAllByRole("button", { name: "View" })[1]!);
  await user.click(screen.getByRole("button", { name: "Duplicate v1 as variation" }));
  await user.click(screen.getByRole("button", { name: "Duplicate v1 as new prompt" }));
  await user.click(screen.getByRole("button", { name: "Rename v1" }));
  await user.click(screen.getByRole("button", { name: "Delete v1" }));

  expect(onView).toHaveBeenCalledWith(historicalVersion.id);
  expect(onDuplicate).toHaveBeenCalledWith(historicalVersion);
  expect(onDuplicateAsPrompt).toHaveBeenCalledWith(historicalVersion);
  expect(onRename).toHaveBeenCalledWith(historicalVersion);
  expect(onDelete).toHaveBeenCalledWith(historicalVersion);
  expect(screen.queryByRole("button", { name: "Delete v2" })).not.toBeInTheDocument();
});

it("renders shared actions with current-version visibility rules", async () => {
  const user = userEvent.setup();
  const onView = vi.fn();
  const onSetCurrent = vi.fn();
  const onDuplicate = vi.fn();
  const onDuplicateAsPrompt = vi.fn();
  const onRename = vi.fn();
  const onDelete = vi.fn();

  renderApp(
    <HistoryVersionActions
      version={historicalVersion}
      isCurrent={false}
      onView={onView}
      onSetCurrent={onSetCurrent}
      onDuplicate={onDuplicate}
      onDuplicateAsPrompt={onDuplicateAsPrompt}
      onRename={onRename}
      onDelete={onDelete}
    />,
  );

  await user.click(screen.getByRole("button", { name: "View" }));
  await user.click(screen.getByRole("button", { name: "Set as current" }));
  await user.click(screen.getByRole("button", { name: "Duplicate v1 as variation" }));
  await user.click(screen.getByRole("button", { name: "Duplicate v1 as new prompt" }));
  await user.click(screen.getByRole("button", { name: "Rename v1" }));
  await user.click(screen.getByRole("button", { name: "Delete v1" }));

  expect(onView).toHaveBeenCalledWith(historicalVersion.id);
  expect(onSetCurrent).toHaveBeenCalledWith(historicalVersion);
  expect(onDuplicate).toHaveBeenCalledWith(historicalVersion);
  expect(onDuplicateAsPrompt).toHaveBeenCalledWith(historicalVersion);
  expect(onRename).toHaveBeenCalledWith(historicalVersion);
  expect(onDelete).toHaveBeenCalledWith(historicalVersion);
});

it("switches between List and Graph while preserving compare selection", async () => {
  const user = userEvent.setup();
  localStorage.clear();
  installMockBridge();
  renderApp(
    <HistoryTab
      prompt={prompt}
      versions={[historicalVersion, currentVersion]}
      onView={vi.fn()}
      onCompare={vi.fn()}
      onDuplicate={vi.fn()}
      onDuplicateAsPrompt={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("checkbox", { name: "Select v1 to compare" }));
  await user.click(screen.getByRole("button", { name: "Graph" }));

  expect(screen.getByTestId("history-graph-view")).toHaveTextContent("v-1");
  expect(localStorage.getItem("promptbuilder:pref:prompt-history-view")).toBe('"graph"');

  await user.click(screen.getByRole("button", { name: "List" }));
  expect(screen.getByRole("checkbox", { name: "Select v1 to compare" })).toBeChecked();
});

it("falls back to List for an invalid saved History view preference", () => {
  localStorage.setItem("promptbuilder:pref:prompt-history-view", JSON.stringify("diagonal"));
  installMockBridge();
  renderApp(
    <HistoryTab
      prompt={prompt}
      versions={[historicalVersion, currentVersion]}
      onView={vi.fn()}
      onCompare={vi.fn()}
      onDuplicate={vi.fn()}
      onDuplicateAsPrompt={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
});
