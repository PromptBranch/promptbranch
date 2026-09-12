import type { PromptLibrary } from "@promptbranch/core";
import {
  IPC_CHANNELS,
  quickPaletteCopySchema,
  quickPaletteDismissSchema,
  quickPaletteRenderSchema,
  quickPaletteResolveSchema,
  quickPaletteSearchSchema,
  quickPaletteSettingsSchema,
} from "../shared/ipc.js";
import type {
  QuickPaletteItem,
  QuickPalettePreview,
  QuickPaletteRenderInput,
  QuickPaletteResult,
  QuickPaletteSelection,
  QuickPaletteSettings,
  QuickPaletteState,
} from "../shared/ipc.js";
import {
  assertQuickPaletteSelectionCurrent,
  QuickPaletteError,
  quickPaletteFailure,
  renderQuickPalette,
  resolveQuickPalette,
  searchQuickPalette,
} from "./quick-palette-library.js";

export const DEFAULT_QUICK_PALETTE_SETTINGS: QuickPaletteSettings = {
  enabled: false,
  accelerator: "CommandOrControl+Shift+Space",
};
export const QUICK_PALETTE_SETTINGS_KEY = "quick-palette.settings";

export interface QuickPaletteRequestContext {
  sender: unknown;
  frame: unknown;
}

export interface QuickPaletteWindowHandlers {
  ready(): void;
  blur(): void;
  closed(): void;
  failed(error: unknown): void;
}

export interface QuickPaletteWindowPort {
  readonly sender: unknown;
  mainFrame(): unknown;
  send(channel: string, payload: unknown): void;
  show(): void;
  focus(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface QuickPaletteControllerDeps {
  library: PromptLibrary;
  readSetting(): string | null;
  writeSetting(value: string): void;
  shortcut: {
    register(accelerator: string, callback: () => void): boolean;
    unregister(accelerator: string): void;
  };
  createWindow(handlers: QuickPaletteWindowHandlers): QuickPaletteWindowPort;
  getMainFrame(): QuickPaletteRequestContext | null;
  clipboardWriteText(content: string): void;
  uuid(): string;
  reportError(error: unknown): void;
}

export interface QuickPaletteController {
  getState(context: QuickPaletteRequestContext): QuickPaletteState;
  updateSettings(
    context: QuickPaletteRequestContext,
    settings: QuickPaletteSettings,
  ): QuickPaletteState;
  toggle(): string | null;
  search(
    context: QuickPaletteRequestContext,
    input: { sessionId: string; query: string },
  ): Promise<QuickPaletteResult<QuickPaletteItem[]>>;
  resolve(
    context: QuickPaletteRequestContext,
    input: { sessionId: string; promptId: string },
  ): Promise<QuickPaletteResult<QuickPaletteSelection>>;
  render(
    context: QuickPaletteRequestContext,
    input: QuickPaletteRenderInput,
  ): Promise<QuickPaletteResult<QuickPalettePreview>>;
  copy(
    context: QuickPaletteRequestContext,
    input: { sessionId: string; previewId: string },
  ): Promise<QuickPaletteResult<null>>;
  dismiss(
    context: QuickPaletteRequestContext,
    input: { sessionId: string },
  ): void;
  dispose(): void;
}

export interface QuickPaletteIpcEvent {
  sender: unknown;
  senderFrame: unknown;
}

export interface QuickPaletteIpcRegistrar {
  handle(
    channel: string,
    handler: (event: QuickPaletteIpcEvent, payload?: unknown) => unknown,
  ): void;
}

interface StoredPreview {
  id: string;
  promptId: string;
  versionId: string;
  templateContent: string;
  content: string;
}

function sessionFailure(): Extract<QuickPaletteResult<never>, { ok: false }> {
  return {
    ok: false,
    code: "session-ended",
    message: "This prompt palette session has ended.",
  };
}

function previewFailure(): Extract<QuickPaletteResult<never>, { ok: false }> {
  return {
    ok: false,
    code: "preview-expired",
    message: "This preview is no longer current. Render it again before copying.",
  };
}

function readInitialSettings(deps: QuickPaletteControllerDeps): {
  settings: QuickPaletteSettings;
  error: string | null;
} {
  const raw = deps.readSetting();
  if (raw === null) return { settings: { ...DEFAULT_QUICK_PALETTE_SETTINGS }, error: null };
  try {
    const parsed = quickPaletteSettingsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("Saved quick access settings are invalid");
    return { settings: parsed.data, error: null };
  } catch (error) {
    deps.reportError(error);
    return {
      settings: { ...DEFAULT_QUICK_PALETTE_SETTINGS },
      error: "Saved quick access settings could not be read. Defaults are in use.",
    };
  }
}

export function createQuickPaletteController(
  deps: QuickPaletteControllerDeps,
): QuickPaletteController {
  const initial = readInitialSettings(deps);
  let settings = initial.settings;
  let registrationError = initial.error;
  let registeredAccelerator: string | null = null;
  let window: QuickPaletteWindowPort | null = null;
  let ready = false;
  let shown = false;
  let focused = false;
  let sessionId: string | null = null;
  let renderGeneration = 0;
  let latestPreview: StoredPreview | null = null;
  let disposed = false;

  const state = (): QuickPaletteState => ({
    settings: { ...settings },
    registration: !settings.enabled
      ? "disabled"
      : registeredAccelerator === settings.accelerator
        ? "registered"
        : "unavailable",
    registrationError,
    sessionId,
  });

  const matchesMainFrame = (context: QuickPaletteRequestContext): boolean => {
    const main = deps.getMainFrame();
    return main !== null && context.sender === main.sender && context.frame === main.frame;
  };

  const matchesPaletteFrame = (context: QuickPaletteRequestContext): boolean =>
    window !== null &&
    !window.isDestroyed() &&
    context.sender === window.sender &&
    context.frame === window.mainFrame();

  const hasActiveSession = (
    context: QuickPaletteRequestContext,
    requestedSessionId: string,
  ): boolean => matchesPaletteFrame(context) && sessionId === requestedSessionId;

  const invalidatePreview = (): void => {
    renderGeneration += 1;
    latestPreview = null;
  };

  const clearSession = (): void => {
    sessionId = null;
    shown = false;
    focused = false;
    invalidatePreview();
  };

  const dismissActiveSession = (requestedSessionId: string): void => {
    if (sessionId !== requestedSessionId) return;
    const closingWindow = window;
    clearSession();
    if (closingWindow && !closingWindow.isDestroyed()) {
      closingWindow.send("quick-palette:closed", requestedSessionId);
      closingWindow.hide();
    }
  };

  const failWindow = (error: unknown): void => {
    if (disposed) return;
    deps.reportError(error);
    const failedWindow = window;
    if (sessionId) dismissActiveSession(sessionId);
    window = null;
    ready = false;
    if (failedWindow && !failedWindow.isDestroyed()) failedWindow.destroy();
  };

  const showActiveSession = (): void => {
    if (disposed || !ready || !sessionId || !window || window.isDestroyed()) return;
    window.send("quick-palette:opened", sessionId);
    window.show();
    shown = true;
    window.focus();
    focused = true;
  };

  const ensureWindow = (): QuickPaletteWindowPort => {
    if (window && !window.isDestroyed()) return window;
    ready = false;
    shown = false;
    focused = false;
    let created: QuickPaletteWindowPort;
    created = deps.createWindow({
      ready: () => {
        if (disposed || window !== created || created.isDestroyed()) return;
        ready = true;
        showActiveSession();
      },
      blur: () => {
        if (disposed || window !== created || !shown || !focused || !sessionId) return;
        dismissActiveSession(sessionId);
      },
      closed: () => {
        if (window !== created) return;
        window = null;
        ready = false;
        clearSession();
      },
      failed: (error) => {
        if (window === created) failWindow(error);
      },
    });
    window = created;
    return created;
  };

  const register = (accelerator: string): boolean => {
    try {
      return deps.shortcut.register(accelerator, () => {
        toggle();
      });
    } catch (error) {
      deps.reportError(error);
      return false;
    }
  };

  const toggle = (): string | null => {
    if (disposed) return null;
    if (sessionId) {
      dismissActiveSession(sessionId);
      return null;
    }
    sessionId = deps.uuid();
    shown = false;
    focused = false;
    invalidatePreview();
    ensureWindow();
    showActiveSession();
    return sessionId;
  };

  if (settings.enabled) {
    if (register(settings.accelerator)) {
      registeredAccelerator = settings.accelerator;
    } else {
      registrationError = "That keyboard shortcut is already in use or unavailable.";
    }
  }

  return {
    getState(context) {
      if (!matchesMainFrame(context) && !matchesPaletteFrame(context)) {
        throw new QuickPaletteError("session-ended", "This window cannot access quick palette state.");
      }
      return state();
    },

    updateSettings(context, nextSettings) {
      if (!matchesMainFrame(context)) {
        throw new QuickPaletteError("session-ended", "Only the library window can change quick access settings.");
      }

      const previousSettings = settings;
      const previousAccelerator = registeredAccelerator;
      const persist = (): boolean => {
        try {
          deps.writeSetting(JSON.stringify(nextSettings));
          return true;
        } catch (error) {
          deps.reportError(error);
          registrationError = "Quick access settings could not be saved.";
          return false;
        }
      };

      if (!nextSettings.enabled) {
        if (!persist()) return state();
        if (previousAccelerator) deps.shortcut.unregister(previousAccelerator);
        settings = { ...nextSettings };
        registeredAccelerator = null;
        registrationError = null;
        return state();
      }

      if (previousAccelerator === nextSettings.accelerator) {
        if (!persist()) return state();
        settings = { ...nextSettings };
        registrationError = null;
        return state();
      }

      if (!register(nextSettings.accelerator)) {
        registrationError = "That keyboard shortcut is already in use or unavailable.";
        settings = previousSettings;
        registeredAccelerator = previousAccelerator;
        return state();
      }
      if (!persist()) {
        deps.shortcut.unregister(nextSettings.accelerator);
        settings = previousSettings;
        registeredAccelerator = previousAccelerator;
        return state();
      }

      if (previousAccelerator) deps.shortcut.unregister(previousAccelerator);
      settings = { ...nextSettings };
      registeredAccelerator = nextSettings.accelerator;
      registrationError = null;
      return state();
    },

    toggle,

    async search(context, input) {
      if (!hasActiveSession(context, input.sessionId)) return sessionFailure();
      try {
        return { ok: true, value: searchQuickPalette(deps.library, input.query) };
      } catch (error) {
        return quickPaletteFailure(error);
      }
    },

    async resolve(context, input) {
      if (!hasActiveSession(context, input.sessionId)) return sessionFailure();
      invalidatePreview();
      try {
        return { ok: true, value: resolveQuickPalette(deps.library, input.promptId) };
      } catch (error) {
        return quickPaletteFailure(error);
      }
    },

    async render(context, input) {
      if (!hasActiveSession(context, input.sessionId)) return sessionFailure();
      invalidatePreview();
      const generation = renderGeneration;
      let rendered: ReturnType<typeof renderQuickPalette>;
      let selection: QuickPaletteSelection;
      try {
        selection = assertQuickPaletteSelectionCurrent(deps.library, input);
        rendered = renderQuickPalette(deps.library, input);
      } catch (error) {
        return quickPaletteFailure(error);
      }

      await Promise.resolve();
      if (
        !hasActiveSession(context, input.sessionId) ||
        generation !== renderGeneration
      ) {
        return sessionFailure();
      }
      if (rendered.status === "needs-input") {
        return { ok: true, value: rendered };
      }

      const previewId = deps.uuid();
      latestPreview = {
        id: previewId,
        promptId: input.promptId,
        versionId: input.versionId,
        templateContent: selection.templateContent,
        content: rendered.content,
      };
      return {
        ok: true,
        value: { status: "ready", previewId, content: rendered.content },
      };
    },

    async copy(context, input) {
      if (!hasActiveSession(context, input.sessionId)) return sessionFailure();
      const preview = latestPreview;
      if (!preview || preview.id !== input.previewId) return previewFailure();

      try {
        const current = assertQuickPaletteSelectionCurrent(deps.library, {
          promptId: preview.promptId,
          versionId: preview.versionId,
        });
        if (current.templateContent !== preview.templateContent) {
          throw new QuickPaletteError(
            "revision-changed",
            "The current saved version changed. Refresh it before copying.",
          );
        }
      } catch (error) {
        latestPreview = null;
        return quickPaletteFailure(error);
      }

      try {
        deps.clipboardWriteText(preview.content);
      } catch (error) {
        deps.reportError(error);
        return {
          ok: false,
          code: "clipboard-unavailable",
          message: "The system clipboard is unavailable. Try copying again.",
        };
      }
      dismissActiveSession(input.sessionId);
      return { ok: true, value: null };
    },

    dismiss(context, input) {
      if (!hasActiveSession(context, input.sessionId)) return;
      dismissActiveSession(input.sessionId);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (registeredAccelerator) deps.shortcut.unregister(registeredAccelerator);
      registeredAccelerator = null;
      const disposingWindow = window;
      if (sessionId) dismissActiveSession(sessionId);
      window = null;
      ready = false;
      clearSession();
      if (disposingWindow && !disposingWindow.isDestroyed()) disposingWindow.destroy();
    },
  };
}

export function quickPaletteWindowOptions(
  preloadPath: string,
  platform: NodeJS.Platform,
): Record<string, unknown> {
  return {
    width: 600,
    height: 480,
    minWidth: 480,
    minHeight: 360,
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    ...(platform === "darwin" ? { type: "panel" } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

export function registerQuickPaletteIpcHandlers(
  registrar: QuickPaletteIpcRegistrar,
  controller: QuickPaletteController,
): void {
  const context = (event: QuickPaletteIpcEvent): QuickPaletteRequestContext => ({
    sender: event.sender,
    frame: event.senderFrame,
  });
  registrar.handle(IPC_CHANNELS.quickPaletteGetState, (event) =>
    controller.getState(context(event)),
  );
  registrar.handle(IPC_CHANNELS.quickPaletteUpdateSettings, (event, payload) =>
    controller.updateSettings(context(event), quickPaletteSettingsSchema.parse(payload)),
  );
  registrar.handle(IPC_CHANNELS.quickPaletteSearch, async (event, payload) => {
    try {
      return await controller.search(context(event), quickPaletteSearchSchema.parse(payload));
    } catch (error) {
      return quickPaletteFailure(error);
    }
  });
  registrar.handle(IPC_CHANNELS.quickPaletteResolve, async (event, payload) => {
    try {
      return await controller.resolve(context(event), quickPaletteResolveSchema.parse(payload));
    } catch (error) {
      return quickPaletteFailure(error);
    }
  });
  registrar.handle(IPC_CHANNELS.quickPaletteRender, async (event, payload) => {
    try {
      return await controller.render(context(event), quickPaletteRenderSchema.parse(payload));
    } catch (error) {
      return quickPaletteFailure(error);
    }
  });
  registrar.handle(IPC_CHANNELS.quickPaletteCopy, async (event, payload) => {
    try {
      return await controller.copy(context(event), quickPaletteCopySchema.parse(payload));
    } catch (error) {
      return quickPaletteFailure(error);
    }
  });
  registrar.handle(IPC_CHANNELS.quickPaletteDismiss, (event, payload) => {
    try {
      controller.dismiss(context(event), quickPaletteDismissSchema.parse(payload));
    } catch {
      // Dismiss is deliberately idempotent and cannot affect another session.
    }
  });
}
