import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Copy, RefreshCw, Search, Star, X } from "lucide-react";
import type {
  QuickPaletteFailureCode,
  QuickPaletteItem,
  QuickPalettePreview,
  QuickPaletteSelection,
} from "../../../shared/ipc.js";
import { initTheme } from "../lib/theme";
import { cx } from "../lib/time";

type RequestStatus = "idle" | "loading" | "ready" | "error";

function failureNeedsRefresh(code: QuickPaletteFailureCode): boolean {
  return code === "revision-changed" || code === "not-found";
}

export function QuickPalette() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<"search" | "detail">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuickPaletteItem[]>([]);
  const [searchStatus, setSearchStatus] = useState<RequestStatus>("idle");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRetry, setSearchRetry] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingItem, setPendingItem] = useState<QuickPaletteItem | null>(null);
  const [selection, setSelection] = useState<QuickPaletteSelection | null>(null);
  const [resolveStatus, setResolveStatus] = useState<RequestStatus>("idle");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Extract<QuickPalettePreview, { status: "ready" }> | null>(null);
  const [missingVariables, setMissingVariables] = useState<string[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [copying, setCopying] = useState(false);
  const [renderRetry, setRenderRetry] = useState(0);

  const sessionRef = useRef<string | null>(null);
  const openingGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const resolveGeneration = useRef(0);
  const renderGeneration = useRef(0);
  const dismissSubmitted = useRef(false);
  const copyButtonRef = useRef<HTMLButtonElement>(null);

  const clearTemporaryState = useCallback(() => {
    setView("search");
    setQuery("");
    setResults([]);
    setSearchStatus("idle");
    setSearchError(null);
    setSearchRetry(0);
    setActiveIndex(0);
    setPendingItem(null);
    setSelection(null);
    setResolveStatus("idle");
    setVariables({});
    setPreview(null);
    setMissingVariables([]);
    setDetailError(null);
    setStale(false);
    setCopying(false);
    setRenderRetry(0);
  }, []);

  const beginSession = useCallback((nextSessionId: string) => {
    if (sessionRef.current === nextSessionId) return;
    openingGeneration.current += 1;
    searchGeneration.current += 1;
    resolveGeneration.current += 1;
    renderGeneration.current += 1;
    dismissSubmitted.current = false;
    sessionRef.current = nextSessionId;
    clearTemporaryState();
    setSessionId(nextSessionId);
    initTheme();
  }, [clearTemporaryState]);

  const endSession = useCallback((closedSessionId?: string) => {
    if (closedSessionId && sessionRef.current !== closedSessionId) return;
    openingGeneration.current += 1;
    searchGeneration.current += 1;
    resolveGeneration.current += 1;
    renderGeneration.current += 1;
    sessionRef.current = null;
    dismissSubmitted.current = false;
    clearTemporaryState();
    setSessionId(null);
  }, [clearTemporaryState]);

  useEffect(() => {
    const generation = ++openingGeneration.current;
    const unsubscribeOpen = window.promptBuilder.quickPalette.onOpen(beginSession);
    const unsubscribeClosed = window.promptBuilder.quickPalette.onClosed(endSession);
    void window.promptBuilder.quickPalette.getState().then((state) => {
      if (openingGeneration.current === generation && state.sessionId) {
        beginSession(state.sessionId);
      }
    }).catch(() => undefined);
    return () => {
      openingGeneration.current += 1;
      searchGeneration.current += 1;
      resolveGeneration.current += 1;
      renderGeneration.current += 1;
      unsubscribeOpen();
      unsubscribeClosed();
    };
  }, [beginSession, endSession]);

  useEffect(() => {
    const refreshTheme = () => initTheme();
    window.addEventListener("storage", refreshTheme);
    return () => window.removeEventListener("storage", refreshTheme);
  }, []);

  useEffect(() => {
    if (!sessionId || view !== "search") return;
    const generation = ++searchGeneration.current;
    setSearchStatus("loading");
    setSearchError(null);
    const timer = window.setTimeout(() => {
      void window.promptBuilder.quickPalette
        .search({ sessionId, query })
        .then((result) => {
          if (
            searchGeneration.current !== generation ||
            sessionRef.current !== sessionId ||
            view !== "search"
          ) {
            return;
          }
          if (!result.ok) {
            setResults([]);
            setSearchStatus("error");
            setSearchError(result.message);
            return;
          }
          setResults(result.value);
          setActiveIndex(0);
          setSearchStatus("ready");
        })
        .catch(() => {
          if (searchGeneration.current !== generation || sessionRef.current !== sessionId) return;
          setResults([]);
          setSearchStatus("error");
          setSearchError("Prompt search is temporarily unavailable.");
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query, searchRetry, sessionId, view]);

  const selectItem = useCallback((item: QuickPaletteItem) => {
    const activeSession = sessionRef.current;
    if (!activeSession) return;
    const generation = ++resolveGeneration.current;
    renderGeneration.current += 1;
    setView("detail");
    setPendingItem(item);
    setSelection(null);
    setResolveStatus("loading");
    setVariables({});
    setPreview(null);
    setMissingVariables([]);
    setDetailError(null);
    setStale(false);
    void window.promptBuilder.quickPalette
      .resolve({ sessionId: activeSession, promptId: item.promptId })
      .then((result) => {
        if (
          resolveGeneration.current !== generation ||
          sessionRef.current !== activeSession
        ) {
          return;
        }
        if (!result.ok) {
          setResolveStatus("error");
          setDetailError(result.message);
          return;
        }
        setSelection(result.value);
        setVariables(Object.fromEntries(result.value.requiredVariables.map((name) => [name, ""])));
        setResolveStatus("ready");
      })
      .catch(() => {
        if (resolveGeneration.current !== generation || sessionRef.current !== activeSession) return;
        setResolveStatus("error");
        setDetailError("This prompt could not be opened. Try again.");
      });
  }, []);

  useEffect(() => {
    if (!sessionId || !selection || resolveStatus !== "ready") return;
    const generation = ++renderGeneration.current;
    const oversized = Object.entries(variables).find(([, value]) => value.length > 100_000);
    if (oversized) {
      setPreview(null);
      setMissingVariables([]);
      setDetailError(`${oversized[0]} must be 100,000 characters or fewer.`);
      return;
    }
    setDetailError(null);
    void window.promptBuilder.quickPalette
      .render({
        sessionId,
        promptId: selection.promptId,
        versionId: selection.versionId,
        variables,
      })
      .then((result) => {
        if (
          renderGeneration.current !== generation ||
          sessionRef.current !== sessionId
        ) {
          return;
        }
        if (!result.ok) {
          setDetailError(result.message);
          if (failureNeedsRefresh(result.code)) setStale(true);
          return;
        }
        if (result.value.status === "needs-input") {
          setPreview(null);
          setMissingVariables(result.value.missingVariables);
          return;
        }
        setPreview(result.value);
        setMissingVariables([]);
        setStale(false);
      })
      .catch(() => {
        if (renderGeneration.current !== generation || sessionRef.current !== sessionId) return;
        setDetailError("The preview could not be rendered. Try again.");
      });
  }, [renderRetry, resolveStatus, selection, sessionId, variables]);

  useEffect(() => {
    if (selection?.requiredVariables.length === 0 && preview && !stale) {
      copyButtonRef.current?.focus();
    }
  }, [preview, selection, stale]);

  const updateVariable = (name: string, value: string) => {
    renderGeneration.current += 1;
    setPreview(null);
    setMissingVariables([]);
    setDetailError(null);
    setStale(false);
    setVariables((current) => ({ ...current, [name]: value }));
  };

  const copyPreview = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession || !preview || stale || copying) return;
    setCopying(true);
    const result = await window.promptBuilder.quickPalette
      .copy({ sessionId: activeSession, previewId: preview.previewId })
      .catch(() => ({
        ok: false as const,
        code: "clipboard-unavailable" as const,
        message: "The system clipboard is unavailable. Try again.",
      }));
    if (sessionRef.current !== activeSession) return;
    setCopying(false);
    if (result.ok) {
      endSession(activeSession);
      return;
    }
    setDetailError(result.message);
    if (failureNeedsRefresh(result.code)) setStale(true);
  }, [copying, endSession, preview, stale]);

  const refreshSelection = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession || !selection) return;
    const generation = ++resolveGeneration.current;
    renderGeneration.current += 1;
    setResolveStatus("loading");
    setDetailError(null);
    const result = await window.promptBuilder.quickPalette
      .resolve({ sessionId: activeSession, promptId: selection.promptId })
      .catch(() => ({
        ok: false as const,
        code: "not-found" as const,
        message: "The current saved version could not be refreshed.",
      }));
    if (resolveGeneration.current !== generation || sessionRef.current !== activeSession) return;
    if (!result.ok) {
      setResolveStatus("error");
      setDetailError(result.message);
      return;
    }
    const nextVariables = Object.fromEntries(
      result.value.requiredVariables.map((name) => [name, variables[name] ?? ""]),
    );
    setSelection(result.value);
    setVariables(nextVariables);
    setPreview(null);
    setMissingVariables([]);
    setStale(false);
    setResolveStatus("ready");
  }, [selection, variables]);

  const backToSearch = () => {
    resolveGeneration.current += 1;
    renderGeneration.current += 1;
    setView("search");
    setPendingItem(null);
    setSelection(null);
    setResolveStatus("idle");
    setVariables({});
    setPreview(null);
    setMissingVariables([]);
    setDetailError(null);
    setStale(false);
  };

  const submitDismiss = useCallback(() => {
    const activeSession = sessionRef.current;
    if (!activeSession || dismissSubmitted.current) return;
    dismissSubmitted.current = true;
    void window.promptBuilder.quickPalette.dismiss({ sessionId: activeSession });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        submitDismiss();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault();
        void copyPreview();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copyPreview, submitDismiss]);

  if (!sessionId) return <div className="h-full bg-app" aria-hidden="true" />;

  return (
    <main className="flex h-full min-h-0 flex-col bg-panel text-ink">
      <header className="pb-drag flex h-11 shrink-0 items-center border-b border-line px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            PromptBranch quick access
          </p>
        </div>
        <button
          type="button"
          onClick={submitDismiss}
          aria-label="Close prompt palette"
          className="pb-no-drag rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <X size={15} />
        </button>
      </header>

      {view === "search" ? (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search size={15} className="shrink-0 text-ink-faint" aria-hidden="true" />
            <label htmlFor="quick-palette-search" className="sr-only">Search prompts</label>
            <input
              id="quick-palette-search"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((index) => Math.min(index + 1, Math.max(0, results.length - 1)));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((index) => Math.max(index - 1, 0));
                } else if (event.key === "Enter" && results[activeIndex]) {
                  event.preventDefault();
                  selectItem(results[activeIndex]);
                }
              }}
              placeholder="Search saved prompts…"
              className="w-full bg-transparent py-3 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </div>

          <div
            role="listbox"
            aria-label="Saved prompts"
            className="min-h-0 flex-1 overflow-y-auto p-2"
          >
            {searchStatus === "loading" && results.length === 0 && (
              <p className="px-3 py-8 text-center text-xs text-ink-faint">Searching saved prompts…</p>
            )}
            {searchStatus === "ready" && results.length === 0 && (
              <div className="px-4 py-10 text-center">
                <p className="text-sm font-medium text-ink-dim">
                  {query.trim() ? `No matches for “${query.trim()}”` : "No saved prompts yet"}
                </p>
                <p className="mt-1 text-xs text-ink-faint">
                  {query.trim() ? "Try a different search." : "Create a saved prompt in the library first."}
                </p>
              </div>
            )}
            {searchStatus === "error" && (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-danger">{searchError}</p>
                <button
                  type="button"
                  onClick={() => setSearchRetry((value) => value + 1)}
                  className="mt-3 rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                >
                  Try again
                </button>
              </div>
            )}
            {results.map((item, index) => (
              <button
                key={item.promptId}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => selectItem(item)}
                className={cx(
                  "mb-1 flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                  index === activeIndex
                    ? "border-line-strong bg-accent-soft"
                    : "border-transparent hover:bg-hover",
                )}
              >
                <Star
                  size={14}
                  aria-hidden="true"
                  className={item.starred ? "mt-0.5 shrink-0 text-star" : "mt-0.5 shrink-0 text-ink-faint"}
                  fill={item.starred ? "currentColor" : "none"}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{item.title}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-faint">
                    <span>{item.currentVersionLabel}</span>
                    {item.matchedHistory && <span>Match in saved history</span>}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <footer className="flex shrink-0 items-center gap-4 border-t border-line px-3 py-2 text-[10px] text-ink-faint">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>esc close</span>
          </footer>
        </section>
      ) : (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <button
              type="button"
              onClick={backToSearch}
              aria-label="Back to search"
              className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <ArrowLeft size={15} />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">{selection?.title ?? pendingItem?.title}</h1>
              {(selection ?? pendingItem) && (
                <p className="text-[11px] text-ink-faint">
                  {selection?.versionLabel ?? pendingItem?.currentVersionLabel}
                </p>
              )}
            </div>
          </div>

          {resolveStatus === "loading" && !selection ? (
            <p className="flex flex-1 items-center justify-center text-xs text-ink-faint">Opening saved prompt…</p>
          ) : resolveStatus === "error" && !selection ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <p className="text-sm text-danger">{detailError}</p>
              {pendingItem && (
                <button
                  type="button"
                  onClick={() => selectItem(pendingItem)}
                  className="mt-3 rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-hover"
                >
                  Try again
                </button>
              )}
            </div>
          ) : selection ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
              {selection.requiredVariables.length > 0 && (
                <div className="grid gap-2">
                  {selection.requiredVariables.map((name, index) => (
                    <label key={name} htmlFor={`quick-variable-${index}`} className="grid gap-1">
                      <span className="text-[11px] font-medium text-ink-dim">{name}</span>
                      <textarea
                        id={`quick-variable-${index}`}
                        aria-label={name}
                        rows={1}
                        value={variables[name] ?? ""}
                        onChange={(event) => updateVariable(name, event.target.value)}
                        onInput={(event) => {
                          const field = event.currentTarget;
                          field.style.height = "auto";
                          field.style.height = `${Math.min(field.scrollHeight, 128)}px`;
                        }}
                        className="max-h-32 min-h-8 resize-none overflow-y-auto rounded-md border border-line-strong bg-app px-2.5 py-1.5 text-xs leading-5 text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                    </label>
                  ))}
                </div>
              )}

              <div className="flex min-h-0 flex-1 flex-col gap-1">
                <p className="text-[11px] font-medium text-ink-dim">Prompt preview</p>
                <pre
                  role="region"
                  aria-label="Prompt preview"
                  className="min-h-24 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-app p-3 font-mono text-xs leading-5 text-ink"
                >
                  {preview?.content ?? "Preview appears after all required variables are filled."}
                </pre>
              </div>

              {missingVariables.length > 0 && (
                <p className="text-[11px] text-ink-faint">Fill all required variables to enable Copy.</p>
              )}
              {detailError && <p className="text-[11px] text-danger">{detailError}</p>}
              {stale ? (
                <button
                  type="button"
                  onClick={() => void refreshSelection()}
                  className="inline-flex w-fit items-center gap-1.5 rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                >
                  <RefreshCw size={13} />
                  Refresh current version
                </button>
              ) : detailError && !preview ? (
                <button
                  type="button"
                  onClick={() => setRenderRetry((value) => value + 1)}
                  className="w-fit rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-hover"
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}

          <footer className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-2.5">
            <p className="mr-auto text-[10px] text-ink-faint">⌘/Ctrl + Enter copies explicitly</p>
            <button
              ref={copyButtonRef}
              type="button"
              disabled={!preview || stale || copying}
              onClick={() => void copyPreview()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Copy size={13} />
              {copying ? "Copying…" : "Copy prompt"}
            </button>
          </footer>
        </section>
      )}
    </main>
  );
}
