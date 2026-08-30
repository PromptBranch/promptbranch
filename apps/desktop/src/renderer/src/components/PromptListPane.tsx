import { useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { ArrowDownWideNarrow, Check, FileText, PanelLeftClose, PanelLeftOpen, Plus, Search, SlidersHorizontal, Star, Trash2 } from "lucide-react";
import type { PromptSummary, SortKey } from "../../../shared/ipc.js";
import { useAppMutation, useCollections, usePromptList, useTags } from "../hooks/use-data";
import { cx, relativeTime } from "../lib/time";
import { useAppState, EMPTY_FILTERS } from "../state/app-state";
import { colorForName, EmptyState, Spinner, TagChip } from "./ui";

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "updated", label: "Updated" },
  { value: "created", label: "Created" },
  { value: "title", label: "Name" },
  { value: "rating", label: "Rating" },
];

const VIEW_TITLES: Record<string, string> = {
  library: "Library",
  starred: "Starred",
  trash: "Trash",
};

function FilterPopover() {
  const { filters, setFilters } = useAppState();
  const { data: tags } = useTags();
  const { data: collections } = useCollections();
  const [open, setOpen] = useState(false);

  const activeCount =
    filters.tagIds.length + (filters.starredOnly ? 1 : 0) + (filters.minRating !== undefined ? 1 : 0);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cx(
            "relative flex h-7 w-7 items-center justify-center rounded-md border border-line text-ink-dim transition-colors",
            "hover:bg-hover hover:text-ink",
            activeCount > 0 && "border-accent/50 text-accent",
          )}
          aria-label="Filters"
        >
          <SlidersHorizontal size={13} />
          {activeCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-[9px] font-semibold text-white">
              {activeCount}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="pb-menu z-50 w-64 rounded-lg border border-line-strong bg-raised p-3 shadow-xl shadow-black/40"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-ink">Filters</span>
            {activeCount > 0 && (
              <button
                type="button"
                className="text-[11px] text-accent hover:underline"
                onClick={() => setFilters(EMPTY_FILTERS)}
              >
                Clear all
              </button>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Tags</p>
              <div className="max-h-36 space-y-0.5 overflow-y-auto">
                {(tags ?? []).length === 0 && <p className="text-[11px] text-ink-faint">No tags yet</p>}
                {(tags ?? []).map((tag) => {
                  const checked = filters.tagIds.includes(tag.id);
                  return (
                    <label
                      key={tag.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[12px] text-ink-dim hover:bg-hover"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setFilters({
                            ...filters,
                            tagIds: checked
                              ? filters.tagIds.filter((id) => id !== tag.id)
                              : [...filters.tagIds, tag.id],
                          })
                        }
                        className="accent-accent"
                      />
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color ?? colorForName(tag.name) }}
                      />
                      <span className="min-w-0 truncate">{tag.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-dim">
              <input
                type="checkbox"
                checked={filters.starredOnly}
                onChange={(e) => setFilters({ ...filters, starredOnly: e.target.checked })}
                className="accent-accent"
              />
              Starred only
            </label>

            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                Minimum rating
              </p>
              <select
                value={filters.minRating ?? ""}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    minRating: e.target.value === "" ? undefined : Number(e.target.value),
                  })
                }
                className="w-full rounded-md border border-line bg-app px-2 py-1 text-[12px] text-ink focus:border-accent/60 focus:outline-none"
              >
                <option value="">Any rating</option>
                <option value="3">3+ stars</option>
                <option value="4">4+ stars</option>
                <option value="4.5">4.5+ stars</option>
              </select>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SortDropdown() {
  const { sort, setSort } = useAppState();
  const current = SORT_OPTIONS.find((o) => o.value === sort);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
        >
          <ArrowDownWideNarrow size={12} />
          {current?.label ?? "Sort"}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="pb-menu z-50 w-36 rounded-lg border border-line-strong bg-raised p-1 shadow-xl shadow-black/40"
        >
          <DropdownMenu.RadioGroup value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            {SORT_OPTIONS.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-[12px] text-ink-dim outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
              >
                {option.label}
                <DropdownMenu.ItemIndicator>
                  <Check size={12} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function PromptCard({ prompt }: { prompt: PromptSummary }) {
  const { selectedPromptId, selectPrompt } = useAppState();
  const setStarred = useAppMutation(
    (starred: boolean) => window.promptBuilder.prompts.setStarred(prompt.id, starred),
    { quiet: true },
  );
  const selected = selectedPromptId === prompt.id;

  return (
    <button
      type="button"
      onClick={() => selectPrompt(prompt.id)}
      className={cx(
        "group relative w-full rounded-lg border bg-panel p-3 text-left transition-colors",
        selected
          ? "border-accent/60 ring-1 ring-accent/40"
          : "border-line hover:border-line-strong hover:bg-raised",
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <FileText size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[13px] font-semibold text-ink">{prompt.title}</span>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                setStarred.mutate(!prompt.isStarred);
              }}
              className={cx(
                "shrink-0 rounded p-0.5 transition-colors",
                prompt.isStarred ? "text-star" : "text-ink-faint opacity-0 hover:text-star group-hover:opacity-100",
              )}
              aria-label={prompt.isStarred ? "Unstar" : "Star"}
            >
              <Star size={13} fill={prompt.isStarred ? "currentColor" : "none"} />
            </span>
          </div>
          {prompt.description && (
            <p className="mt-0.5 truncate text-[12px] text-ink-dim">{prompt.description}</p>
          )}
          {prompt.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {prompt.tags.slice(0, 4).map((tag) => (
                <TagChip key={tag.id} name={tag.name} color={tag.color ?? colorForName(tag.name)} />
              ))}
              {prompt.tags.length > 4 && (
                <span className="text-[10px] text-ink-faint">+{prompt.tags.length - 4}</span>
              )}
            </div>
          )}
          <p className="mt-1.5 text-[11px] text-ink-faint">
            {prompt.versionLabel ?? "v1"} · You · {relativeTime(prompt.updatedAt)}
          </p>
        </div>
      </div>
    </button>
  );
}

export function PromptListPane({
  collapsed = false,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { view, listSearch, setListSearch, setNewPromptOpen, filters } = useAppState();
  const { data: prompts, isLoading } = usePromptList();

  const filtered = useMemo(() => {
    const list = prompts ?? [];
    const q = listSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        p.tags.some((t) => t.name.toLowerCase().includes(q)),
    );
  }, [prompts, listSearch]);

  const title =
    view.kind === "collection" ? (view.collectionName ?? "Collection") : (VIEW_TITLES[view.kind] ?? "Library");
  const subheader =
    view.kind === "library" && (filters.tagIds.length > 0 || filters.starredOnly || filters.minRating !== undefined)
      ? "Filtered"
      : view.kind === "library"
        ? "All Prompts"
        : title;
  const hasActiveListCriteria =
    listSearch.trim().length > 0 ||
    (view.kind === "library" &&
      (filters.tagIds.length > 0 || filters.starredOnly || filters.minRating !== undefined));

  // Slim strip shown when the list panel is collapsed.
  if (collapsed) {
    return (
      <section className="flex h-full w-full flex-col items-center gap-1 bg-app py-2">
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand prompt list"
          aria-label="Expand prompt list"
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        >
          <PanelLeftOpen size={14} />
        </button>
        <button
          type="button"
          onClick={() => setNewPromptOpen(true)}
          title="New prompt"
          aria-label="New prompt"
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink"
        >
          <Plus size={14} />
        </button>
      </section>
    );
  }

  return (
    <section className="flex h-full w-full flex-col bg-app">
      <div className="border-b border-line px-3 pb-3 pt-3.5">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <h1 className="min-w-0 truncate text-[14px] font-semibold text-ink">{title}</h1>
          <div className="flex shrink-0 items-center gap-1.5">
            {view.kind === "library" && <FilterPopover />}
            <button
              type="button"
              onClick={() => setNewPromptOpen(true)}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-white transition-colors hover:bg-accent-strong"
              aria-label="New prompt"
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              onClick={onToggleCollapse}
              title="Collapse prompt list"
              aria-label="Collapse prompt list"
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <PanelLeftClose size={13} />
            </button>
          </div>
        </div>
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            id="prompt-search-input"
            value={listSearch}
            onChange={(e) => setListSearch(e.target.value)}
            placeholder="Search prompts (⌘K)"
            className="w-full rounded-md border border-line bg-panel py-1.5 pl-8 pr-2.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="min-w-0 truncate text-[11px] font-medium text-ink-faint">
          {subheader}
          {filtered.length > 0 && <span className="ml-1.5 tabular-nums">({filtered.length})</span>}
        </span>
        <SortDropdown />
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {isLoading && <Spinner />}
        {!isLoading && filtered.length === 0 && (
          <EmptyState
            icon={view.kind === "trash" ? <Trash2 size={16} /> : <FileText size={16} />}
            title={
              hasActiveListCriteria
                ? "No matching prompts"
                : view.kind === "trash"
                  ? "Trash is empty"
                  : view.kind === "starred"
                    ? "No starred prompts"
                    : "No prompts yet"
            }
            hint={
              hasActiveListCriteria
                ? "Try a different search, or clear the filters."
                : view.kind === "trash"
                  ? "Deleted prompts land here and can be restored."
                  : view.kind === "starred"
                    ? "Star a prompt from the list to pin it here."
                    : "Create your first prompt with the + button above."
            }
          />
        )}
        {filtered.map((prompt) => (
          <PromptCard key={prompt.id} prompt={prompt} />
        ))}
      </div>
    </section>
  );
}
