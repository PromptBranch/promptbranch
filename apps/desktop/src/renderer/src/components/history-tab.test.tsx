// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PromptDetail, VersionDto } from "../../../shared/ipc.js";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { HistoryTab } from "./HistoryTab";

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
