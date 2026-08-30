/**
 * The single searchable model picker — the heart of the provider UX.
 *
 * Available models are computed, not managed: every catalog model of a
 * connected provider is available unless explicitly hidden, plus the declared
 * models of openai-compatible endpoints. The picker is a command-palette-style
 * popover (search-first, keyboard navigable) used both for the multi-select
 * run flow and the single-select assist dialogs.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, EyeOff, Search, SlidersHorizontal } from "lucide-react";
import type { AiCatalogModelDto, AiProviderDriver } from "../../../shared/ipc.js";
import { useAiCatalog, useAiProviders, useAppMutation } from "../hooks/use-data";
import { useAppState } from "../state/app-state";
import { cx } from "../lib/time";
import type { ModelRef } from "../lib/ai-prefs";

export interface AvailableModel extends ModelRef {
  providerName: string;
  driver: AiProviderDriver;
  displayName: string | null;
  /** Catalog metadata (context window, pricing) — null for declared models. */
  meta: AiCatalogModelDto | null;
}

export function modelRefKey(ref: ModelRef): string {
  return `${ref.providerId} ${ref.modelId}`;
}

/** Maximum simultaneous run models — mirrors aiRunSchema's modelRefs cap. */
export const MAX_MULTI_SELECT = 6;

/**
 * All runnable models across enabled providers: catalog models (minus hidden
 * ones) for catalog-backed providers (any models.dev id), declared+enabled
 * models for custom openai-compatible endpoints.
 */
export function useAvailableModels(): AvailableModel[] {
  const { data: providers } = useAiProviders();
  const { data: catalog } = useAiCatalog();
  return (providers ?? [])
    .filter((p) => p.enabled)
    .flatMap((p): AvailableModel[] => {
      const hidden = new Set(p.models.filter((m) => !m.enabled).map((m) => m.modelId));
      if (p.type === "openai-compatible") {
        return p.models
          .filter((m) => m.enabled)
          .map((m) => ({
            providerId: p.id,
            modelId: m.modelId,
            providerName: p.name,
            driver: p.driver,
            displayName: m.displayName,
            meta: null,
          }));
      }
      return (catalog?.models[p.type] ?? [])
        .filter((m) => !hidden.has(m.id))
        .map((m) => ({
          providerId: p.id,
          modelId: m.id,
          providerName: p.name,
          driver: p.driver,
          displayName: m.name,
          meta: m,
        }));
    });
}

export function formatContext(tokens: number | null): string | null {
  if (tokens === null) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M ctx`;
  return `${Math.round(tokens / 1000)}k ctx`;
}

export function formatPricing(model: AiCatalogModelDto): string | null {
  if (model.costInput === null && model.costOutput === null) return null;
  const fmt = (v: number | null) => (v === null ? "—" : `$${v < 1 ? v.toFixed(2) : v.toFixed(1)}`);
  return `${fmt(model.costInput)}/${fmt(model.costOutput)} per 1M`;
}

function matchesQuery(model: AvailableModel, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    model.modelId.toLowerCase().includes(q) ||
    (model.displayName ?? "").toLowerCase().includes(q) ||
    model.providerName.toLowerCase().includes(q)
  );
}

interface RowEntry {
  model: AvailableModel;
  group: string;
}

/** Flattens (recents + per-provider groups) into row order for keyboard nav. */
function buildRows(models: AvailableModel[], recents: ModelRef[], query: string): RowEntry[] {
  const visible = models.filter((m) => matchesQuery(m, query));
  const rows: RowEntry[] = [];
  if (!query.trim() && recents.length > 0) {
    const recentKeys = new Set(recents.map(modelRefKey));
    for (const model of visible.filter((m) => recentKeys.has(modelRefKey(m)))) {
      rows.push({ model, group: "Recent" });
    }
  }
  const recentShown = new Set(rows.map((r) => modelRefKey(r.model)));
  const byProvider = new Map<string, AvailableModel[]>();
  for (const model of visible) {
    if (recentShown.has(modelRefKey(model))) continue;
    const list = byProvider.get(model.providerName) ?? [];
    list.push(model);
    byProvider.set(model.providerName, list);
  }
  for (const [providerName, providerModels] of byProvider) {
    for (const model of providerModels) rows.push({ model, group: providerName });
  }
  return rows;
}

export function ModelPicker({
  multi,
  selection,
  onChange,
  recents = [],
  open,
  onOpenChange,
  disabled,
  align = "end",
  fullWidthTrigger = false,
}: {
  /** Multi-select (run flow) vs single-select (assist dialogs). */
  multi: boolean;
  /** Current selection; holds at most one ref in single mode. */
  selection: ModelRef[];
  onChange: (next: ModelRef[]) => void;
  /** Per-prompt recent refs, surfaced as a "Recent" group. */
  recents?: ModelRef[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  align?: "start" | "center" | "end";
  /** Render the trigger as a full-width form field (assist dialogs). */
  fullWidthTrigger?: boolean;
}) {
  const { openSettings, setManageModelsOpen } = useAppState();
  const models = useAvailableModels();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  // Set by keyboard navigation; mouse-enter must not trigger scrollIntoView.
  const keyboardNavRef = useRef(false);
  const optionId = (index: number) => `${listId}-option-${index}`;

  const hide = useAppMutation(
    (model: AvailableModel) =>
      window.promptBuilder.ai.providers.setModelHidden({
        providerId: model.providerId,
        modelId: model.modelId,
        hidden: true,
      }),
    { quiet: true },
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  const rows = useMemo(() => buildRows(models, recents, query), [models, recents, query]);
  const selected = new Set(selection.map(modelRefKey));

  const choose = (model: AvailableModel) => {
    const key = modelRefKey(model);
    if (multi) {
      if (selected.has(key)) {
        onChange(selection.filter((r) => modelRefKey(r) !== key));
      } else if (selection.length < MAX_MULTI_SELECT) {
        onChange([...selection, { providerId: model.providerId, modelId: model.modelId }]);
      }
      // At the cap, clicks on unselected rows are ignored (hint shown below).
    } else {
      onChange([{ providerId: model.providerId, modelId: model.modelId }]);
      onOpenChange(false);
    }
  };

  const hideModel = (model: AvailableModel) => {
    const key = modelRefKey(model);
    if (selected.has(key)) onChange(selection.filter((r) => modelRefKey(r) !== key));
    hide.mutate(model);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      keyboardNavRef.current = true;
      setActiveIndex((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      keyboardNavRef.current = true;
      setActiveIndex((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[activeIndex];
      if (row) choose(row.model);
    }
  };

  const triggerLabel = multi
    ? selection.length === 0
      ? "Select models"
      : `${selection.length} model${selection.length > 1 ? "s" : ""}`
    : (() => {
        const current = selection[0] ? models.find((m) => modelRefKey(m) === modelRefKey(selection[0]!)) : undefined;
        return current
          ? (current.displayName ?? current.modelId)
          : selection[0]
            ? selection[0]!.modelId
            : "Select model";
      })();

  let lastGroup: string | null = null;

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cx(
            "flex items-center gap-1.5 rounded-md border text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            fullWidthTrigger
              ? "w-full justify-between border-line bg-app px-2.5 py-1.5 text-ink hover:border-line-strong"
              : "min-w-0 max-w-32 border-line bg-panel px-2.5 py-1.5 text-ink hover:border-line-strong @max-lg:max-w-24 @max-md:max-w-16",
          )}
        >
          <span className={cx("min-w-0 truncate tabular-nums", !multi && selection.length === 0 && "text-ink-faint")}>
            {triggerLabel}
          </span>
          <ChevronDown size={12} className="shrink-0 text-ink-faint" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={6}
          onOpenAutoFocus={(event) => {
            // Focus the search input, not the content wrapper.
            event.preventDefault();
            listRef.current?.querySelector("input")?.focus();
          }}
          // z-[80]: the picker also lives inside dialogs (judge dialog content
          // is z-[70], its overlay z-[60]) — a lower z would put the options
          // under the dialog's own overlay and swallow option clicks.
          className="pb-menu z-[80] flex max-h-[min(24rem,calc(100vh-5rem))] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-line-strong bg-raised shadow-xl shadow-black/40"
        >
          <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
            <Search size={12} className="shrink-0 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
                keyboardNavRef.current = true;
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search models…"
              aria-label="Search models"
              role="combobox"
              aria-expanded
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={rows[activeIndex] ? optionId(activeIndex) : undefined}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-multiselectable={multi || undefined}
            className="min-h-0 flex-1 overflow-y-auto p-1"
          >
            {models.length === 0 ? (
              <div className="px-2 py-4 text-center">
                <p className="text-[11px] leading-relaxed text-ink-faint">
                  No models available yet — connect a provider and its models just work.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    openSettings("ai");
                  }}
                  className="mt-2 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong"
                >
                  Connect a provider…
                </button>
              </div>
            ) : rows.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-ink-faint">No models match “{query}”.</p>
            ) : (
              rows.map((row, index) => {
                const header =
                  row.group !== lastGroup ? (
                    <p
                      key={`group-${row.group}-${index}`}
                      className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint"
                    >
                      {row.group}
                    </p>
                  ) : null;
                lastGroup = row.group;
                const isSelected = selected.has(modelRefKey(row.model));
                const hint = row.model.meta
                  ? [formatContext(row.model.meta.contextWindow), formatPricing(row.model.meta)].filter(Boolean).join(" · ")
                  : null;
                return (
                  <div key={`${modelRefKey(row.model)}-${row.group}`}>
                    {header}
                    <div
                      id={optionId(index)}
                      role="option"
                      aria-selected={isSelected}
                      tabIndex={-1}
                      onClick={() => choose(row.model)}
                      onMouseEnter={() => {
                        keyboardNavRef.current = false;
                        setActiveIndex(index);
                      }}
                      ref={
                        index === activeIndex
                          ? (el) => {
                              // Only keyboard navigation scrolls the list.
                              if (el && keyboardNavRef.current) el.scrollIntoView({ block: "nearest" });
                            }
                          : undefined
                      }
                      className={cx(
                        "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px]",
                        index === activeIndex ? "bg-hover text-ink" : "text-ink-dim",
                      )}
                    >
                      {multi && (
                        <span
                          className={cx(
                            "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                            isSelected ? "border-accent bg-accent text-white" : "border-line-strong",
                          )}
                        >
                          {isSelected && <Check size={10} />}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {row.model.displayName ?? row.model.modelId}
                        {row.model.displayName && row.model.displayName !== row.model.modelId && (
                          <span className="ml-1.5 font-mono text-[10px] text-ink-faint">{row.model.modelId}</span>
                        )}
                      </span>
                      {hint && <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">{hint}</span>}
                      <button
                        type="button"
                        aria-label={`Hide ${row.model.modelId}`}
                        title="Hide this model"
                        onClick={(event) => {
                          event.stopPropagation();
                          hideModel(row.model);
                        }}
                        className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <EyeOff size={11} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="border-t border-line p-1">
            {multi && selection.length >= MAX_MULTI_SELECT && (
              <p className="px-2 pb-0.5 pt-1 text-[10px] text-ink-faint">
                Max {MAX_MULTI_SELECT} models — deselect one to pick another.
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                setManageModelsOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            >
              <SlidersHorizontal size={12} className="text-ink-faint" />
              Manage models
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
