/**
 * Test double for the preload bridge (`window.promptBuilder`). Every method is
 * a `vi.fn()` with a sensible resolved default, so components render without
 * touching Electron IPC; individual tests override only what they assert on:
 *
 *   const bridge = installMockBridge();
 *   bridge.ai.providers.list.mockResolvedValue([provider]);
 *
 * `installMockBridge` returns the typed mock and registers cleanup to delete
 * it from `window` after each test.
 */
import { afterEach, vi, type Mock } from "vitest";
import type {
  AiRunProgressEvent,
  PromptBuilderApi,
  SyncPairRequestEvent,
  SyncStatusDto,
  UpdateStateDto,
} from "../../../shared/ipc.js";

type Mocked<T> = T extends (...args: infer A) => infer R
  ? Mock<(...args: A) => R>
  : { [K in keyof T]: Mocked<T[K]> };

/** The bridge with every leaf function replaced by a typed vi mock. */
export type MockBridge = Mocked<PromptBuilderApi> & {
  /** Delivers an ai:run-progress event to every subscribed renderer listener. */
  emitRunProgress(event: AiRunProgressEvent): void;
  /** Delivers a promptbranch://import deep link to subscribed listeners. */
  emitOpenImport(url: string): void;
  /** Delivers a sync:state-changed event to subscribed listeners. */
  emitSyncState(status: SyncStatusDto): void;
  /** Delivers a sync:pair-request event to subscribed listeners. */
  emitSyncPairRequest(event: SyncPairRequestEvent): void;
  /** Delivers an updates:state-changed event to subscribed listeners. */
  emitUpdateState(state: UpdateStateDto): void;
  /** Delivers the application menu's Check for Updates action. */
  emitOpenUpdates(): void;
};

const notStubbed = () => Promise.reject(new Error("bridge method not stubbed in this test"));

export function createMockBridge(): MockBridge {
  // onRunProgress listeners registered by components under test; the default
  // implementation captures them so tests can drive progress events.
  const progressListeners = new Set<(event: AiRunProgressEvent) => void>();
  // onOpenImport listeners (promptbranch:// deep links), driven by emitOpenImport.
  const importListeners = new Set<(url: string) => void>();
  // sync push listeners, driven by emitSyncState / emitSyncPairRequest.
  const syncStateListeners = new Set<(status: SyncStatusDto) => void>();
  const syncPairListeners = new Set<(event: SyncPairRequestEvent) => void>();
  const updateStateListeners = new Set<(state: UpdateStateDto) => void>();
  const openUpdatesListeners = new Set<() => void>();

  const disabledSyncStatus: SyncStatusDto = {
    enabled: false,
    listening: false,
    deviceName: "Test Mac",
    fingerprintShort: "",
    pairingActive: false,
    pairingCode: null,
    peers: [],
    nearby: [],
    pendingDirty: 0,
    lastSyncedAt: null,
  };
  const initialUpdateState: UpdateStateDto = {
    status: "not-checked",
    currentVersion: "0.0.0-test",
    latestVersion: null,
    platform: "macOS",
    architecture: "arm64",
    automaticChecksEnabled: true,
    lastCheckedAt: null,
    checkSource: null,
    releaseName: null,
    releaseNotes: null,
    publishedAt: null,
    assets: [],
    errorMessage: null,
  };
  // Typed as the real API first so every default implementation is checked
  // against the real signatures, then widened to the mock view for tests.
  const api: PromptBuilderApi = {
    prompts: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      create: vi.fn(notStubbed),
      update: vi.fn(notStubbed),
      setStarred: vi.fn(async () => {}),
      softDelete: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
      hardDelete: vi.fn(async () => {}),
      exportJson: vi.fn(async () => ({ canceled: true })),
    },
    versions: {
      create: vi.fn(notStubbed),
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      setCurrent: vi.fn(async () => {}),
    },
    drafts: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
    },
    branches: {
      list: vi.fn(async () => []),
      create: vi.fn(notStubbed),
    },
    notes: {
      add: vi.fn(notStubbed),
      list: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
    },
    tags: {
      create: vi.fn(notStubbed),
      list: vi.fn(async () => []),
      addToPrompt: vi.fn(async () => {}),
      removeFromPrompt: vi.fn(async () => {}),
    },
    collections: {
      create: vi.fn(notStubbed),
      list: vi.fn(async () => []),
      addPrompt: vi.fn(async () => {}),
      removePrompt: vi.fn(async () => {}),
      forPrompt: vi.fn(async () => []),
    },
    search: vi.fn(async () => []),
    ratings: {
      add: vi.fn(notStubbed),
      latest: vi.fn(async () => null),
      averages: vi.fn(async () => ({
        effectiveness: null,
        clarity: null,
        completeness: null,
        actionability: null,
        overall: null,
        count: 0,
      })),
      forPromptVersions: vi.fn(async () => ({})),
    },
    runs: {
      add: vi.fn(notStubbed),
      list: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
      updateOutcome: vi.fn(notStubbed),
      updateMetrics: vi.fn(notStubbed),
    },
    library: {
      stats: vi.fn(async () => ({
        prompts: 0,
        versions: 0,
        branches: 0,
        tags: 0,
        collections: 0,
        notes: 0,
        runs: 0,
      })),
      exportJson: vi.fn(async () => ({ canceled: true })),
      importJson: vi.fn(async () => ({ canceled: true })),
      backupNow: vi.fn(async () => ""),
      emptyTrash: vi.fn(async () => 0),
      recentActivity: vi.fn(async () => []),
    },
    suggestions: {
      list: vi.fn(async () => []),
      approve: vi.fn(async () => {}),
      reject: vi.fn(async () => {}),
    },
    share: {
      preview: vi.fn(notStubbed),
      publish: vi.fn(notStubbed),
      list: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
      getPortalBaseUrl: vi.fn(async () => "https://promptbranch.app"),
      setPortalBaseUrl: vi.fn(async () => "https://promptbranch.app"),
      importPreview: vi.fn(notStubbed),
      import: vi.fn(notStubbed),
      onOpenImport: vi.fn((callback: (url: string) => void) => {
        importListeners.add(callback);
        return () => {
          importListeners.delete(callback);
        };
      }),
    },
    ai: {
      providers: {
        create: vi.fn(notStubbed),
        update: vi.fn(notStubbed),
        delete: vi.fn(async () => {}),
        list: vi.fn(async () => []),
        test: vi.fn(async () => ({ ok: true })),
        connectEnv: vi.fn(notStubbed),
        setModels: vi.fn(notStubbed),
        setModelHidden: vi.fn(notStubbed),
      },
      envDetect: vi.fn(async () => ({})),
      providerTypes: vi.fn(async () => []),
      catalog: {
        get: vi.fn(async () => null),
        refresh: vi.fn(async () => ({ ok: true, catalog: null })),
      },
      run: vi.fn(notStubbed),
      onRunProgress: vi.fn((callback: (event: AiRunProgressEvent) => void) => {
        progressListeners.add(callback);
        return () => {
          progressListeners.delete(callback);
        };
      }),
      runCancel: vi.fn(async () => ({ cancelled: true })),
      assist: vi.fn(notStubbed),
      judge: vi.fn(notStubbed),
      runGroups: vi.fn(async () => []),
    },
    updates: {
      getState: vi.fn(async () => initialUpdateState),
      check: vi.fn(async () => initialUpdateState),
      setAutomaticChecks: vi.fn(async (enabled) => ({
        ...initialUpdateState,
        automaticChecksEnabled: enabled,
      })),
      openDownload: vi.fn(async () => {}),
      openReleaseNotes: vi.fn(async () => {}),
      onStateChanged: vi.fn((callback: (state: UpdateStateDto) => void) => {
        updateStateListeners.add(callback);
        return () => {
          updateStateListeners.delete(callback);
        };
      }),
      onOpen: vi.fn((callback: () => void) => {
        openUpdatesListeners.add(callback);
        return () => {
          openUpdatesListeners.delete(callback);
        };
      }),
    },
    app: {
      info: vi.fn(async () => ({
        version: "0.0.0-test",
        dbPath: "",
        mcpServerPath: null,
        electronVersion: "",
        chromeVersion: "",
        nodeVersion: "",
      })),
      onOpenAbout: vi.fn(() => () => {}),
      onOpenSettings: vi.fn(() => () => {}),
      openExternal: vi.fn(async () => {}),
      licensesText: vi.fn(async () =>
        [
          "# PromptBranch — Third-Party Notices",
          "",
          "PromptBranch (https://promptbranch.app/) is licensed under the MIT License.",
          "Bundled test fixture for the licenses dialog.",
          "",
          "Notes:",
          "",
          "- Dual-licensed packages use the permissive branch.",
          "",
          "---",
          "",
          "## alpha-pkg@1.2.3",
          "",
          "License: MIT",
          "",
          "```",
          "Fake MIT license text for alpha-pkg.",
          "```",
          "",
          "## @beta-scope/beta-pkg@2.0.0",
          "",
          "License: Apache-2.0",
          "",
          "(No license file present in the package; license text for Apache-2.0 applies.)",
          "",
        ].join("\n"),
      ),
    },
    sync: {
      getStatus: vi.fn(async () => disabledSyncStatus),
      setEnabled: vi.fn(async (enabled: boolean) => ({ ...disabledSyncStatus, enabled })),
      setDeviceName: vi.fn(async (name: string) => ({ ...disabledSyncStatus, deviceName: name })),
      beginPairing: vi.fn(async () => disabledSyncStatus),
      cancelPairing: vi.fn(async () => disabledSyncStatus),
      pairWithCode: vi.fn(async () => ({ ok: true })),
      respondPairing: vi.fn(async () => {}),
      forgetDevice: vi.fn(async () => disabledSyncStatus),
      now: vi.fn(async () => disabledSyncStatus),
      onStateChanged: vi.fn((callback: (status: SyncStatusDto) => void) => {
        syncStateListeners.add(callback);
        return () => {
          syncStateListeners.delete(callback);
        };
      }),
      onPairRequest: vi.fn((callback: (event: SyncPairRequestEvent) => void) => {
        syncPairListeners.add(callback);
        return () => {
          syncPairListeners.delete(callback);
        };
      }),
    },
  };
  return Object.assign(api as unknown as MockBridge, {
    emitRunProgress: (event: AiRunProgressEvent) => {
      for (const listener of [...progressListeners]) listener(event);
    },
    emitOpenImport: (url: string) => {
      for (const listener of [...importListeners]) listener(url);
    },
    emitSyncState: (status: SyncStatusDto) => {
      for (const listener of [...syncStateListeners]) listener(status);
    },
    emitSyncPairRequest: (event: SyncPairRequestEvent) => {
      for (const listener of [...syncPairListeners]) listener(event);
    },
    emitUpdateState: (state: UpdateStateDto) => {
      for (const listener of [...updateStateListeners]) listener(state);
    },
    emitOpenUpdates: () => {
      for (const listener of [...openUpdatesListeners]) listener();
    },
  });
}

/**
 * Installs a fresh mock bridge on `window.promptBuilder` and returns it.
 * The bridge is removed from `window` after each test.
 */
export function installMockBridge(): MockBridge {
  const bridge = createMockBridge();
  (window as { promptBuilder?: unknown }).promptBuilder = bridge;
  afterEach(() => {
    delete (window as { promptBuilder?: unknown }).promptBuilder;
  });
  return bridge;
}
