export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface MainShutdownDeps {
  clearBackgroundWork(): void;
  disposeSync(): void;
  stopSync(): Promise<void>;
  closeDatabase(): void;
  quit(): void;
  log(message: string, error: unknown): void;
}

export function createBeforeQuitHandler(
  deps: MainShutdownDeps,
): (event: BeforeQuitEvent) => Promise<void> | null {
  let readyToQuit = false;
  let shutdown: Promise<void> | null = null;

  return (event) => {
    if (readyToQuit) return null;
    event.preventDefault();
    if (shutdown) return shutdown;

    deps.clearBackgroundWork();
    deps.disposeSync();
    shutdown = (async () => {
      try {
        await deps.stopSync();
      } catch (error) {
        deps.log("sync shutdown failed", error);
      }
      try {
        deps.closeDatabase();
      } catch (error) {
        deps.log("database close failed", error);
      }
      readyToQuit = true;
      deps.quit();
    })();
    return shutdown;
  };
}
