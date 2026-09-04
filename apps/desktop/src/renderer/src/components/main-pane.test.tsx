// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiProviderDto,
  AiRunGroupDto,
  PromptDetail,
  RunGroupDto,
  VersionDto,
} from "../../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { createTestQueryClient, renderApp } from "../test/render";
import { useAppState } from "../state/app-state";
import { MainPane } from "./MainPane";

vi.mock("@uiw/react-codemirror", () => ({
  default: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange: (value: string) => void;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label="Prompt editor"
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

// Render counter for the memoized Inspector: it renders TagEditor with the
// `compact` prop (the MainPane tag row does not), so each compact render
// means the Inspector function body ran.
const inspectorRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./TagEditor", () => ({
  TagEditor: ({ compact }: { compact?: boolean }) => {
    if (compact) inspectorRenders.count += 1;
    return null;
  },
}));

const prompt: PromptDetail = {
  id: "prompt-1",
  title: "Greeting",
  description: null,
  icon: null,
  isStarred: false,
  versionLabel: "v1",
  tags: [],
  createdAt: "2026-08-01T09:00:00Z",
  updatedAt: "2026-08-01T09:00:00Z",
  deletedAt: null,
  currentVersionId: "v-1",
  draftContent: null,
  collectionIds: [],
};

const version: VersionDto = {
  id: "v-1",
  promptId: "prompt-1",
  branchId: "branch-1",
  branchName: "main",
  parentVersionId: null,
  number: 1,
  label: null,
  displayLabel: "v1",
  changeNote: null,
  author: "user",
  createdAt: "2026-08-01T09:00:00Z",
  isCurrent: true,
};

const provider: AiProviderDto = {
  id: "prov-local",
  type: "openai-compatible",
  driver: "openai-compatible",
  name: "Local box",
  baseUrl: "http://127.0.0.1:1234/v1",
  enabled: true,
  hasApiKey: false,
  createdAt: "2026-08-01T09:00:00Z",
  models: [{ modelId: "model-live", displayName: null, enabled: true }],
};

const historyGroup: RunGroupDto = {
  runGroupId: "rg-hist",
  createdAt: "2026-08-01T10:00:00Z",
  runs: [
    {
      id: "run-hist",
      versionId: "v-1",
      provider: "prov-local",
      providerName: "Local box",
      model: "model-hist",
      status: "completed",
      outcomeRating: null,
      output: "history output",
      error: null,
      latencyMs: 100,
      usage: null,
      costUsd: null,
      judgeRationale: null,
      judgeScores: null,
      createdAt: "2026-08-01T10:00:01Z",
    },
  ],
};

const freshGroup: AiRunGroupDto = {
  runGroupId: "rg-live",
  promptId: "prompt-1",
  versionId: "v-1",
  createdAt: "2026-08-01T11:00:00Z",
  runs: [
    {
      runId: "run-live-1",
      providerId: "prov-local",
      providerName: "Local box",
      modelId: "model-live",
      status: "completed",
      output: "fresh output",
      error: null,
      latencyMs: 120,
      usage: { inputTokens: 5, outputTokens: 5 },
      costUsd: null,
    },
  ],
};

let bridge: MockBridge;
/** Resolves the in-flight ai:run invoke. */
let finishRun: (group: AiRunGroupDto) => void;

beforeEach(() => {
  // Per-prompt model selections persist in localStorage — reset between tests.
  localStorage.clear();
  bridge = installMockBridge();
  bridge.versions.list.mockResolvedValue([version]);
  // versions.get stays at its default null: the editor shows a spinner and
  // the run falls back to empty content (keeps CodeMirror out of jsdom).
  bridge.ai.providers.list.mockResolvedValue([provider]);
  bridge.ai.catalog.get.mockResolvedValue(null);
  bridge.ai.runGroups.mockResolvedValue([historyGroup]);
  bridge.runs.list.mockResolvedValue([]);
  bridge.ai.run.mockImplementation(
    () => new Promise<AiRunGroupDto>((resolve) => { finishRun = resolve; }),
  );
});

/** Selects model-live in the picker and clicks Run. */
async function startRun(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /select models/i }));
  await user.click(await screen.findByRole("option", { name: /model-live/i }));
  await user.click(screen.getByRole("button", { name: "Run" }));
}

function HistoricalVersionControl({ versionId }: { versionId: string }) {
  const { setViewingVersionId } = useAppState();
  return <button onClick={() => setViewingVersionId(versionId)}>View historical version</button>;
}

describe("MainPane live run progress", () => {
  it("drives the live compare view through queued → streaming → completed", async () => {
    const user = userEvent.setup();
    renderApp(<MainPane prompt={prompt} />);
    await startRun(user);

    // Placeholder column opens immediately; no runGroupId yet → Cancel off.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/waiting to start/i)).toBeInTheDocument();
    // ("Running 0/1…" also appears on the Run button — scope to the dialog.)
    expect(within(dialog).getByText(/running 0\/1/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();

    // The queued event delivers the runGroupId at request time — Cancel works
    // before the first token (R6).
    act(() => {
      bridge.emitRunProgress({
        runGroupId: "rg-live",
        providerId: "prov-local",
        modelId: "model-live",
        phase: "queued",
      });
    });
    expect(screen.getByRole("button", { name: /cancel/i })).toBeEnabled();

    act(() => {
      bridge.emitRunProgress({
        runGroupId: "rg-live",
        providerId: "prov-local",
        modelId: "model-live",
        phase: "delta",
        text: "Hello wor",
      });
    });
    expect(await screen.findByText("Hello wor")).toBeInTheDocument();

    act(() => {
      bridge.emitRunProgress({
        runGroupId: "rg-live",
        providerId: "prov-local",
        modelId: "model-live",
        phase: "completed",
        text: "Hello world",
        latencyMs: 120,
        usage: { inputTokens: 5, outputTokens: 5 },
        costUsd: null,
      });
    });
    expect(await screen.findByText("Done · 120 ms")).toBeInTheDocument();

    // The invoke resolves last; the settled view replaces the live one.
    await act(async () => finishRun(freshGroup));
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByText(/1\/1 succeeded/)).toBeInTheDocument(),
    );
    expect(within(screen.getByRole("dialog")).getByText("fresh output")).toBeInTheDocument();
  });

  it("reopens a dismissed running evaluation and cancels the same run group", async () => {
    const user = userEvent.setup();
    renderApp(<MainPane prompt={prompt} />);
    await startRun(user);
    await screen.findByText(/waiting to start/i);

    act(() => {
      bridge.emitRunProgress({
        runGroupId: "rg-live",
        providerId: "prov-local",
        modelId: "model-live",
        phase: "queued",
      });
    });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText(/waiting to start/i)).toBeNull());

    const runningButton = screen.getByRole("button", { name: /running 0\/1/i });
    expect(runningButton).toBeEnabled();
    await user.click(runningButton);

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(bridge.ai.runCancel).toHaveBeenCalledWith({ runGroupId: "rg-live" }),
    );
  });

  it("does not re-render the memoized Inspector on streamed deltas", async () => {
    const user = userEvent.setup();
    renderApp(<MainPane prompt={prompt} />);
    await startRun(user);
    await screen.findByText(/waiting to start/i);
    act(() => {
      bridge.emitRunProgress({
        runGroupId: "rg-live",
        providerId: "prov-local",
        modelId: "model-live",
        phase: "queued",
      });
    });
    // Let the mount/refetch renders settle, then snapshot the render count.
    await waitFor(() => expect(inspectorRenders.count).toBeGreaterThan(0));
    const before = inspectorRenders.count;

    // Streamed deltas re-render MainPane (live state lives there) but must
    // not propagate into the memoized Inspector (its props keep identity).
    for (const text of ["Hello", "Hello wor", "Hello world"]) {
      act(() => {
        bridge.emitRunProgress({
          runGroupId: "rg-live",
          providerId: "prov-local",
          modelId: "model-live",
          phase: "delta",
          text,
        });
      });
    }
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(inspectorRenders.count).toBe(before);
  });

  it("does not hijack an explicitly opened history group when a dismissed run finishes (R2)", async () => {
    const user = userEvent.setup();
    renderApp(<MainPane prompt={prompt} />);
    await startRun(user);
    await screen.findByText(/waiting to start/i);
    act(() => {
      bridge.emitRunProgress({
        runGroupId: "rg-live",
        providerId: "prov-local",
        modelId: "model-live",
        phase: "queued",
      });
    });

    // Dismiss the live view, then open a stored group from Results.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText(/waiting to start/i)).toBeNull());
    await user.click(screen.getByRole("tab", { name: /results/i }));
    await user.click(await screen.findByRole("button", { name: /model-hist/i }));
    expect(await screen.findByText("history output")).toBeInTheDocument();

    // The in-flight run completes: the open history group must stay put.
    await act(async () => finishRun(freshGroup));
    expect(screen.getByText("history output")).toBeInTheDocument();
    expect(screen.queryByText("fresh output")).toBeNull();
    expect(await screen.findByText(/open it from Results/i)).toBeInTheDocument();
  });
});

describe("MainPane share button", () => {
  it("opens the share dialog, which loads a scan preview", async () => {
    bridge.share.preview.mockResolvedValue({
      payload: {
        formatVersion: 1,
        title: "Greeting",
        content: "Say hi.",
        tags: [],
        publishedAt: "2026-08-26T12:00:00.000Z",
      },
      findings: [],
    });
    const user = userEvent.setup();
    renderApp(<MainPane prompt={{ ...prompt, draftContent: "Unsaved editor content" }} />);
    await user.click(screen.getByRole("button", { name: "Share prompt" }));
    expect(await screen.findByText('Share "Greeting"')).toBeInTheDocument();
    await waitFor(() =>
      expect(bridge.share.preview).toHaveBeenCalledWith({
        promptId: "prompt-1",
        includeHistory: false,
        content: "Unsaved editor content",
      }),
    );
  });

  it("shares the historical version currently displayed instead of the current draft", async () => {
    const historicalVersion: VersionDto = { ...version, isCurrent: false };
    const currentVersion: VersionDto = {
      ...version,
      id: "v-2",
      number: 2,
      displayLabel: "v2",
    };
    bridge.versions.list.mockResolvedValue([historicalVersion, currentVersion]);
    bridge.versions.get.mockImplementation(async (versionId) => ({
      ...(versionId === historicalVersion.id ? historicalVersion : currentVersion),
      content:
        versionId === historicalVersion.id ? "Historical content" : "Saved current content",
      contentFormat: "markdown",
    }));
    bridge.share.preview.mockImplementation(async (input) => ({
      payload: {
        formatVersion: 1,
        title: "Greeting",
        content: input.content ?? "Saved current content",
        tags: [],
        publishedAt: "2026-08-26T12:00:00.000Z",
      },
      findings: [],
    }));
    bridge.share.publish.mockResolvedValue({
      id: "V1StGXR8_Z5jdHi6B-myT",
      url: "https://promptbranch.app/p/V1StGXR8_Z5jdHi6B-myT",
    });
    const user = userEvent.setup();
    renderApp(
      <>
        <HistoricalVersionControl versionId={historicalVersion.id} />
        <MainPane
          prompt={{ ...prompt, currentVersionId: currentVersion.id, draftContent: "Current draft" }}
        />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "View historical version" }));
    expect(await screen.findByText("Historical content")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Share prompt" }));
    await waitFor(() =>
      expect(bridge.share.preview).toHaveBeenCalledWith({
        promptId: "prompt-1",
        includeHistory: false,
        content: "Historical content",
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/"content": "Historical content"/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Current draft/)).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(bridge.share.publish).toHaveBeenCalledWith({
        promptId: "prompt-1",
        includeHistory: false,
        content: "Historical content",
      }),
    );
  });

  it("disables sharing until the selected historical content has loaded", async () => {
    const historicalVersion: VersionDto = { ...version, isCurrent: false };
    const currentVersion: VersionDto = {
      ...version,
      id: "v-2",
      number: 2,
      displayLabel: "v2",
    };
    bridge.versions.list.mockResolvedValue([historicalVersion, currentVersion]);
    bridge.versions.get.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderApp(
      <>
        <HistoricalVersionControl versionId={historicalVersion.id} />
        <MainPane prompt={{ ...prompt, currentVersionId: currentVersion.id }} />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "View historical version" }));
    expect(screen.getByRole("button", { name: "Share prompt" })).toBeDisabled();
  });
});

describe("MainPane restored prompt editing", () => {
  it("autosaves an edit after restoring a trashed prompt without remounting the editor", async () => {
    bridge.versions.get.mockResolvedValue({
      ...version,
      content: "Persisted version",
      contentFormat: "markdown",
    });
    const trashedPrompt = { ...prompt, deletedAt: "2026-08-02T09:00:00Z" };
    const view = renderApp(<MainPane prompt={trashedPrompt} />);

    await screen.findByText("Persisted version");
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(bridge.prompts.restore).toHaveBeenCalledWith(prompt.id));

    view.rerender(<MainPane prompt={prompt} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const restoredEditor = screen.getByRole("textbox", { name: "Prompt editor" });
    fireEvent.change(restoredEditor, { target: { value: "Restored edit" } });
    view.unmount();

    await waitFor(() =>
      expect(bridge.drafts.set).toHaveBeenCalledWith(prompt.id, "Restored edit"),
    );
  });
});

describe("MainPane version actions", () => {
  it("duplicates the historical version being viewed into a new prompt", async () => {
    const historicalVersion: VersionDto = { ...version, isCurrent: false };
    const currentVersion: VersionDto = {
      ...version,
      id: "v-2",
      parentVersionId: historicalVersion.id,
      number: 2,
      displayLabel: "v2",
    };
    bridge.versions.list.mockResolvedValue([historicalVersion, currentVersion]);
    bridge.versions.get.mockImplementation(async (versionId) => ({
      ...(versionId === historicalVersion.id ? historicalVersion : currentVersion),
      content: versionId === historicalVersion.id ? "Historical content" : "Current content",
      contentFormat: "markdown",
    }));
    bridge.prompts.duplicate.mockResolvedValue({
      ...prompt,
      id: "prompt-copy",
      title: "Greeting standalone",
      currentVersionId: "copy-v1",
    });
    const user = userEvent.setup();
    renderApp(
      <>
        <HistoricalVersionControl versionId={historicalVersion.id} />
        <MainPane prompt={{ ...prompt, currentVersionId: currentVersion.id }} />
      </>,
    );

    fireEvent.mouseDown(await screen.findByRole("tab", { name: "History (2)" }), {
      button: 0,
      ctrlKey: false,
    });
    await user.click(await screen.findByRole("button", { name: "Duplicate v1 as new prompt" }));
    const title = await screen.findByLabelText("Title");
    expect(title).toHaveValue("Greeting copy");
    await user.clear(title);
    await user.type(title, "Greeting standalone");
    await user.click(screen.getByRole("button", { name: "Duplicate" }));

    await waitFor(() =>
      expect(bridge.prompts.duplicate).toHaveBeenCalledWith({
        promptId: prompt.id,
        versionId: historicalVersion.id,
        title: "Greeting standalone",
      }),
    );
  });

  it("renames the version being viewed", async () => {
    bridge.versions.updateLabel.mockResolvedValue({
      ...version,
      label: "Production",
      displayLabel: "Production",
    });
    const user = userEvent.setup();
    renderApp(<MainPane prompt={prompt} />);

    fireEvent.mouseDown(await screen.findByRole("tab", { name: "History (1)" }), {
      button: 0,
      ctrlKey: false,
    });
    await user.click(await screen.findByRole("button", { name: "Rename v1" }));
    await user.type(await screen.findByLabelText("Version name"), "Production");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(bridge.versions.updateLabel).toHaveBeenCalledWith(version.id, "Production");
  });

  it("clears a custom version name to restore its automatic label", async () => {
    const namedVersion = { ...version, label: "Production", displayLabel: "Production" };
    bridge.versions.list.mockResolvedValue([namedVersion]);
    bridge.versions.updateLabel.mockResolvedValue({ ...version, label: null, displayLabel: "v1" });
    const user = userEvent.setup();
    renderApp(<MainPane prompt={{ ...prompt, versionLabel: "Production" }} />);

    fireEvent.mouseDown(await screen.findByRole("tab", { name: "History (1)" }), {
      button: 0,
      ctrlKey: false,
    });
    await user.click(await screen.findByRole("button", { name: "Rename Production" }));
    const name = await screen.findByLabelText("Version name");
    expect(name).toHaveValue("Production");
    await user.clear(name);
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(bridge.versions.updateLabel).toHaveBeenCalledWith(version.id, null);
  });

  it("deletes a historical version from History but offers no delete action for current", async () => {
    const historicalVersion: VersionDto = { ...version, isCurrent: false };
    const currentVersion: VersionDto = {
      ...version,
      id: "v-2",
      parentVersionId: historicalVersion.id,
      number: 2,
      displayLabel: "v2",
    };
    bridge.versions.list.mockResolvedValue([historicalVersion, currentVersion]);
    const user = userEvent.setup();
    renderApp(<MainPane prompt={{ ...prompt, currentVersionId: currentVersion.id }} />);

    fireEvent.mouseDown(await screen.findByRole("tab", { name: "History (2)" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByRole("button", { name: "Delete v1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete v2" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete v1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/run results and ratings will be permanently removed/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/notes become prompt-level notes/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/published shares stay live/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete version" }));

    await waitFor(() => expect(bridge.versions.delete).toHaveBeenCalledWith(historicalVersion.id));
  });

  it("stays rendered when a version selected for comparison is deleted", async () => {
    const historicalVersion: VersionDto = { ...version, isCurrent: false };
    const currentVersion: VersionDto = {
      ...version,
      id: "v-2",
      parentVersionId: historicalVersion.id,
      number: 2,
      displayLabel: "v2",
    };
    const renumberedCurrent: VersionDto = {
      ...currentVersion,
      parentVersionId: null,
      number: 1,
      displayLabel: "v1",
    };
    let listedVersions = [historicalVersion, currentVersion];
    bridge.versions.list.mockImplementation(async () => listedVersions);
    bridge.versions.delete.mockImplementation(async () => {
      listedVersions = [renumberedCurrent];
    });
    const user = userEvent.setup();
    renderApp(<MainPane prompt={{ ...prompt, currentVersionId: currentVersion.id }} />);

    fireEvent.mouseDown(await screen.findByRole("tab", { name: "History (2)" }), {
      button: 0,
      ctrlKey: false,
    });
    await user.click(await screen.findByRole("checkbox", { name: "Select v1 to compare" }));
    expect(screen.getByText(/v1 selected — pick one more version to compare/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete v1" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete version" }));

    expect(await screen.findByRole("tab", { name: "History (1)" })).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.queryByText(/selected — pick one more version to compare/i)).toBeNull();
  });

  it("closes a version dialog when that version disappears during a refetch", async () => {
    const historicalVersion: VersionDto = { ...version, isCurrent: false };
    const currentVersion: VersionDto = {
      ...version,
      id: "v-2",
      parentVersionId: historicalVersion.id,
      number: 2,
      displayLabel: "v2",
    };
    let listedVersions = [historicalVersion, currentVersion];
    bridge.versions.list.mockImplementation(async () => listedVersions);
    const queryClient = createTestQueryClient();
    const user = userEvent.setup();
    renderApp(
      <>
        <HistoricalVersionControl versionId={historicalVersion.id} />
        <MainPane prompt={{ ...prompt, currentVersionId: currentVersion.id }} />
      </>,
      { queryClient },
    );

    await user.click(screen.getByRole("button", { name: "View historical version" }));
    await user.click(await screen.findByRole("button", { name: "Rate" }));
    expect(await screen.findByRole("dialog", { name: "Rate v1" })).toBeInTheDocument();

    listedVersions = [{ ...currentVersion, parentVersionId: null, number: 1, displayLabel: "v1" }];
    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rate v1" })).toBeNull());
  });

  it("closes History confirmation when its version disappears during a refetch", async () => {
    const historicalVersion: VersionDto = { ...version, isCurrent: false };
    const currentVersion: VersionDto = {
      ...version,
      id: "v-2",
      parentVersionId: historicalVersion.id,
      number: 2,
      displayLabel: "v2",
    };
    let listedVersions = [historicalVersion, currentVersion];
    bridge.versions.list.mockImplementation(async () => listedVersions);
    const queryClient = createTestQueryClient();
    const user = userEvent.setup();
    renderApp(<MainPane prompt={{ ...prompt, currentVersionId: currentVersion.id }} />, {
      queryClient,
    });

    fireEvent.mouseDown(await screen.findByRole("tab", { name: "History (2)" }), {
      button: 0,
      ctrlKey: false,
    });
    await user.click(await screen.findByRole("button", { name: "Set as current" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();

    listedVersions = [{ ...currentVersion, parentVersionId: null, number: 1, displayLabel: "v1" }];
    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("deletes the historical version being viewed and returns to current", async () => {
    const historicalVersion: VersionDto = { ...version, isCurrent: false };
    const currentVersion: VersionDto = {
      ...version,
      id: "v-2",
      parentVersionId: historicalVersion.id,
      number: 2,
      displayLabel: "v2",
    };
    bridge.versions.list.mockResolvedValue([historicalVersion, currentVersion]);
    bridge.versions.get.mockImplementation(async (versionId) => ({
      ...(versionId === historicalVersion.id ? historicalVersion : currentVersion),
      content: versionId === historicalVersion.id ? "Historical content" : "Current content",
      contentFormat: "markdown",
    }));
    const user = userEvent.setup();
    renderApp(
      <>
        <HistoricalVersionControl versionId={historicalVersion.id} />
        <MainPane prompt={{ ...prompt, currentVersionId: currentVersion.id }} />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "View historical version" }));
    expect(await screen.findByText("Historical content")).toBeInTheDocument();
    screen.getByRole("button", { name: "More actions" }).focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Delete version…" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete version" }),
    );

    await waitFor(() => expect(bridge.versions.delete).toHaveBeenCalledWith(historicalVersion.id));
    await waitFor(() => expect(screen.queryByText(/You're viewing/)).toBeNull());
  });
});
