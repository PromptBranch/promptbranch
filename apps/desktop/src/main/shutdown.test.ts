import { describe, expect, it, vi } from "vitest";
import { createBeforeQuitHandler, createWillQuitHandler } from "./shutdown.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("main-process shutdown", () => {
  it("blocks repeated quit attempts until sync stops without closing the live renderer database", async () => {
    const stopping = deferred();
    const lifecycle: string[] = [];
    const clearBackgroundWork = vi.fn();
    const stopSync = vi.fn(() => stopping.promise);
    const quit = vi.fn(() => lifecycle.push("quit"));
    const willQuit = createWillQuitHandler({
      disposeSync: vi.fn(() => lifecycle.push("dispose-sync")),
      closeDatabase: vi.fn(() => lifecycle.push("close-database")),
      log: vi.fn(),
    });
    const handler = createBeforeQuitHandler({
      clearBackgroundWork,
      stopSync,
      quit,
      log: vi.fn(),
    });
    const firstEvent = { preventDefault: vi.fn() };
    const repeatedEvent = { preventDefault: vi.fn() };

    const shutdown = handler(firstEvent);
    expect(shutdown).not.toBeNull();
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(clearBackgroundWork).toHaveBeenCalledOnce();
    expect(stopSync).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    expect(handler(repeatedEvent)).toBe(shutdown);
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(stopSync).toHaveBeenCalledOnce();

    stopping.resolve();
    await shutdown;
    expect(quit).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual(["quit"]);

    const finalEvent = { preventDefault: vi.fn() };
    expect(handler(finalEvent)).toBeNull();
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();

    willQuit();
    expect(lifecycle).toEqual(["quit", "dispose-sync", "close-database"]);
  });

  it("still reissues quit when sync shutdown fails", async () => {
    const error = new Error("listener stop failed");
    const quit = vi.fn();
    const log = vi.fn();
    const handler = createBeforeQuitHandler({
      clearBackgroundWork: vi.fn(),
      stopSync: vi.fn(async () => {
        throw error;
      }),
      quit,
      log,
    });

    await handler({ preventDefault: vi.fn() });

    expect(log).toHaveBeenCalledWith("sync shutdown failed", error);
    expect(quit).toHaveBeenCalledOnce();
  });

  it("closes the database once at will-quit after renderer windows are gone", () => {
    const disposeSync = vi.fn();
    const closeDatabase = vi.fn();
    const handler = createWillQuitHandler({
      disposeSync,
      closeDatabase,
      log: vi.fn(),
    });

    handler();
    handler();

    expect(disposeSync).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("logs a database close failure without retrying during will-quit", () => {
    const error = new Error("database close failed");
    const log = vi.fn();
    const handler = createWillQuitHandler({
      disposeSync: vi.fn(),
      closeDatabase: vi.fn(() => {
        throw error;
      }),
      log,
    });

    handler();
    handler();

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("database close failed", error);
  });
});
