// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptDetail, VersionContentDto, VersionDto } from "../../../shared/ipc.js";
import { qk } from "../hooks/use-data";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { createTestQueryClient, renderApp } from "../test/render";
import { EditorTab } from "./EditorTab";

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

const promptA: PromptDetail = {
  id: "prompt-a",
  title: "Prompt A",
  description: null,
  icon: null,
  isStarred: false,
  versionLabel: "v1",
  tags: [],
  createdAt: "2026-08-01T09:00:00Z",
  updatedAt: "2026-08-01T09:00:00Z",
  deletedAt: null,
  currentVersionId: "version-a",
  draftContent: "Cached A draft",
  draftBaseVersionId: "version-a",
  collectionIds: [],
};

const versionA: VersionContentDto = {
  id: "version-a",
  promptId: "prompt-a",
  branchId: "branch-a",
  branchName: "main",
  parentVersionId: null,
  number: 1,
  label: null,
  displayLabel: "v1",
  changeNote: null,
  author: "user",
  createdAt: "2026-08-01T09:00:00Z",
  isCurrent: true,
  content: "Persisted A version",
  contentFormat: "markdown",
};

const promptB: PromptDetail = {
  ...promptA,
  id: "prompt-b",
  title: "Prompt B",
  currentVersionId: "version-b",
  draftContent: null,
  draftBaseVersionId: null,
};

const versionB: VersionContentDto = {
  ...versionA,
  id: "version-b",
  promptId: "prompt-b",
  branchId: "branch-b",
  content: "Persisted B version",
};

let bridge: MockBridge;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  bridge = installMockBridge();
});

describe("EditorTab draft durability", () => {
  it("does not apply a draft that belongs to another saved version", () => {
    renderApp(
      <EditorTab
        prompt={{ ...promptA, draftBaseVersionId: "version-other" }}
        version={versionA}
        isCurrent
      />,
    );

    expect(screen.getByRole("textbox", { name: "Prompt editor" })).toHaveValue(
      versionA.content,
    );
  });

  it("uses Command+S to amend the exact displayed version without opening a dialog", async () => {
    bridge.versions.updateContent.mockResolvedValue({
      ...versionA,
    });
    renderApp(<EditorTab prompt={promptA} version={versionA} isCurrent />);

    fireEvent.keyDown(window, { key: "s", metaKey: true });

    await waitFor(() =>
      expect(bridge.versions.updateContent).toHaveBeenCalledWith(
        versionA.id,
        promptA.draftContent,
      ),
    );
    expect(bridge.versions.create).not.toHaveBeenCalled();
    expect(screen.queryByText("Save as v2")).not.toBeInTheDocument();
  });

  it("keeps Save as new version as a separate exact-base flow", async () => {
    bridge.versions.create.mockResolvedValue({
      ...versionA,
      id: "version-a-2",
      parentVersionId: versionA.id,
      number: 2,
      displayLabel: "v2",
    });
    renderApp(<EditorTab prompt={promptA} version={versionA} isCurrent />);

    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    expect(await screen.findByText("Save as v2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    await waitFor(() =>
      expect(bridge.versions.create).toHaveBeenCalledWith({
        promptId: promptA.id,
        branchId: versionA.branchId,
        baseVersionId: versionA.id,
        content: promptA.draftContent,
      }),
    );
  });

  it("uses Control+S to amend the displayed historical working version", async () => {
    const currentV3 = "version-a-3";
    const historicalPrompt = {
      ...promptA,
      currentVersionId: currentV3,
      versionLabel: "v3",
      draftContent: null,
      draftBaseVersionId: null,
    };
    bridge.versions.updateContent.mockResolvedValue(versionA);
    renderApp(
      <EditorTab
        prompt={historicalPrompt}
        version={{ ...versionA, isCurrent: false }}
        isCurrent={false}
        isEditable
        nextVersionNumber={4}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "A new direction from v1" },
    });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    await waitFor(() =>
      expect(bridge.versions.updateContent).toHaveBeenCalledWith(
        versionA.id,
        "A new direction from v1",
      ),
    );
    expect(bridge.versions.create).not.toHaveBeenCalled();
  });

  it("uses Save changes to populate an empty version 1 placeholder", async () => {
    const firstContent = "First committed prompt content";
    const emptyV1 = { ...versionA, content: "" };
    const savedV1: VersionContentDto = { ...emptyV1, content: firstContent };
    bridge.versions.updateContent.mockResolvedValue(savedV1);
    renderApp(
      <EditorTab
        prompt={{ ...promptA, draftContent: firstContent }}
        version={emptyV1}
        isCurrent
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(bridge.versions.updateContent).toHaveBeenCalledWith(versionA.id, firstContent),
    );
  });

  it("revisits the successfully saved draft from cached prompt data after A to B to A navigation", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryDefaults(qk.prompt(promptA.id), { gcTime: Infinity });
    queryClient.setQueryData(qk.prompt(promptA.id), promptA);
    const view = renderApp(
      <EditorTab key={promptA.id} prompt={promptA} version={versionA} isCurrent />,
      { queryClient },
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "Newest A draft" },
    });
    await waitFor(
      () =>
        expect(bridge.drafts.set).toHaveBeenCalledWith(
          promptA.id,
          "Newest A draft",
          versionA.id,
        ),
      { timeout: 2_000 },
    );
    await waitFor(() =>
      expect(queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))?.draftContent).toBe(
        "Newest A draft",
      ),
    );

    view.rerender(
      <EditorTab key={promptB.id} prompt={promptB} version={versionB} isCurrent />,
    );
    const cachedA = queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))!;
    view.rerender(
      <EditorTab key={promptA.id} prompt={cachedA} version={versionA} isCurrent />,
    );

    expect(screen.getByRole("textbox", { name: "Prompt editor" })).toHaveValue(
      "Newest A draft",
    );
  });

  it("adopts a refreshed persisted draft when the editor has no newer local edit", () => {
    const view = renderApp(
      <EditorTab prompt={promptA} version={versionA} isCurrent />,
    );

    view.rerender(
      <EditorTab
        prompt={{ ...promptA, draftContent: "Refreshed persisted draft" }}
        version={versionA}
        isCurrent
      />,
    );

    expect(screen.getByRole("textbox", { name: "Prompt editor" })).toHaveValue(
      "Refreshed persisted draft",
    );
  });

  it("keeps a newer local edit when refreshed persisted draft props arrive", () => {
    const view = renderApp(
      <EditorTab prompt={promptA} version={versionA} isCurrent />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "Newer local edit" },
    });

    view.rerender(
      <EditorTab
        prompt={{ ...promptA, draftContent: "Refreshed persisted draft" }}
        version={versionA}
        isCurrent
      />,
    );

    expect(screen.getByRole("textbox", { name: "Prompt editor" })).toHaveValue(
      "Newer local edit",
    );
  });

  it("retries an unchanged draft on unmount after an autosave failure", async () => {
    bridge.drafts.set
      .mockRejectedValueOnce(new Error("disk busy"))
      .mockResolvedValueOnce(undefined);
    const view = renderApp(
      <EditorTab prompt={{ ...promptA, draftContent: null }} version={versionA} isCurrent />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "Retryable draft" },
    });

    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    view.unmount();

    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(2));
    expect(bridge.drafts.set).toHaveBeenLastCalledWith(
      promptA.id,
      "Retryable draft",
      versionA.id,
    );
  });

  it("keeps the newest draft when an unmount save would otherwise complete before an older debounce save", async () => {
    const firstSave = deferred<void>();
    const newestSave = deferred<void>();
    let persistedDraft: string | null = null;
    bridge.drafts.set
      .mockImplementationOnce(async (_promptId: string, draft: string | null, _baseVersionId?: string) => {
        await firstSave.promise;
        persistedDraft = draft;
      })
      .mockImplementationOnce(async (_promptId: string, draft: string | null, _baseVersionId?: string) => {
        await newestSave.promise;
        persistedDraft = draft;
      });
    const queryClient = createTestQueryClient();
    queryClient.setQueryDefaults(qk.prompt(promptA.id), { gcTime: Infinity });
    queryClient.setQueryData(qk.prompt(promptA.id), { ...promptA, draftContent: null });
    const view = renderApp(
      <EditorTab prompt={{ ...promptA, draftContent: null }} version={versionA} isCurrent />,
      { queryClient },
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "First pending draft" },
    });
    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "Newest draft" },
    });

    newestSave.resolve();
    view.unmount();
    firstSave.resolve();

    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(persistedDraft).toBe("Newest draft"));
    expect(queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))?.draftContent).toBe(
      "Newest draft",
    );
  });

  it("keeps the newest prompt draft across A to B to A editor instances", async () => {
    const oldInstanceSave = deferred<void>();
    const newInstanceSave = deferred<void>();
    let persistedDraft: string | null = null;
    bridge.drafts.set
      .mockImplementationOnce(async (_promptId: string, draft: string | null, _baseVersionId?: string) => {
        await oldInstanceSave.promise;
        persistedDraft = draft;
      })
      .mockImplementationOnce(async (_promptId: string, draft: string | null, _baseVersionId?: string) => {
        await newInstanceSave.promise;
        persistedDraft = draft;
      });
    const queryClient = createTestQueryClient();
    queryClient.setQueryDefaults(qk.prompt(promptA.id), { gcTime: Infinity });
    queryClient.setQueryData(qk.prompt(promptA.id), { ...promptA, draftContent: null });
    const view = renderApp(
      <EditorTab
        key={promptA.id}
        prompt={{ ...promptA, draftContent: null }}
        version={versionA}
        isCurrent
      />,
      { queryClient },
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "Old A instance draft" },
    });
    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    view.rerender(
      <EditorTab key={promptB.id} prompt={promptB} version={versionB} isCurrent />,
    );
    const cachedA = queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))!;
    view.rerender(
      <EditorTab key={promptA.id} prompt={cachedA} version={versionA} isCurrent />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "New A instance draft" },
    });

    newInstanceSave.resolve();
    view.unmount();
    oldInstanceSave.resolve();

    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(persistedDraft).toBe("New A instance draft"));
    expect(queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))?.draftContent).toBe(
      "New A instance draft",
    );
  });

  it("does not let a pending autosave resurrect a draft cleared by creating a version", async () => {
    const pendingAutosave = deferred<void>();
    const clearAfterVersion = deferred<void>();
    let persistedDraft: string | null = null;
    bridge.drafts.set
      .mockImplementationOnce(async (_promptId: string, draft: string | null, _baseVersionId?: string) => {
        await pendingAutosave.promise;
        persistedDraft = draft;
      })
      .mockImplementationOnce(async (_promptId: string, draft: string | null, _baseVersionId?: string) => {
        await clearAfterVersion.promise;
        persistedDraft = draft;
      });
    bridge.versions.create.mockResolvedValue({
      ...versionA,
      id: "version-a-2",
      parentVersionId: versionA.id,
      number: 2,
      displayLabel: "v2",
    });
    const queryClient = createTestQueryClient();
    queryClient.setQueryDefaults(qk.prompt(promptA.id), { gcTime: Infinity });
    queryClient.setQueryData(qk.prompt(promptA.id), { ...promptA, draftContent: null });
    const view = renderApp(
      <EditorTab
        prompt={{ ...promptA, draftContent: null }}
        version={versionA}
        isCurrent
      />,
      { queryClient },
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "Content promoted to a version" },
    });
    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    clearAfterVersion.resolve();
    fireEvent.click(await screen.findByRole("button", { name: "Save version" }));
    await waitFor(() => expect(bridge.versions.create).toHaveBeenCalledTimes(1));
    view.unmount();

    pendingAutosave.resolve();

    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(persistedDraft).toBeNull());
    expect(queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))?.draftContent).toBeNull();
  });

  it("does not let a pending autosave resurrect a draft cleared by amending the version", async () => {
    const pendingAutosave = deferred<void>();
    const clearAfterUpdate = deferred<void>();
    let persistedDraft: string | null = null;
    bridge.drafts.set
      .mockImplementationOnce(async (_promptId: string, draft: string | null, _baseVersionId?: string) => {
        await pendingAutosave.promise;
        persistedDraft = draft;
      })
      .mockImplementationOnce(async (_promptId: string, draft: string | null, _baseVersionId?: string) => {
        await clearAfterUpdate.promise;
        persistedDraft = draft;
      });
    bridge.versions.updateContent.mockResolvedValue(versionA);
    const queryClient = createTestQueryClient();
    queryClient.setQueryDefaults(qk.prompt(promptA.id), { gcTime: Infinity });
    queryClient.setQueryData(qk.prompt(promptA.id), { ...promptA, draftContent: null });
    const view = renderApp(
      <EditorTab
        prompt={{ ...promptA, draftContent: null }}
        version={versionA}
        isCurrent
      />,
      { queryClient },
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "Content amended in version one" },
    });
    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(bridge.versions.updateContent).toHaveBeenCalledTimes(1));
    clearAfterUpdate.resolve();
    view.unmount();
    pendingAutosave.resolve();

    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(persistedDraft).toBeNull());
    expect(queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))?.draftContent).toBeNull();
  });

  it("keeps edits made while an amendment is pending as a draft on the same version", async () => {
    const updateVersion = deferred<VersionDto>();
    bridge.versions.updateContent.mockReturnValue(updateVersion.promise);
    const queryClient = createTestQueryClient();
    queryClient.setQueryDefaults(qk.prompt(promptA.id), { gcTime: Infinity });
    queryClient.setQueryData(qk.prompt(promptA.id), {
      ...promptA,
      draftContent: "Content submitted as the amendment",
    });
    renderApp(
      <EditorTab
        prompt={{ ...promptA, draftContent: "Content submitted as the amendment" }}
        version={versionA}
        isCurrent
      />,
      { queryClient },
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(bridge.versions.updateContent).toHaveBeenCalledWith(
        versionA.id,
        "Content submitted as the amendment",
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "New edit made while amendment is pending" },
    });

    updateVersion.resolve(versionA);

    await waitFor(() =>
      expect(bridge.drafts.set).toHaveBeenCalledWith(
        promptA.id,
        "New edit made while amendment is pending",
        versionA.id,
      ),
    );
    expect(queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))?.draftContent).toBe(
      "New edit made while amendment is pending",
    );
  });

  it("keeps edits made while save-version is pending as a draft on the new version", async () => {
    const createVersion = deferred<VersionContentDto>();
    bridge.versions.create.mockReturnValue(createVersion.promise);
    const queryClient = createTestQueryClient();
    queryClient.setQueryDefaults(qk.prompt(promptA.id), { gcTime: Infinity });
    queryClient.setQueryData(qk.prompt(promptA.id), {
      ...promptA,
      draftContent: "Content submitted as the version",
    });
    renderApp(
      <EditorTab
        prompt={{ ...promptA, draftContent: "Content submitted as the version" }}
        version={versionA}
        isCurrent
      />,
      { queryClient },
    );

    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save version" }));
    await waitFor(() =>
      expect(bridge.versions.create).toHaveBeenCalledWith({
        promptId: promptA.id,
        branchId: versionA.branchId,
        baseVersionId: versionA.id,
        content: "Content submitted as the version",
      }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "New edit made while version save is pending" },
    });

    createVersion.resolve({
      ...versionA,
      id: "version-a-2",
      parentVersionId: versionA.id,
      number: 2,
      displayLabel: "v2",
      content: "Content submitted as the version",
    });

    await waitFor(() =>
      expect(bridge.drafts.set).toHaveBeenCalledWith(
        promptA.id,
        "New edit made while version save is pending",
        "version-a-2",
      ),
    );
    expect(queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))?.draftContent).toBe(
      "New edit made while version save is pending",
    );
  });

  it("preserves an explicit revert from a new A instance while an old A save is pending", async () => {
    const oldInstanceSave = deferred<void>();
    const revertedSave = deferred<void>();
    let persistedDraft: string | null = null;
    bridge.drafts.set
      .mockImplementationOnce(async (_promptId: string, draft: string | null, _baseVersionId?: string) => {
        await oldInstanceSave.promise;
        persistedDraft = draft;
      })
      .mockImplementationOnce(async (_promptId: string, draft: string | null, _baseVersionId?: string) => {
        await revertedSave.promise;
        persistedDraft = draft;
      });
    const queryClient = createTestQueryClient();
    queryClient.setQueryDefaults(qk.prompt(promptA.id), { gcTime: Infinity });
    queryClient.setQueryData(qk.prompt(promptA.id), { ...promptA, draftContent: null });
    const view = renderApp(
      <EditorTab
        key={promptA.id}
        prompt={{ ...promptA, draftContent: null }}
        version={versionA}
        isCurrent
      />,
      { queryClient },
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "Old A lifetime edit" },
    });
    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    view.rerender(
      <EditorTab key={promptB.id} prompt={promptB} version={versionB} isCurrent />,
    );
    const cachedA = queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))!;
    view.rerender(
      <EditorTab key={promptA.id} prompt={cachedA} version={versionA} isCurrent />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "Temporary new A edit" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: versionA.content },
    });

    revertedSave.resolve();
    view.unmount();
    oldInstanceSave.resolve();

    await waitFor(() => expect(bridge.drafts.set).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(persistedDraft).toBeNull());
    expect(queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))?.draftContent).toBeNull();
  });

  it("persists an edit made after version success but before the editor remounts", async () => {
    bridge.versions.create.mockResolvedValue({
      ...versionA,
      id: "version-a-2",
      parentVersionId: versionA.id,
      number: 2,
      displayLabel: "v2",
    });
    const queryClient = createTestQueryClient();
    queryClient.setQueryDefaults(qk.prompt(promptA.id), { gcTime: Infinity });
    queryClient.setQueryData(qk.prompt(promptA.id), {
      ...promptA,
      draftContent: "Content promoted to version two",
    });
    const view = renderApp(
      <EditorTab
        prompt={{ ...promptA, draftContent: "Content promoted to version two" }}
        version={versionA}
        isCurrent
      />,
      { queryClient },
    );

    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save version" }));
    await waitFor(() => expect(bridge.versions.create).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))?.draftContent).toBeNull(),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt editor" }), {
      target: { value: "Edit typed after version success" },
    });
    view.unmount();

    await waitFor(() =>
      expect(bridge.drafts.set).toHaveBeenCalledWith(
        promptA.id,
        "Edit typed after version success",
        "version-a-2",
      ),
    );
    expect(queryClient.getQueryData<PromptDetail>(qk.prompt(promptA.id))?.draftContent).toBe(
      "Edit typed after version success",
    );
  });
});
