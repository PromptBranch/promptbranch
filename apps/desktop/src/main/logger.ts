type LogSink = Pick<Console, "log">;

function isBrokenOutputPipe(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EIO" || code === "EPIPE";
}

/**
 * Forwards renderer console output without letting a closed dev terminal take
 * down the Electron main process. Other logger failures remain visible.
 */
export function logRendererConsoleMessage(logger: LogSink, level: number, message: string): void {
  const name = ["verbose", "info", "warning", "error"][level] ?? String(level);
  try {
    logger.log(`[renderer:${name}] ${message.slice(0, 500)}`);
  } catch (error) {
    if (!isBrokenOutputPipe(error)) throw error;
  }
}
