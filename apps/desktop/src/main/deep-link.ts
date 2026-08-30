/**
 * promptbranch:// deep links. v1 supports exactly one action:
 *   promptbranch://import?url=<encoded snapshot url or id>
 * Kept free of Electron imports so it is unit-testable; main/index.ts does
 * the protocol wiring (open-url / second-instance / cold-start argv).
 */
export function parseImportDeepLink(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "promptbranch:") return null;
  // In scheme://action the action parses as the hostname.
  if (url.hostname !== "import") return null;
  const target = url.searchParams.get("url");
  if (!target) return null;
  // The target is either a raw snapshot id or an http(s) portal URL.
  if (/^[A-Za-z0-9_-]{21}$/.test(target)) return target;
  try {
    const inner = new URL(target);
    if (inner.protocol !== "https:" && inner.protocol !== "http:") return null;
    return target;
  } catch {
    return null;
  }
}

/** Windows/Linux deliver deep links as argv of a (second) instance. */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const parsed = parseImportDeepLink(arg);
    if (parsed) return parsed;
  }
  return null;
}

export interface ImportDispatcherDeps<Win> {
  getWindow: () => Win | null;
  createWindow: () => void;
  send: (window: Win, target: string) => void;
  focus: (window: Win) => void;
}

export interface ImportDispatcher {
  dispatch: (target: string) => void;
  rendererReady: () => void;
  windowClosed: () => void;
  /** Exposed for tests/diagnostics; the queue holds at most one URL. */
  pending: () => string | null;
}

/**
 * Routes an import target to the renderer without ever sending to a
 * webContents that has no listener attached:
 * - window exists AND renderer finished loading → send immediately.
 * - otherwise → queue (only the latest URL is kept — importing is
 *   idempotent, and the most recent link is what the user last clicked);
 *   if no window exists, create one so a dock-only macOS app still reacts.
 * - rendererReady (did-finish-load) flushes the queued URL; windowClosed
 *   resets readiness so a later dispatch never targets a destroyed window.
 */
export function createImportDispatcher<Win>(deps: ImportDispatcherDeps<Win>): ImportDispatcher {
  let ready = false;
  let pendingUrl: string | null = null;

  function dispatch(target: string): void {
    const win = deps.getWindow();
    if (win && ready) {
      deps.send(win, target);
      deps.focus(win);
      return;
    }
    pendingUrl = target;
    if (win) {
      deps.focus(win);
    } else {
      deps.createWindow();
    }
  }

  function rendererReady(): void {
    ready = true;
    if (!pendingUrl) return;
    const win = deps.getWindow();
    if (!win) return;
    const target = pendingUrl;
    pendingUrl = null;
    deps.send(win, target);
  }

  function windowClosed(): void {
    ready = false;
  }

  return {
    dispatch,
    rendererReady,
    windowClosed,
    pending: () => pendingUrl,
  };
}
