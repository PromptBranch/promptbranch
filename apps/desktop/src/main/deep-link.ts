/**
 * promptbranch:// deep links. The import actions are:
 *   promptbranch://import?url=<encoded snapshot URL or id>
 *   promptbranch://import-markdown?url=<encoded HTTPS Markdown URL>
 * Kept free of Electron imports so it is unit-testable; main/index.ts does
 * the protocol wiring (open-url / second-instance / cold-start argv).
 */
export type ImportIntent =
  | { kind: "snapshot"; target: string }
  | { kind: "markdown"; url: string };

const MAX_DEEP_LINK_LENGTH = 2_000;

export function parseImportDeepLink(rawUrl: string): ImportIntent | null {
  if (rawUrl.length > MAX_DEEP_LINK_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "promptbranch:") return null;
  // In scheme://action the action parses as the hostname.
  if (url.hostname !== "import" && url.hostname !== "import-markdown") return null;

  const targets = url.searchParams.getAll("url");
  if (targets.length !== 1 || !targets[0]) return null;
  const target = targets[0];

  if (url.hostname === "import-markdown") {
    try {
      const markdownUrl = new URL(target);
      if (markdownUrl.protocol !== "https:") return null;
      return { kind: "markdown", url: target };
    } catch {
      return null;
    }
  }

  // The existing snapshot target is either a raw id or an http(s) portal URL.
  if (/^[A-Za-z0-9_-]{21}$/.test(target)) return { kind: "snapshot", target };
  try {
    const snapshotUrl = new URL(target);
    if (snapshotUrl.protocol !== "https:" && snapshotUrl.protocol !== "http:") return null;
    return { kind: "snapshot", target };
  } catch {
    return null;
  }
}

/** Windows/Linux deliver deep links as argv of a (second) instance. */
export function deepLinkFromArgv(argv: readonly string[]): ImportIntent | null {
  for (const arg of argv) {
    const parsed = parseImportDeepLink(arg);
    if (parsed) return parsed;
  }
  return null;
}

export interface ImportDispatcherDeps<Win> {
  getWindow: () => Win | null;
  createWindow: () => void;
  send: (window: Win, intent: ImportIntent) => void;
  focus: (window: Win) => void;
}

export interface ImportDispatcher {
  dispatch: (intent: ImportIntent) => void;
  rendererReady: () => void;
  windowClosed: () => void;
  /** Exposed for tests/diagnostics; the queue holds at most one import. */
  pending: () => ImportIntent | null;
}

/**
 * Routes an import target to the renderer without ever sending to a
 * webContents that has no listener attached:
 * - window exists AND renderer finished loading → send immediately.
 * - otherwise → queue (only the latest import is kept);
 *   if no window exists, create one so a dock-only macOS app still reacts.
 * - rendererReady (did-finish-load) flushes the queued import; windowClosed
 *   resets readiness so a later dispatch never targets a destroyed window.
 */
export function createImportDispatcher<Win>(deps: ImportDispatcherDeps<Win>): ImportDispatcher {
  let ready = false;
  let pendingIntent: ImportIntent | null = null;

  function dispatch(intent: ImportIntent): void {
    const win = deps.getWindow();
    if (win && ready) {
      deps.send(win, intent);
      deps.focus(win);
      return;
    }
    pendingIntent = intent;
    if (win) {
      deps.focus(win);
    } else {
      deps.createWindow();
    }
  }

  function rendererReady(): void {
    ready = true;
    if (!pendingIntent) return;
    const win = deps.getWindow();
    if (!win) return;
    const intent = pendingIntent;
    pendingIntent = null;
    deps.send(win, intent);
  }

  function windowClosed(): void {
    ready = false;
  }

  return {
    dispatch,
    rendererReady,
    windowClosed,
    pending: () => pendingIntent,
  };
}
