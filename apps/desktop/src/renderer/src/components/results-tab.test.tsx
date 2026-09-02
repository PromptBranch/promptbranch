// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { PromptDetail, RunGroupDto } from "../../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { ResultsTab } from "./ResultsTab";

const prompt: PromptDetail = {
  id: "prompt-1",
  title: "QA prompt",
  description: null,
  icon: null,
  isStarred: false,
  versionLabel: "v1",
  tags: [],
  createdAt: "2026-09-02T09:00:00.000Z",
  updatedAt: "2026-09-02T09:00:00.000Z",
  deletedAt: null,
  currentVersionId: "version-1",
  draftContent: null,
  collectionIds: [],
};

const group: RunGroupDto = {
  runGroupId: "group-1",
  createdAt: "2026-09-02T09:10:00.000Z",
  runs: [
    {
      id: "run-1",
      versionId: "version-1",
      provider: "provider-1",
      providerName: "Provider",
      model: "model-a",
      status: "completed",
      outcomeRating: 4,
      output: "Answer",
      error: null,
      latencyMs: 100,
      usage: null,
      costUsd: null,
      judgeRationale: "Good",
      judgeScores: { effectiveness: 4, clarity: 4, completeness: 4, actionability: 4 },
      createdAt: "2026-09-02T09:10:00.000Z",
    },
    {
      id: "run-2",
      versionId: "version-1",
      provider: "provider-1",
      providerName: "Provider",
      model: "model-b",
      status: "error",
      outcomeRating: null,
      output: null,
      error: "Failed",
      latencyMs: null,
      usage: null,
      costUsd: null,
      judgeRationale: null,
      judgeScores: null,
      createdAt: "2026-09-02T09:10:01.000Z",
    },
  ],
};

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
  let groups = [group];
  bridge.ai.runGroups.mockImplementation(async () => groups);
  bridge.runs.list.mockResolvedValue([]);
  bridge.runs.delete.mockImplementation(async (runId) => {
    groups = groups
      .map((item) => ({ ...item, runs: item.runs.filter((run) => run.id !== runId) }))
      .filter((item) => item.runs.length > 0);
  });
});

describe("ResultsTab", () => {
  it("deletes a whole model-run group from its visible card action", async () => {
    const user = userEvent.setup();
    renderApp(
      <ResultsTab
        prompt={prompt}
        currentVersionLabel="v1"
        onOpenRunGroup={() => undefined}
      />,
    );

    expect(await screen.findByText("model-a")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete model run" }));
    expect(screen.getByText(/permanently removes all 2 model results/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete model run" }));

    await waitFor(() => expect(screen.queryByText("model-a")).toBeNull());
    expect(screen.getAllByText("No runs recorded")).toHaveLength(2);
  });
});
