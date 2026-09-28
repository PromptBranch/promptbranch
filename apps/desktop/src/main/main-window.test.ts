import { describe, expect, it, vi } from "vitest";
import {
  createMainWindowClosedHandler,
  restoreOrCreateMainWindow,
  shouldQuitWhenMainWindowCloses,
  type MainWindowPort,
} from "./main-window.js";

function fakeWindow(input: { destroyed?: boolean; minimized?: boolean } = {}) {
  const window: MainWindowPort = {
    isDestroyed: () => input.destroyed ?? false,
    isMinimized: () => input.minimized ?? false,
    restore: vi.fn(),
    focus: vi.fn(),
  };
  return window;
}

describe("main library window lifecycle", () => {
  it("restores and focuses an existing minimized library window", () => {
    const window = fakeWindow({ minimized: true });
    const create = vi.fn();

    restoreOrCreateMainWindow(window, create);

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("creates the library when only a hidden palette window remains", () => {
    const create = vi.fn();

    restoreOrCreateMainWindow(null, create);

    expect(create).toHaveBeenCalledOnce();
  });

  it("recreates a destroyed library window", () => {
    const create = vi.fn();

    restoreOrCreateMainWindow(fakeWindow({ destroyed: true }), create);

    expect(create).toHaveBeenCalledOnce();
  });

  it("discards the sender using its ID captured before WebContents destruction", () => {
    let destroyed = false;
    const window = {
      get webContents() {
        if (destroyed) throw new Error("Object has been destroyed");
        return { id: 73 };
      },
    };
    let mainWindow: typeof window | null = window;
    const discardSender = vi.fn();
    const clearMainWindow = vi.fn(() => {
      mainWindow = null;
    });
    const windowClosed = vi.fn();
    const quit = vi.fn();
    const handleClosed = createMainWindowClosedHandler(window, {
      getMainWindow: () => mainWindow,
      onMainWindowClosed: (senderId) => {
        discardSender(senderId);
        clearMainWindow();
      },
      onWindowClosed: windowClosed,
      shouldQuit: () => true,
      quit,
    });

    destroyed = true;
    expect(handleClosed).not.toThrow();
    expect(discardSender).toHaveBeenCalledWith(73);
    expect(clearMainWindow).toHaveBeenCalledOnce();
    expect(windowClosed).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("preserves Windows and Linux close-to-quit while macOS stays windowless", () => {
    expect(shouldQuitWhenMainWindowCloses("darwin")).toBe(false);
    expect(shouldQuitWhenMainWindowCloses("win32")).toBe(true);
    expect(shouldQuitWhenMainWindowCloses("linux")).toBe(true);
  });
});
