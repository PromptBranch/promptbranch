export interface MainWindowPort {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export interface MainWindowLifecyclePort {
  webContents: { id: number };
}

export interface MainWindowClosedHandlerDeps<Window extends MainWindowLifecyclePort> {
  getMainWindow(): Window | null;
  onMainWindowClosed(senderId: number): void;
  onWindowClosed(): void;
  shouldQuit(): boolean;
  quit(): void;
}

/** Capture the renderer identity while its WebContents is still alive. */
export function createMainWindowClosedHandler<Window extends MainWindowLifecyclePort>(
  window: Window,
  deps: MainWindowClosedHandlerDeps<Window>,
): () => void {
  const senderId = window.webContents.id;
  return () => {
    const wasMainWindow = deps.getMainWindow() === window;
    if (wasMainWindow) deps.onMainWindowClosed(senderId);
    deps.onWindowClosed();
    if (wasMainWindow && deps.shouldQuit()) deps.quit();
  };
}

export function restoreOrCreateMainWindow(
  window: MainWindowPort | null,
  createWindow: () => void,
): void {
  if (!window || window.isDestroyed()) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.focus();
}

export function shouldQuitWhenMainWindowCloses(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}
