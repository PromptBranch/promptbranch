import { describe, expect, it, vi } from "vitest";
import { createBeforeQuitHandler } from "./shutdown.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("main-process shutdown", () => {
  it("blocks repeated quit attempts until sync stops and the database closes once", async () => {
    const stopping = deferred();
    const clearBackgroundWork = vi.fn();
    const disposeSync = vi.fn();
    const stopSync = vi.fn(() => stopping.promise);
    const closeDatabase = vi.fn();
    const quit = vi.fn();
    const handler = createBeforeQuitHandler({
      clearBackgroundWork,
      disposeSync,
      stopSync,
      closeDatabase,
      quit,
      log: vi.fn(),
    });
    const firstEvent = { preventDefault: vi.fn() };
    const repeatedEvent = { preventDefault: vi.fn() };

    const shutdown = handler(firstEvent);
    expect(shutdown).not.toBeNull();
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(clearBackgroundWork).toHaveBeenCalledOnce();
    expect(disposeSync).toHaveBeenCalledOnce();
    expect(stopSync).toHaveBeenCalledOnce();
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();

    expect(handler(repeatedEvent)).toBe(shutdown);
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(stopSync).toHaveBeenCalledOnce();

    stopping.resolve();
    await shutdown;
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();

    const finalEvent = { preventDefault: vi.fn() };
    expect(handler(finalEvent)).toBeNull();
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("still closes and reissues quit when sync shutdown fails", async () => {
    const error = new Error("listener stop failed");
    const closeDatabase = vi.fn();
    const quit = vi.fn();
    const log = vi.fn();
    const handler = createBeforeQuitHandler({
      clearBackgroundWork: vi.fn(),
      disposeSync: vi.fn(),
      stopSync: vi.fn(async () => {
        throw error;
      }),
      closeDatabase,
      quit,
      log,
    });

    await handler({ preventDefault: vi.fn() });

    expect(log).toHaveBeenCalledWith("sync shutdown failed", error);
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });
});
