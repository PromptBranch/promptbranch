// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiJudgeResult, RunDto, RunGroupDto } from "../../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import {
  fromStoredGroup,
  placeholderGroup,
  RunCompareView,
  type CompareGroup,
} from "./RunCompareView";

const settledStoredGroup: RunGroupDto = {
  runGroupId: "rg-1",
  createdAt: "2026-08-01T10:00:00Z",
  runs: [
    {
      id: "run-1",
      versionId: "v-1",
      provider: "prov-anth",
      providerName: "Anthropic",
      model: "claude-opus",
      status: "completed",
      outcomeRating: null,
      output: "Plain answer A",
      error: null,
      latencyMs: 812,
      usage: { inputTokens: 10, outputTokens: 20 },
      costUsd: 0.0012,
      judgeRationale: null,
      judgeScores: null,
      createdAt: "2026-08-01T10:00:01Z",
    },
    {
      id: "run-2",
      versionId: "v-1",
      provider: null,
      providerName: null,
      model: null,
      status: "error",
      outcomeRating: 2,
      output: null,
      error: "Rate limited",
      latencyMs: null,
      usage: null,
      costUsd: null,
      judgeRationale: null,
      judgeScores: null,
      createdAt: "2026-08-01T10:00:02Z",
    },
  ],
};

/** A different stored group (rerender target for the stale-judge test). */
const otherStoredGroup: RunGroupDto = {
  runGroupId: "rg-2",
  createdAt: "2026-08-02T10:00:00Z",
  runs: [
    {
      id: "run-9",
      versionId: "v-1",
      provider: "prov-anth",
      providerName: "Anthropic",
      model: "claude-haiku",
      status: "completed",
      outcomeRating: null,
      output: "Other answer",
      error: null,
      latencyMs: 400,
      usage: null,
      costUsd: null,
      judgeRationale: null,
      judgeScores: null,
      createdAt: "2026-08-02T10:00:01Z",
    },
  ],
};

describe("fromStoredGroup", () => {
  it("maps stored runs and falls back for deleted providers/models", () => {
    const group = fromStoredGroup(settledStoredGroup);
    expect(group.runGroupId).toBe("rg-1");
    expect(group.versionId).toBe("v-1"); // taken from the first run
    expect(group.runs).toHaveLength(2);
    expect(group.runs[0]).toMatchObject({
      runId: "run-1",
      providerName: "Anthropic",
      modelId: "claude-opus",
      status: "completed",
      output: "Plain answer A",
    });
    expect(group.runs[1]).toMatchObject({
      runId: "run-2",
      providerId: null,
      providerName: "Deleted provider",
      modelId: "unknown",
      status: "error",
      error: "Rate limited",
      outcomeRating: 2,
    });
  });
});

describe("placeholderGroup", () => {
  it("creates one pending row per selected model, without run ids", () => {
    const group = placeholderGroup(
      [
        { providerId: "prov-anth", modelId: "claude-opus", providerName: "Anthropic" },
        { providerId: "prov-local", modelId: "llama-local", providerName: "Local box" },
      ],
      "v-9",
    );
    expect(group.runGroupId).toBe("");
    expect(group.versionId).toBe("v-9");
    expect(group.runs.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(group.runs.every((r) => r.runId === "" && r.output === null)).toBe(true);
  });
});

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
});

function renderCompare(group: CompareGroup, props: { live?: boolean; running?: boolean } = {}) {
  const onRerun = vi.fn();
  const onOpenChange = vi.fn();
  const view = renderApp(
    <RunCompareView
      group={group}
      promptId="prompt-1"
      promptTitle="Code review"
      versionLabel="v3"
      open
      onOpenChange={onOpenChange}
      running={props.running ?? false}
      live={props.live ?? false}
      onCancel={props.live ? vi.fn() : undefined}
      onRerun={onRerun}
      onChangeModels={vi.fn()}
    />,
  );
  const rerenderGroup = (next: CompareGroup) =>
    view.rerender(
      <RunCompareView
        group={next}
        promptId="prompt-1"
        promptTitle="Code review"
        versionLabel="v3"
        open
        onOpenChange={onOpenChange}
        running={props.running ?? false}
        live={props.live ?? false}
        onCancel={props.live ? vi.fn() : undefined}
        onRerun={onRerun}
        onChangeModels={vi.fn()}
      />,
    );
  return { onRerun, onOpenChange, rerenderGroup };
}

describe("RunCompareView", () => {
  it("renders a settled group: output column, error card and success summary", async () => {
    renderCompare(fromStoredGroup(settledStoredGroup));
    // Column headers with fallbacks for the deleted provider.
    expect(await screen.findByText("claude-opus")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(screen.getByText("Deleted provider")).toBeInTheDocument();
    // Status chips.
    expect(screen.getByText("Done · 812 ms")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    // Output rendered as Markdown, error in its card.
    expect(screen.getByText("Plain answer A")).toBeInTheDocument();
    expect(screen.getByText("Rate limited")).toBeInTheDocument();
    // Header summary.
    expect(screen.getByText(/1\/2 succeeded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("reruns only runs whose provider still exists", async () => {
    const user = userEvent.setup();
    const { onRerun } = renderCompare(fromStoredGroup(settledStoredGroup));
    await screen.findByText("claude-opus");
    await user.click(screen.getByRole("button", { name: /rerun/i }));
    // The deleted-provider run (providerId null) is not rerunnable.
    expect(onRerun).toHaveBeenCalledWith([{ providerId: "prov-anth", modelId: "claude-opus" }]);
  });

  it("renders a pending group with Queued chips and no rateable rows", async () => {
    renderCompare(
      placeholderGroup(
        [
          { providerId: "prov-anth", modelId: "claude-opus", providerName: "Anthropic" },
          { providerId: "prov-local", modelId: "llama-local", providerName: "Local box" },
        ],
        "v-1",
      ),
      { live: true, running: true },
    );
    expect(await screen.findAllByText("Queued")).toHaveLength(2);
    expect(screen.getAllByText(/waiting to start/i)).toHaveLength(2);
    expect(screen.getByText(/running 0\/2/i)).toBeInTheDocument();
    // Live group has no runGroupId yet: Cancel stays disabled.
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    // No star rating for placeholder rows.
    expect(screen.queryByRole("button", { name: /stars?$/i })).toBeNull();
  });

  it("saves an outcome rating through the bridge", async () => {
    const user = userEvent.setup();
    bridge.runs.updateOutcome.mockResolvedValue({ id: "run-1" } as RunDto);
    renderCompare(fromStoredGroup(settledStoredGroup));
    await screen.findByText("claude-opus");
    await user.click(screen.getByRole("button", { name: "4 stars" }));
    await waitFor(() =>
      expect(bridge.runs.updateOutcome).toHaveBeenCalledWith({ runId: "run-1", outcomeRating: 4 }),
    );
  });

  it("saves a completed run's output as a note", async () => {
    const user = userEvent.setup();
    bridge.notes.add.mockResolvedValue({ id: "note-1" } as never);
    renderCompare(fromStoredGroup(settledStoredGroup));
    await screen.findByText("claude-opus");
    await user.click(screen.getByRole("button", { name: "Save as note" }));
    await waitFor(() => {
      expect(bridge.notes.add).toHaveBeenCalledTimes(1);
      const input = bridge.notes.add.mock.calls[0]![0];
      expect(input.promptId).toBe("prompt-1");
      expect(input.versionId).toBe("v-1");
      expect(input.body).toContain("Model output — claude-opus");
      expect(input.body).toContain("Plain answer A");
    });
  });

  it("deletes one persisted model result and closes after the last result", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderCompare(fromStoredGroup(settledStoredGroup));
    await screen.findByText("claude-opus");

    await user.click(screen.getByRole("button", { name: "Delete claude-opus result" }));
    await user.click(screen.getByRole("button", { name: "Delete result" }));
    await waitFor(() => expect(bridge.runs.delete).toHaveBeenCalledWith("run-1"));
    expect(screen.queryByText("Plain answer A")).toBeNull();
    expect(screen.getByText("Rate limited")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await user.click(screen.getByRole("button", { name: "Delete unknown result" }));
    await user.click(screen.getByRole("button", { name: "Delete result" }));
    await waitFor(() => expect(bridge.runs.delete).toHaveBeenCalledWith("run-2"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("RunCompareView judging", () => {
  const judgeProvider = {
    id: "prov-local",
    type: "openai-compatible",
    driver: "openai-compatible",
    name: "Local stub",
    baseUrl: "http://127.0.0.1:1234/v1",
    enabled: true,
    hasApiKey: false,
    createdAt: "2026-08-01T09:00:00Z",
    models: [{ modelId: "judge-model", displayName: null, enabled: true }],
  } as const;

  const judgeResult = {
    results: [
      {
        runId: "run-1",
        modelId: "claude-opus",
        scores: { effectiveness: 5, clarity: 4, completeness: 4, actionability: 4 },
        rationale: "Clear and complete answer.",
      },
    ],
    skipped: [{ runId: "run-2", modelId: null, reason: "Rate limited" }],
    failures: [],
  };

  async function runJudgeFlow(user: ReturnType<typeof userEvent.setup>) {
    bridge.ai.providers.list.mockResolvedValue([judgeProvider] as never);
    bridge.ai.judge.mockResolvedValue(judgeResult as never);
    renderCompare(fromStoredGroup(settledStoredGroup));
    await screen.findByText("claude-opus");
    await user.click(screen.getByRole("button", { name: /judge with ai/i }));
    // Pick the judge model in the single-select picker.
    await user.click(await screen.findByRole("button", { name: /select model/i }));
    await user.click(await screen.findByRole("option", { name: /judge-model/i }));
    await user.click(screen.getByRole("button", { name: /run judge/i }));
    await screen.findByText("4.3");
  }

  it("keeps Run judge disabled until a model is committed, and closes the picker on select", async () => {
    const user = userEvent.setup();
    bridge.ai.providers.list.mockResolvedValue([judgeProvider] as never);
    renderCompare(fromStoredGroup(settledStoredGroup));
    await screen.findByText("claude-opus");
    await user.click(screen.getByRole("button", { name: /judge with ai/i }));
    const runButton = screen.getByRole("button", { name: /run judge/i });
    expect(runButton).toBeDisabled();

    await user.click(await screen.findByRole("button", { name: /select model/i }));
    await user.click(await screen.findByRole("option", { name: /judge-model/i }));
    // Single-select commits the selection and closes the picker immediately.
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(runButton).toBeEnabled();
  });

  it("judges the group, shows score badges and applies them as ratings", async () => {
    const user = userEvent.setup();
    await runJudgeFlow(user);

    expect(bridge.ai.judge).toHaveBeenCalledWith({
      runGroupId: "rg-1",
      judge: { providerId: "prov-local", modelId: "judge-model" },
    });
    // Error column is skipped, not badged; the footer reports the skip.
    expect(screen.getAllByText("AI judge")).toHaveLength(1);
    expect(screen.getByText(/1 scored, 1 skipped · not saved until applied/)).toBeInTheDocument();
    // Badge expands to dimension scores + rationale.
    await user.click(screen.getByRole("button", { name: /4\.3/ }));
    expect(screen.getByText("Clear and complete answer.")).toBeInTheDocument();
    expect(screen.getByText("Effectiveness")).toBeInTheDocument();

    // No existing ratings on the scored run → applies without confirmation.
    bridge.runs.updateOutcome.mockResolvedValue({ id: "run-1" } as RunDto);
    bridge.runs.updateMetrics.mockResolvedValue({ id: "run-1" } as RunDto);
    await user.click(screen.getByRole("button", { name: /apply as ratings/i }));
    await waitFor(() =>
      expect(bridge.runs.updateOutcome).toHaveBeenCalledWith({ runId: "run-1", outcomeRating: 4.3 }),
    );
    // Rationale AND dimension scores are persisted into metrics_json.
    expect(bridge.runs.updateMetrics).toHaveBeenCalledWith({
      runId: "run-1",
      patch: {
        judgeRationale: "Clear and complete answer.",
        judgeScores: { effectiveness: 5, clarity: 4, completeness: 4, actionability: 4 },
      },
    });
    // After applying, the footer is gone but the badge stays (backed by the row).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /apply as ratings/i })).toBeNull(),
    );
    expect(screen.getByText("AI judge")).toBeInTheDocument();
  });

  it("renders the judge badge and rationale for a stored (previously applied) group", async () => {
    const user = userEvent.setup();
    const judgedGroup: RunGroupDto = {
      ...settledStoredGroup,
      runs: [
        {
          ...settledStoredGroup.runs[0]!,
          outcomeRating: 4.3,
          judgeRationale: "Stored rationale.",
          judgeScores: { effectiveness: 5, clarity: 4, completeness: 4, actionability: 4 },
        },
        settledStoredGroup.runs[1]!,
      ],
    };
    renderCompare(fromStoredGroup(judgedGroup));
    await screen.findByText("claude-opus");
    // Badge from stored metrics — no fresh judging needed, no apply footer.
    await user.click(screen.getByRole("button", { name: /4\.3/ }));
    expect(screen.getByText("Stored rationale.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply as ratings/i })).toBeNull();
  });

  it("drops judge results when the group changed mid-judge", async () => {
    const user = userEvent.setup();
    bridge.ai.providers.list.mockResolvedValue([judgeProvider] as never);
    let resolveJudge!: (result: AiJudgeResult) => void;
    bridge.ai.judge.mockImplementation(
      () => new Promise<AiJudgeResult>((resolve) => { resolveJudge = resolve; }),
    );
    const { rerenderGroup } = renderCompare(fromStoredGroup(settledStoredGroup));
    await screen.findByText("claude-opus");
    await user.click(screen.getByRole("button", { name: /judge with ai/i }));
    await user.click(await screen.findByRole("button", { name: /select model/i }));
    await user.click(await screen.findByRole("option", { name: /judge-model/i }));
    await user.click(screen.getByRole("button", { name: /run judge/i }));

    // The user switches to another group while the judge is in flight.
    rerenderGroup(fromStoredGroup(otherStoredGroup));
    await screen.findByText("claude-haiku");
    resolveJudge(judgeResult);

    expect(await screen.findByText(/judge results discarded/i)).toBeInTheDocument();
    // The stale scores never land on the newly visible group.
    expect(screen.queryByText("AI judge")).toBeNull();
    expect(screen.queryByRole("button", { name: /apply as ratings/i })).toBeNull();
  });

  it("confirms before overwriting existing outcome ratings", async () => {
    const user = userEvent.setup();
    const ratedGroup: RunGroupDto = {
      ...settledStoredGroup,
      runs: [{ ...settledStoredGroup.runs[0]!, outcomeRating: 2 }, settledStoredGroup.runs[1]!],
    };
    bridge.ai.providers.list.mockResolvedValue([judgeProvider] as never);
    bridge.ai.judge.mockResolvedValue(judgeResult as never);
    renderCompare(fromStoredGroup(ratedGroup));
    await screen.findByText("claude-opus");
    await user.click(screen.getByRole("button", { name: /judge with ai/i }));
    await user.click(await screen.findByRole("button", { name: /select model/i }));
    await user.click(await screen.findByRole("option", { name: /judge-model/i }));
    await user.click(screen.getByRole("button", { name: /run judge/i }));
    await screen.findByText("4.3");

    await user.click(screen.getByRole("button", { name: /apply as ratings/i }));
    expect(bridge.runs.updateOutcome).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Apply ratings" }));
    await waitFor(() => expect(bridge.runs.updateOutcome).toHaveBeenCalled());
  });

  it("shows 'Judge failed' for runs the judge could not score", async () => {
    const user = userEvent.setup();
    bridge.ai.providers.list.mockResolvedValue([judgeProvider] as never);
    bridge.ai.judge.mockResolvedValue({
      results: [],
      skipped: [{ runId: "run-2", modelId: null, reason: "Rate limited" }],
      failures: [{ runId: "run-1", modelId: "claude-opus", error: "Judge returned malformed JSON" }],
    } as never);
    renderCompare(fromStoredGroup(settledStoredGroup));
    await screen.findByText("claude-opus");
    await user.click(screen.getByRole("button", { name: /judge with ai/i }));
    await user.click(await screen.findByRole("button", { name: /select model/i }));
    await user.click(await screen.findByRole("option", { name: /judge-model/i }));
    await user.click(screen.getByRole("button", { name: /run judge/i }));
    expect(await screen.findByText("Judge failed")).toBeInTheDocument();
    // Nothing scored → no apply footer.
    expect(screen.queryByRole("button", { name: /apply as ratings/i })).toBeNull();
  });
});
