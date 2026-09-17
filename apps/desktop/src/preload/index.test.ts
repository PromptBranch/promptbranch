import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/channels.js";
import type { AiRunInput, AiRunProgressEvent, PromptBuilderApi } from "../shared/ipc.js";

const electron = vi.hoisted(() => ({
  exposed: undefined as unknown,
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, value: unknown) => {
      electron.exposed = value;
    },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

interface PalettePreloadApi {
  getState(): Promise<unknown>;
  updateSettings(input: unknown): Promise<unknown>;
  search(input: unknown): Promise<unknown>;
  resolve(input: unknown): Promise<unknown>;
  render(input: unknown): Promise<unknown>;
  copy(input: unknown): Promise<unknown>;
  dismiss(input: unknown): Promise<void>;
  onOpen(callback: (sessionId: string) => void): () => void;
  onClosed(callback: (sessionId: string) => void): () => void;
}

interface EditorPreloadApi {
  versions: {
    create(input: unknown): Promise<unknown>;
    updateContent(versionId: string, content: string): Promise<unknown>;
  };
  drafts: { set(promptId: string, content: string | null, baseVersionId?: string): Promise<void> };
}

function quickPaletteApi(): PalettePreloadApi {
  const api = electron.exposed as { quickPalette?: PalettePreloadApi };
  expect(api.quickPalette, "preload must expose quickPalette").toBeDefined();
  return api.quickPalette!;
}

function editorApi(): EditorPreloadApi {
  return electron.exposed as EditorPreloadApi;
}

describe("quick palette preload bridge", () => {
  beforeEach(async () => {
    vi.resetModules();
    electron.exposed = undefined;
    electron.invoke.mockReset().mockResolvedValue(undefined);
    electron.on.mockReset();
    electron.removeListener.mockReset();
    await import("./index.js");
  });

  it("forwards palette requests over their dedicated channels", async () => {
    const api = quickPaletteApi();
    const settings = { enabled: true, accelerator: "CommandOrControl+Shift+Space" };
    const search = { sessionId: "session-1", query: "hello" };
    const resolve = { sessionId: "session-1", promptId: "prompt-1" };
    const render = { ...resolve, versionId: "version-1", variables: { name: "Ada" } };
    const copy = { sessionId: "session-1", previewId: "preview-1" };
    const dismiss = { sessionId: "session-1" };

    await api.getState();
    await api.updateSettings(settings);
    await api.search(search);
    await api.resolve(resolve);
    await api.render(render);
    await api.copy(copy);
    await api.dismiss(dismiss);

    expect(electron.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.quickPaletteGetState],
      [IPC_CHANNELS.quickPaletteUpdateSettings, settings],
      [IPC_CHANNELS.quickPaletteSearch, search],
      [IPC_CHANNELS.quickPaletteResolve, resolve],
      [IPC_CHANNELS.quickPaletteRender, render],
      [IPC_CHANNELS.quickPaletteCopy, copy],
      [IPC_CHANNELS.quickPaletteDismiss, dismiss],
    ]);
  });

  it("forwards exact version and draft bases", async () => {
    const api = editorApi();
    const version = {
      promptId: "prompt-1",
      branchId: "branch-1",
      baseVersionId: "version-1",
      content: "next",
    };

    await api.versions.create(version);
    await api.versions.updateContent("version-1", "revised");
    await api.drafts.set("prompt-1", "working", "version-1");
    await api.drafts.set("prompt-1", null);

    expect(electron.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.versionCreate, version],
      [IPC_CHANNELS.versionUpdateContent, { versionId: "version-1", content: "revised" }],
      [IPC_CHANNELS.draftSet, { promptId: "prompt-1", content: "working", baseVersionId: "version-1" }],
      [IPC_CHANNELS.draftSet, { promptId: "prompt-1", content: null }],
    ]);
  });

  it("preserves request correlation through invocation and progress subscription", async () => {
    const api = electron.exposed as PromptBuilderApi;
    const input: AiRunInput = {
      requestId: "550e8400-e29b-41d4-a716-446655440001",
      promptId: "prompt-1", content: "Hi", variables: {},
      modelRefs: [{ providerId: "provider-1", modelId: "model-1" }],
    };
    await api.ai.run(input);
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.aiRun, input);
    const received = vi.fn();
    const unsubscribe = api.ai.onRunProgress(received);
    const listener = electron.on.mock.calls[0]![1] as (_event: unknown, payload: AiRunProgressEvent) => void;
    const event: AiRunProgressEvent = {
      requestId: input.requestId, runGroupId: "group-1", providerId: "provider-1",
      modelId: "model-1", phase: "queued",
    };
    listener({}, event);
    expect(received).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.aiRunProgress, listener);
  });

  it("unsubscribes the exact listeners installed for open and closed events", () => {
    const api = quickPaletteApi();
    const opened = vi.fn();
    const closed = vi.fn();

    const unsubscribeOpen = api.onOpen(opened);
    const unsubscribeClosed = api.onClosed(closed);
    const openListener = electron.on.mock.calls[0]?.[1] as (_event: unknown, id: string) => void;
    const closedListener = electron.on.mock.calls[1]?.[1] as (_event: unknown, id: string) => void;
    openListener({}, "session-open");
    closedListener({}, "session-closed");
    unsubscribeOpen();
    unsubscribeClosed();

    expect(opened).toHaveBeenCalledWith("session-open");
    expect(closed).toHaveBeenCalledWith("session-closed");
    expect(electron.removeListener.mock.calls).toEqual([
      [IPC_CHANNELS.quickPaletteOpened, openListener],
      [IPC_CHANNELS.quickPaletteClosed, closedListener],
    ]);
  });
});
