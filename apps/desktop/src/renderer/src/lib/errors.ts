/**
 * Electron wraps rejected ipcRenderer.invoke calls with transport details.
 * Keep the main-process message while hiding channel names from users.
 */
export function userErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^Error:\s*/, "");
}
