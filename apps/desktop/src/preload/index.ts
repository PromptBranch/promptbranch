import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/channels.js";
import type { PromptBuilderApi } from "../shared/ipc.js";

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api: PromptBuilderApi = {
  prompts: {
    list: (query) => invoke(IPC_CHANNELS.promptList, query),
    get: (id) => invoke(IPC_CHANNELS.promptGet, id),
    create: (input) => invoke(IPC_CHANNELS.promptCreate, input),
    update: (id, patch) => invoke(IPC_CHANNELS.promptUpdate, { id, patch }),
    setStarred: (id, starred) => invoke(IPC_CHANNELS.promptSetStarred, { id, starred }),
    softDelete: (id) => invoke(IPC_CHANNELS.promptSoftDelete, id),
    restore: (id) => invoke(IPC_CHANNELS.promptRestore, id),
    hardDelete: (id) => invoke(IPC_CHANNELS.promptHardDelete, id),
    exportJson: (id) => invoke(IPC_CHANNELS.promptExport, id),
  },
  versions: {
    create: (input) => invoke(IPC_CHANNELS.versionCreate, input),
    list: (promptId) => invoke(IPC_CHANNELS.versionList, promptId),
    get: (versionId) => invoke(IPC_CHANNELS.versionGet, versionId),
    setCurrent: (promptId, versionId) => invoke(IPC_CHANNELS.versionSetCurrent, { promptId, versionId }),
  },
  drafts: {
    get: (promptId) => invoke(IPC_CHANNELS.draftGet, promptId),
    set: (promptId, content) => invoke(IPC_CHANNELS.draftSet, { promptId, content }),
  },
  branches: {
    list: (promptId) => invoke(IPC_CHANNELS.branchList, promptId),
    create: (input) => invoke(IPC_CHANNELS.branchCreate, input),
  },
  notes: {
    add: (input) => invoke(IPC_CHANNELS.noteAdd, input),
    list: (promptId) => invoke(IPC_CHANNELS.noteList, promptId),
    delete: (noteId) => invoke(IPC_CHANNELS.noteDelete, noteId),
  },
  tags: {
    create: (input) => invoke(IPC_CHANNELS.tagCreate, input),
    list: () => invoke(IPC_CHANNELS.tagList),
    addToPrompt: (promptId, tagId) => invoke(IPC_CHANNELS.tagAddToPrompt, { promptId, tagId }),
    removeFromPrompt: (promptId, tagId) => invoke(IPC_CHANNELS.tagRemoveFromPrompt, { promptId, tagId }),
  },
  collections: {
    create: (name) => invoke(IPC_CHANNELS.collectionCreate, { name }),
    list: () => invoke(IPC_CHANNELS.collectionList),
    addPrompt: (collectionId, promptId) =>
      invoke(IPC_CHANNELS.collectionAddPrompt, { collectionId, promptId }),
    removePrompt: (collectionId, promptId) =>
      invoke(IPC_CHANNELS.collectionRemovePrompt, { collectionId, promptId }),
    forPrompt: (promptId) => invoke(IPC_CHANNELS.collectionForPrompt, promptId),
  },
  search: (query) => invoke(IPC_CHANNELS.search, { query }),
  ratings: {
    add: (input) => invoke(IPC_CHANNELS.ratingAdd, input),
    latest: (targetType, targetId) => invoke(IPC_CHANNELS.ratingLatest, { targetType, targetId }),
    averages: (targetType, targetId) => invoke(IPC_CHANNELS.ratingAverages, { targetType, targetId }),
    forPromptVersions: (promptId) => invoke(IPC_CHANNELS.ratingVersionSummaries, promptId),
  },
  runs: {
    add: (input) => invoke(IPC_CHANNELS.runAdd, input),
    list: (promptId) => invoke(IPC_CHANNELS.runList, promptId),
    delete: (runId) => invoke(IPC_CHANNELS.runDelete, runId),
    updateOutcome: (input) => invoke(IPC_CHANNELS.runUpdateOutcome, input),
    updateMetrics: (input) => invoke(IPC_CHANNELS.runUpdateMetrics, input),
  },
  library: {
    stats: () => invoke(IPC_CHANNELS.libraryStats),
    exportJson: () => invoke(IPC_CHANNELS.libraryExport),
    importJson: () => invoke(IPC_CHANNELS.libraryImport),
    backupNow: () => invoke(IPC_CHANNELS.libraryBackupNow),
    emptyTrash: () => invoke(IPC_CHANNELS.libraryEmptyTrash),
    recentActivity: (limit) => invoke(IPC_CHANNELS.libraryRecentActivity, { limit }),
  },
  suggestions: {
    list: () => invoke(IPC_CHANNELS.suggestionList),
    approve: (versionId, setAsCurrent) =>
      invoke(IPC_CHANNELS.suggestionApprove, { versionId, setAsCurrent: setAsCurrent ?? false }),
    reject: (versionId) => invoke(IPC_CHANNELS.suggestionReject, { versionId }),
  },
  share: {
    preview: (input) => invoke(IPC_CHANNELS.sharePreview, input),
    publish: (input) => invoke(IPC_CHANNELS.sharePublish, input),
    list: () => invoke(IPC_CHANNELS.shareList),
    delete: (snapshotId) => invoke(IPC_CHANNELS.shareDelete, { snapshotId }),
    getPortalBaseUrl: () => invoke(IPC_CHANNELS.sharePortalGet),
    setPortalBaseUrl: (baseUrl) => invoke(IPC_CHANNELS.sharePortalSet, { baseUrl }),
    importPreview: (url) => invoke(IPC_CHANNELS.shareImportPreview, { url }),
    import: (preview) => invoke(IPC_CHANNELS.shareImport, preview),
    onOpenImport: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, url: unknown) => {
        callback(url as string);
      };
      ipcRenderer.on(IPC_CHANNELS.shareOpenImport, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.shareOpenImport, listener);
    },
  },
  sync: {
    getStatus: () => invoke(IPC_CHANNELS.syncGetStatus),
    setEnabled: (enabled) => invoke(IPC_CHANNELS.syncSetEnabled, { enabled }),
    setDeviceName: (name) => invoke(IPC_CHANNELS.syncSetDeviceName, { name }),
    beginPairing: () => invoke(IPC_CHANNELS.syncBeginPairing),
    cancelPairing: () => invoke(IPC_CHANNELS.syncCancelPairing),
    pairWithCode: (input) => invoke(IPC_CHANNELS.syncPairWithCode, input),
    respondPairing: (input) => invoke(IPC_CHANNELS.syncRespondPairing, input),
    forgetDevice: (fingerprint) => invoke(IPC_CHANNELS.syncForgetDevice, { fingerprint }),
    now: () => invoke(IPC_CHANNELS.syncNow),
    onStateChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => {
        callback(status as Parameters<typeof callback>[0]);
      };
      ipcRenderer.on(IPC_CHANNELS.syncStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.syncStateChanged, listener);
    },
    onPairRequest: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: unknown) => {
        callback(event as Parameters<typeof callback>[0]);
      };
      ipcRenderer.on(IPC_CHANNELS.syncPairRequest, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.syncPairRequest, listener);
    },
  },
  ai: {
    providers: {
      create: (input) => invoke(IPC_CHANNELS.aiProviderCreate, input),
      update: (input) => invoke(IPC_CHANNELS.aiProviderUpdate, input),
      delete: (providerId) => invoke(IPC_CHANNELS.aiProviderDelete, providerId),
      list: () => invoke(IPC_CHANNELS.aiProviderList),
      test: (providerId, modelId) => invoke(IPC_CHANNELS.aiProviderTest, { providerId, modelId }),
      connectEnv: (input) => invoke(IPC_CHANNELS.aiProviderConnectEnv, input),
      setModels: (input) => invoke(IPC_CHANNELS.aiModelsSet, input),
      setModelHidden: (input) => invoke(IPC_CHANNELS.aiModelHide, input),
    },
    envDetect: () => invoke(IPC_CHANNELS.aiEnvDetect),
    providerTypes: () => invoke(IPC_CHANNELS.aiProviderTypes),
    catalog: {
      get: () => invoke(IPC_CHANNELS.aiCatalogGet),
      refresh: () => invoke(IPC_CHANNELS.aiCatalogRefresh),
    },
    run: (input) => invoke(IPC_CHANNELS.aiRun, input),
    onRunProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        // Validated with aiRunProgressEventSchema on the renderer side —
        // the sandboxed preload cannot bundle zod.
        callback(payload as Parameters<typeof callback>[0]);
      };
      ipcRenderer.on(IPC_CHANNELS.aiRunProgress, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.aiRunProgress, listener);
    },
    runCancel: (input) => invoke(IPC_CHANNELS.aiRunCancel, input),
    assist: (input) => invoke(IPC_CHANNELS.aiAssist, input),
    judge: (input) => invoke(IPC_CHANNELS.aiJudge, input),
    runGroups: (promptId) => invoke(IPC_CHANNELS.runGroupList, promptId),
  },
  updates: {
    getState: () => invoke(IPC_CHANNELS.updateGetState),
    check: () => invoke(IPC_CHANNELS.updateCheck),
    setAutomaticChecks: (enabled) =>
      invoke(IPC_CHANNELS.updateSetAutomaticChecks, { enabled }),
    openDownload: (assetName) =>
      invoke(IPC_CHANNELS.updateOpenDownload, { assetName }),
    openReleaseNotes: () => invoke(IPC_CHANNELS.updateOpenReleaseNotes),
    onStateChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        // Main validates before sending; the renderer validates again before use.
        callback(payload as Parameters<typeof callback>[0]);
      };
      ipcRenderer.on(IPC_CHANNELS.updateStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.updateStateChanged, listener);
    },
    onOpen: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.openUpdates, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.openUpdates, listener);
    },
  },
  app: {
    info: () => invoke(IPC_CHANNELS.appInfo),
    onOpenAbout: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.openAbout, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.openAbout, listener);
    },
    onOpenSettings: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.openSettings, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.openSettings, listener);
    },
    openExternal: (url) => invoke(IPC_CHANNELS.openExternal, url),
    licensesText: () => invoke(IPC_CHANNELS.licensesText),
  },
};

contextBridge.exposeInMainWorld("promptBuilder", api);
