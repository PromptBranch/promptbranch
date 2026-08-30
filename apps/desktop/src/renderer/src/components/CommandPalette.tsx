import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  BookOpen,
  Clock,
  CornerDownLeft,
  FileText,
  Plus,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import type { SearchResultDto } from "../../../shared/ipc.js";
import { useAppMutation } from "../hooks/use-data";
import { cx } from "../lib/time";
import { useAppState } from "../state/app-state";

interface CommandItem {
  id: string;
  kind: "command" | "prompt";
  title: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const {
    paletteOpen,
    setPaletteOpen,
    setNewPromptOpen,
    setView,
    selectPrompt,
    selectedPromptId,
  } = useAppState();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultDto[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const toggleStar = useAppMutation(
    async () => {
      if (!selectedPromptId) return;
      const prompt = await window.promptBuilder.prompts.get(selectedPromptId);
      if (prompt) await window.promptBuilder.prompts.setStarred(prompt.id, !prompt.isStarred);
    },
    { quiet: true },
  );

  const close = () => setPaletteOpen(false);

  // Debounced FTS search.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      window.promptBuilder
        .search(trimmed)
        .then(setResults)
        .catch(() => setResults([]));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (paletteOpen) {
      setQuery("");
      setResults([]);
      setActiveIndex(0);
    }
  }, [paletteOpen]);

  const commands = useMemo<CommandItem[]>(
    () => [
      {
        id: "cmd:new",
        kind: "command",
        title: "New Prompt",
        hint: "Create a prompt with v1",
        icon: <Plus size={14} />,
        run: () => {
          close();
          setNewPromptOpen(true);
        },
      },
      {
        id: "cmd:star",
        kind: "command",
        title: "Toggle Star",
        hint: selectedPromptId ? "On the selected prompt" : "Select a prompt first",
        icon: <Star size={14} />,
        run: () => {
          if (selectedPromptId) toggleStar.mutate(undefined);
          close();
        },
      },
      {
        id: "cmd:library",
        kind: "command",
        title: "Go to Library",
        icon: <BookOpen size={14} />,
        run: () => {
          setView({ kind: "library" });
          close();
        },
      },
      {
        id: "cmd:history",
        kind: "command",
        title: "Go to History",
        icon: <Clock size={14} />,
        run: () => {
          setView({ kind: "history" });
          close();
        },
      },
      {
        id: "cmd:starred",
        kind: "command",
        title: "Go to Starred",
        icon: <Star size={14} />,
        run: () => {
          setView({ kind: "starred" });
          close();
        },
      },
      {
        id: "cmd:trash",
        kind: "command",
        title: "Go to Trash",
        icon: <Trash2 size={14} />,
        run: () => {
          setView({ kind: "trash" });
          close();
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedPromptId],
  );

  const items = useMemo<CommandItem[]>(() => {
    const trimmed = query.trim();
    if (!trimmed) return commands;
    const promptItems: CommandItem[] = results.map((r) => ({
      id: `prompt:${r.promptId}`,
      kind: "prompt",
      title: r.title,
      hint: r.snippet || undefined,
      icon: <FileText size={14} />,
      run: () => {
        selectPrompt(r.promptId);
        close();
      },
    }));
    const matchingCommands = commands.filter((c) => c.title.toLowerCase().includes(trimmed.toLowerCase()));
    return [...promptItems, ...matchingCommands];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, results, commands]);

  useEffect(() => {
    setActiveIndex(0);
  }, [items.length]);

  const runItem = (index: number) => {
    items[index]?.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runItem(activeIndex);
    }
  };

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <Dialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="pb-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          className="fixed left-1/2 top-[18%] z-50 max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/60 focus:outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-line px-3.5">
            <Search size={14} className="shrink-0 text-ink-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search prompts, or pick a command…"
              className="w-full bg-transparent py-3 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </div>

          <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
            {items.length === 0 && (
              <p className="px-3 py-6 text-center text-[12px] text-ink-faint">
                No results for “{query.trim()}”
              </p>
            )}
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                data-index={index}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => item.run()}
                className={cx(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left",
                  index === activeIndex ? "bg-accent-soft" : "",
                )}
              >
                <span className={cx("shrink-0", index === activeIndex ? "text-accent" : "text-ink-faint")}>
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{item.title}</span>
                  {item.hint && (
                    <span className="block truncate text-[11px] text-ink-faint">{item.hint}</span>
                  )}
                </span>
                {index === activeIndex && (
                  <CornerDownLeft size={12} className="shrink-0 text-ink-faint" />
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-4 border-t border-line px-3.5 py-2 text-[11px] text-ink-faint">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>esc close</span>
            <span className="ml-auto">
              {query.trim() ? `${items.length} result${items.length === 1 ? "" : "s"}` : "commands"}
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
