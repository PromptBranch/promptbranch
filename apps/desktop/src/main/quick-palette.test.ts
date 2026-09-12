import { describe, expect, it, vi } from "vitest";
import { openMemoryDatabase, PromptLibrary } from "@promptbranch/core";
import * as quickPaletteModule from "./quick-palette.js";
import {
  createQuickPaletteController,
  quickPaletteWindowOptions,
  type QuickPaletteControllerDeps,
  type QuickPaletteWindowHandlers,
  type QuickPaletteWindowPort,
} from "./quick-palette.js";

class FakeWindow implements QuickPaletteWindowPort {
  readonly sender = {};
  readonly frame = {};
  readonly sent: Array<[string, unknown]> = [];
  shown = 0;
  focused = 0;
  hidden = 0;
  destroyed = 0;

  constructor(readonly handlers: QuickPaletteWindowHandlers) {}

  mainFrame(): unknown {
    return this.frame;
  }

  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload]);
  }

  show(): void {
    this.shown += 1;
  }

  focus(): void {
    this.focused += 1;
  }

  hide(): void {
    this.hidden += 1;
  }

  destroy(): void {
    this.destroyed += 1;
  }

  isDestroyed(): boolean {
    return this.destroyed > 0;
  }
}

function createHarness(savedSetting: string | null = null) {
  const library = new PromptLibrary(openMemoryDatabase());
  const mainSender = {};
  const mainFrame = {};
  const bindings = new Map<string, () => void>();
  const windows: FakeWindow[] = [];
  let setting = savedSetting;
  let uuid = 0;
  const reportError = vi.fn();
  const clipboardWriteText = vi.fn();
  const deps: QuickPaletteControllerDeps = {
    library,
    readSetting: vi.fn(() => setting),
    writeSetting: vi.fn((value) => {
      setting = value;
    }),
    shortcut: {
      register: vi.fn((accelerator, callback) => {
        if (bindings.has(accelerator)) return false;
        bindings.set(accelerator, callback);
        return true;
      }),
      unregister: vi.fn((accelerator) => {
        bindings.delete(accelerator);
      }),
    },
    createWindow: vi.fn((handlers) => {
      const window = new FakeWindow(handlers);
      windows.push(window);
      return window;
    }),
    getMainFrame: () => ({ sender: mainSender, frame: mainFrame }),
    clipboardWriteText,
    uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    reportError,
  };
  const controller = createQuickPaletteController(deps);
  return {
    bindings,
    clipboardWriteText,
    controller,
    deps,
    library,
    mainContext: { sender: mainSender, frame: mainFrame },
    reportError,
    windows,
    get setting() {
      return setting;
    },
  };
}

function paletteContext(window: FakeWindow): { sender: unknown; frame: unknown } {
  return { sender: window.sender, frame: window.frame };
}

async function openReadyPalette(harness: ReturnType<typeof createHarness>) {
  const sessionId = harness.controller.toggle();
  const window = harness.windows.at(-1)!;
  window.handlers.ready();
  await Promise.resolve();
  return { sessionId: sessionId!, window, context: paletteContext(window) };
}

describe("quick palette shortcut settings", () => {
  it("starts disabled by default and registers a valid saved opt-in binding", () => {
    const disabled = createHarness();
    expect(disabled.controller.getState(disabled.mainContext)).toMatchObject({
      settings: { enabled: false, accelerator: "CommandOrControl+Shift+Space" },
      registration: "disabled",
      registrationError: null,
    });
    expect(disabled.deps.shortcut.register).not.toHaveBeenCalled();

    const enabled = createHarness(
      JSON.stringify({ enabled: true, accelerator: "CommandOrControl+Alt+P" }),
    );
    expect(enabled.bindings.has("CommandOrControl+Alt+P")).toBe(true);
    expect(enabled.controller.getState(enabled.mainContext).registration).toBe("registered");
  });

  it("falls back safely when saved settings are corrupt", () => {
    const harness = createHarness("{broken");

    expect(harness.controller.getState(harness.mainContext)).toMatchObject({
      settings: { enabled: false, accelerator: "CommandOrControl+Shift+Space" },
      registration: "disabled",
    });
    expect(harness.controller.getState(harness.mainContext).registrationError).toMatch(/could not be read/i);
    expect(harness.reportError).toHaveBeenCalledOnce();
  });

  it("keeps the working binding when a replacement conflicts", () => {
    const harness = createHarness(
      JSON.stringify({ enabled: true, accelerator: "CommandOrControl+Alt+P" }),
    );
    vi.mocked(harness.deps.shortcut.register).mockImplementationOnce(() => false);

    const state = harness.controller.updateSettings(harness.mainContext, {
      enabled: true,
      accelerator: "CommandOrControl+Shift+Space",
    });

    expect(state.settings.accelerator).toBe("CommandOrControl+Alt+P");
    expect(state.registration).toBe("registered");
    expect(state.registrationError).toMatch(/unavailable/i);
    expect(harness.bindings.has("CommandOrControl+Alt+P")).toBe(true);
    expect(harness.deps.shortcut.unregister).not.toHaveBeenCalled();
  });

  it("rolls back a newly registered replacement when persistence fails", () => {
    const harness = createHarness(
      JSON.stringify({ enabled: true, accelerator: "CommandOrControl+Alt+P" }),
    );
    vi.mocked(harness.deps.writeSetting).mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const state = harness.controller.updateSettings(harness.mainContext, {
      enabled: true,
      accelerator: "CommandOrControl+Shift+Space",
    });

    expect(state.settings.accelerator).toBe("CommandOrControl+Alt+P");
    expect(harness.bindings.has("CommandOrControl+Alt+P")).toBe(true);
    expect(harness.bindings.has("CommandOrControl+Shift+Space")).toBe(false);
    expect(harness.deps.shortcut.unregister).toHaveBeenCalledWith(
      "CommandOrControl+Shift+Space",
    );
    expect(state.registrationError).toMatch(/could not be saved/i);
  });

  it("persists disabling before unregistering the shortcut", () => {
    const harness = createHarness(
      JSON.stringify({ enabled: true, accelerator: "CommandOrControl+Alt+P" }),
    );

    const state = harness.controller.updateSettings(harness.mainContext, {
      enabled: false,
      accelerator: "CommandOrControl+Alt+P",
    });

    expect(state.registration).toBe("disabled");
    expect(harness.bindings.size).toBe(0);
    expect(JSON.parse(harness.setting!)).toEqual({
      enabled: false,
      accelerator: "CommandOrControl+Alt+P",
    });
  });
});

describe("quick palette lifecycle", () => {
  it("queues an opening until the renderer is ready, then emits before showing and focusing", async () => {
    const harness = createHarness();
    const sessionId = harness.controller.toggle();
    const window = harness.windows[0]!;

    expect(sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(window.sent).toEqual([]);
    expect(window.shown).toBe(0);
    window.handlers.blur();
    expect(harness.controller.getState(harness.mainContext).sessionId).toBe(sessionId);

    window.handlers.ready();
    await Promise.resolve();

    expect(window.sent[0]).toEqual(["quick-palette:opened", sessionId]);
    expect(window.shown).toBe(1);
    expect(window.focused).toBe(1);
  });

  it("a repeated toggle dismisses, hides, and clears the active session", async () => {
    const harness = createHarness();
    const { sessionId, window } = await openReadyPalette(harness);

    expect(harness.controller.toggle()).toBeNull();

    expect(window.sent.at(-1)).toEqual(["quick-palette:closed", sessionId]);
    expect(window.hidden).toBe(1);
    expect(harness.controller.getState(harness.mainContext).sessionId).toBeNull();
  });

  it("dismisses on blur only after the palette was shown and focused", async () => {
    const harness = createHarness();
    const sessionId = harness.controller.toggle()!;
    const window = harness.windows[0]!;
    window.handlers.blur();
    expect(harness.controller.getState(harness.mainContext).sessionId).toBe(sessionId);

    window.handlers.ready();
    await Promise.resolve();
    window.handlers.blur();

    expect(harness.controller.getState(harness.mainContext).sessionId).toBeNull();
    expect(window.hidden).toBe(1);
  });

  it.each(["load failure", "renderer crash", "unexpected navigation"])(
    "cleans up an active session after %s",
    async (reason) => {
      const harness = createHarness();
      const { window } = await openReadyPalette(harness);

      window.handlers.failed(new Error(reason));

      expect(harness.controller.getState(harness.mainContext).sessionId).toBeNull();
      expect(window.destroyed).toBe(1);
      expect(harness.reportError).toHaveBeenCalledWith(expect.any(Error));
    },
  );

  it("cleans up a natively closed window and creates a fresh one next time", async () => {
    const harness = createHarness();
    const first = await openReadyPalette(harness);
    first.window.handlers.closed();

    expect(harness.controller.getState(harness.mainContext).sessionId).toBeNull();
    harness.controller.toggle();
    expect(harness.windows).toHaveLength(2);
  });

  it("disposal unregisters, invalidates, destroys, and ignores late window events", async () => {
    const harness = createHarness(
      JSON.stringify({ enabled: true, accelerator: "CommandOrControl+Alt+P" }),
    );
    const sessionId = harness.controller.toggle()!;
    const window = harness.windows[0]!;

    harness.controller.dispose();
    window.handlers.ready();
    await Promise.resolve();

    expect(harness.bindings.size).toBe(0);
    expect(window.destroyed).toBe(1);
    expect(window.sent).not.toContainEqual(["quick-palette:opened", sessionId]);
    expect(harness.controller.toggle()).toBeNull();
  });
});

describe("quick palette request security and copy", () => {
  it("rejects another window, a subframe, and a stale session", async () => {
    const harness = createHarness();
    harness.library.createPrompt({ title: "Greeting", content: "Hello" });
    const { sessionId, window, context } = await openReadyPalette(harness);

    await expect(
      harness.controller.search({ sender: {}, frame: {} }, { sessionId, query: "" }),
    ).resolves.toMatchObject({ ok: false, code: "session-ended" });
    await expect(
      harness.controller.search(
        { sender: context.sender, frame: {} },
        { sessionId, query: "" },
      ),
    ).resolves.toMatchObject({ ok: false, code: "session-ended" });
    await expect(
      harness.controller.search(context, { sessionId: "stale", query: "" }),
    ).resolves.toMatchObject({ ok: false, code: "session-ended" });
    expect(window.hidden).toBe(0);
  });

  it("expires a previous ready preview after a new render", async () => {
    const harness = createHarness();
    const prompt = harness.library.createPrompt({ title: "Greeting", content: "Hello {{name}}" });
    const { sessionId, context } = await openReadyPalette(harness);
    const input = {
      sessionId,
      promptId: prompt.id,
      versionId: prompt.current_version_id!,
      variables: { name: "Ada" },
    };
    const first = await harness.controller.render(context, input);
    const firstPreviewId = first.ok && first.value.status === "ready" ? first.value.previewId : "";
    await harness.controller.render(context, { ...input, variables: { name: "Grace" } });

    await expect(
      harness.controller.copy(context, { sessionId, previewId: firstPreviewId }),
    ).resolves.toMatchObject({ ok: false, code: "preview-expired" });
  });

  it("does not revive a delayed render after dismissal", async () => {
    const harness = createHarness();
    const prompt = harness.library.createPrompt({ title: "Greeting", content: "Hello {{name}}" });
    const { sessionId, context } = await openReadyPalette(harness);

    const rendering = harness.controller.render(context, {
      sessionId,
      promptId: prompt.id,
      versionId: prompt.current_version_id!,
      variables: { name: "Ada" },
    });
    harness.controller.dismiss(context, { sessionId });

    await expect(rendering).resolves.toMatchObject({ ok: false, code: "session-ended" });
  });

  it("retains the palette and disables copy when the current revision changes", async () => {
    const harness = createHarness();
    const prompt = harness.library.createPrompt({ title: "Greeting", content: "Hello {{name}}" });
    const branch = harness.library.listBranches(prompt.id)[0]!;
    const { sessionId, context } = await openReadyPalette(harness);
    const rendered = await harness.controller.render(context, {
      sessionId,
      promptId: prompt.id,
      versionId: prompt.current_version_id!,
      variables: { name: "Ada" },
    });
    const previewId = rendered.ok && rendered.value.status === "ready" ? rendered.value.previewId : "";
    harness.library.createVersion({ promptId: prompt.id, branchId: branch.id, content: "Hi {{name}}" });

    await expect(
      harness.controller.copy(context, { sessionId, previewId }),
    ).resolves.toMatchObject({ ok: false, code: "revision-changed" });
    expect(harness.clipboardWriteText).not.toHaveBeenCalled();
    expect(harness.controller.getState(harness.mainContext).sessionId).toBe(sessionId);
  });

  it("leaves the palette open when the clipboard is unavailable", async () => {
    const harness = createHarness();
    const prompt = harness.library.createPrompt({ title: "Plain", content: "Exact text" });
    const { sessionId, context } = await openReadyPalette(harness);
    const rendered = await harness.controller.render(context, {
      sessionId,
      promptId: prompt.id,
      versionId: prompt.current_version_id!,
      variables: {},
    });
    const previewId = rendered.ok && rendered.value.status === "ready" ? rendered.value.previewId : "";
    harness.clipboardWriteText.mockImplementationOnce(() => {
      throw new Error("clipboard busy");
    });

    await expect(
      harness.controller.copy(context, { sessionId, previewId }),
    ).resolves.toMatchObject({ ok: false, code: "clipboard-unavailable" });
    expect(harness.controller.getState(harness.mainContext).sessionId).toBe(sessionId);
  });

  it("copies only the stored preview bytes and dismisses on success", async () => {
    const harness = createHarness();
    const prompt = harness.library.createPrompt({
      title: "Exact",
      content: "שלום {{name}}\n$1 \\ end",
    });
    const { sessionId, context, window } = await openReadyPalette(harness);
    const rendered = await harness.controller.render(context, {
      sessionId,
      promptId: prompt.id,
      versionId: prompt.current_version_id!,
      variables: { name: "עולם {{literal}}" },
    });
    const previewId = rendered.ok && rendered.value.status === "ready" ? rendered.value.previewId : "";

    await expect(
      harness.controller.copy(context, { sessionId, previewId }),
    ).resolves.toEqual({ ok: true, value: null });
    expect(harness.clipboardWriteText).toHaveBeenCalledWith("שלום עולם {{literal}}\n$1 \\ end");
    expect(window.hidden).toBe(1);
    expect(harness.controller.getState(harness.mainContext).sessionId).toBeNull();
  });
});

describe("quick palette browser window options", () => {
  it("creates the compact sandboxed panel contract without navigation privileges", () => {
    expect(quickPaletteWindowOptions("/app/preload/index.js", "darwin")).toEqual({
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
      type: "panel",
      webPreferences: {
        preload: "/app/preload/index.js",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect(quickPaletteWindowOptions("C:\\app\\preload.js", "win32")).not.toHaveProperty("type");
  });
});

describe("quick palette IPC registration", () => {
  it("validates payloads and routes palette requests with the sender main frame", async () => {
    const register = (
      quickPaletteModule as unknown as {
        registerQuickPaletteIpcHandlers?: (
          registrar: {
            handle(channel: string, handler: (event: unknown, payload?: unknown) => unknown): void;
          },
          controller: ReturnType<typeof createHarness>["controller"],
        ) => void;
      }
    ).registerQuickPaletteIpcHandlers;
    expect(register, "registerQuickPaletteIpcHandlers must be exported").toBeDefined();
    if (!register) return;
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
    const harness = createHarness();
    harness.library.createPrompt({ title: "Greeting", content: "Hello" });
    const opened = await openReadyPalette(harness);
    register(
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      },
      harness.controller,
    );

    const event = { sender: opened.context.sender, senderFrame: opened.context.frame };
    await expect(
      handlers.get("quick-palette:search")!(event, {
        sessionId: opened.sessionId,
        query: "",
      }),
    ).resolves.toMatchObject({ ok: true, value: [{ title: "Greeting" }] });
    await expect(
      handlers.get("quick-palette:search")!(event, {
        sessionId: opened.sessionId,
        query: "x".repeat(501),
      }),
    ).resolves.toMatchObject({ ok: false, code: "invalid-input" });
  });
});
