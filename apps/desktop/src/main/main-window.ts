export interface MainWindowPort {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
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
