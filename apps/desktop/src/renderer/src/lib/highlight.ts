/**
 * Shiki syntax highlighting for fenced code blocks in MarkdownPreview.
 *
 * Fine-grained bundle: shiki/core + only the grammars and themes we ship,
 * with the JavaScript RegExp engine (no WASM fetch — simpler under Electron's
 * file:// loading and the renderer CSP). Chosen over @shikijs/rehype because
 * react-markdown already renders blocks through a custom `pre` component, so
 * highlighting there directly keeps the language header and copy button in
 * one place and avoids a second hast round-trip.
 *
 * Dual themes (github-light / github-dark) are emitted as `--shiki-light` /
 * `--shiki-dark` CSS variables; index.css picks one per `[data-theme]`, so
 * highlighting follows the app theme with no JS.
 *
 * Loading is async (grammar registration); once loaded, highlighting is
 * synchronous. Components show the plain block until ready (progressive
 * enhancement, no suspense) and re-render via useHighlighterReady.
 */
import { useSyncExternalStore } from "react";
import type { HighlighterCore } from "shiki/core";

/** Fence names that explicitly mean "no highlighting". */
const PLAIN = new Set(["plaintext", "text", "txt", "plain"]);

let highlighter: HighlighterCore | null = null;
let highlighterPromise: Promise<HighlighterCore> | null = null;
const readyListeners = new Set<() => void>();

/** Shared highlighter singleton; resolves once grammars/themes are registered. */
export function getHighlighter(): Promise<HighlighterCore> {
  // Dynamic import: the grammars/themes chunk (~1.4 MB minified) loads
  // separately from the initial renderer bundle and is parsed off the
  // critical path. See highlight-impl.ts.
  highlighterPromise ??= import("./highlight-impl")
    .then((m) => m.createHighlighter())
    .then((h) => {
      highlighter = h;
      for (const listener of readyListeners) listener();
      return h;
    });
  return highlighterPromise;
}

// Kick off loading at import time: MarkdownPreview is on screen early, and a
// warm highlighter means the first code block renders highlighted instead of
// upgrading a moment later. (Without this call nothing references
// getHighlighter at module scope and bundlers tree-shake Shiki away.)
void getHighlighter();

function subscribe(listener: () => void): () => void {
  readyListeners.add(listener);
  // A subscriber mounting after load must not wait for a second event.
  if (highlighter) listener();
  return () => readyListeners.delete(listener);
}

/** True once the highlighter is ready; re-renders subscribers on load. */
export function useHighlighterReady(): boolean {
  return useSyncExternalStore(subscribe, () => highlighter !== null);
}

/** Resolve a fence info-string language to a loaded grammar, else null. */
export function resolveLanguage(language: string | null): string | null {
  if (!language || !highlighter) return null;
  const name = language.toLowerCase();
  if (PLAIN.has(name)) return null;
  // getLoadedLanguages() includes each bundle's aliases (ts, py, sh, …).
  return highlighter.getLoadedLanguages().includes(name) ? name : null;
}

// Streaming re-renders MarkdownPreview on every delta, but only the trailing
// code block changes — earlier blocks hit this cache. Bounded (FIFO) so a
// long session of unique blocks can't grow it without limit. Still-growing
// blocks (`partial`) are never stored: each delta would be a unique key and
// a long stream would evict every settled block.
const cache = new Map<string, string>();
const CACHE_LIMIT = 300;

/** Current cache size — exposed for tests only. */
export function highlightCacheSize(): number {
  return cache.size;
}

/**
 * Highlight to dual-theme HTML (Shiki CSS vars; themed via index.css), or
 * null when highlighting is unavailable — not loaded yet, unknown language,
 * or a grammar failure. Null means "render the plain block"; never throws.
 *
 * `partial` marks the still-growing trailing block of a streaming response:
 * it is highlighted but not cached (see above).
 */
export function highlightCode(
  code: string,
  language: string | null,
  options?: { partial?: boolean },
): string | null {
  const lang = resolveLanguage(language);
  if (!highlighter || !lang) return null;
  const key = `${lang}\n${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = highlighter.codeToHtml(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      // No default color: both themes ride on CSS vars, picked per [data-theme].
      defaultColor: false,
    });
  } catch {
    return null;
  }
  if (!options?.partial) {
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, html);
  }
  return html;
}
