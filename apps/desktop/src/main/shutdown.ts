export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface MainShutdownDeps {
  clearBackgroundWork(): void;
  stopSync(): Promise<void>;
  quit(): void;
  log(message: string, error: unknown): void;
}

export interface WillQuitDeps {
  disposeSync(): void;
  closeDatabase(): void;
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
    shutdown = (async () => {
      try {
        await deps.stopSync();
      } catch (error) {
        deps.log("sync shutdown failed", error);
      }
      readyToQuit = true;
      deps.quit();
    })();
    return shutdown;
  };
}

export function createWillQuitHandler(deps: WillQuitDeps): () => void {
  let databaseClosed = false;

  return () => {
    if (databaseClosed) return;
    databaseClosed = true;
    deps.disposeSync();
    try {
      deps.closeDatabase();
    } catch (error) {
      deps.log("database close failed", error);
    }
  };
}
