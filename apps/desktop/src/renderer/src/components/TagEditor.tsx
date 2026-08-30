import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Plus, Search } from "lucide-react";
import type { PromptDetail, TagDto } from "../../../shared/ipc.js";
import { useAppMutation, useTags } from "../hooks/use-data";
import { colorForName, TagChip } from "./ui";

/** Inline tag chips + "+ Add tag" popover (existing tags, create-new). */
export function TagEditor({ prompt, compact }: { prompt: PromptDetail; compact?: boolean }) {
  const { data: allTags } = useTags();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const addTag = useAppMutation(
    (tagId: string) => window.promptBuilder.tags.addToPrompt(prompt.id, tagId),
    { quiet: true },
  );
  const removeTag = useAppMutation(
    (tagId: string) => window.promptBuilder.tags.removeFromPrompt(prompt.id, tagId),
    { quiet: true },
  );
  const createTag = useAppMutation(
    async (name: string) => {
      const created = await window.promptBuilder.tags.create({ name, color: colorForName(name) });
      await window.promptBuilder.tags.addToPrompt(prompt.id, created.id);
    },
    { toast: "Tag created" },
  );

  const attachedIds = useMemo(() => new Set(prompt.tags.map((t) => t.id)), [prompt.tags]);
  const candidates = (allTags ?? []).filter(
    (t) => !attachedIds.has(t.id) && t.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const exactMatch = (allTags ?? []).some((t) => t.name.toLowerCase() === query.trim().toLowerCase());

  const pick = (tag: TagDto) => {
    addTag.mutate(tag.id);
    setQuery("");
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {prompt.tags.map((tag) => (
        <TagChip
          key={tag.id}
          name={tag.name}
          color={tag.color ?? colorForName(tag.name)}
          onRemove={() => removeTag.mutate(tag.id)}
        />
      ))}
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2 py-0.5 text-[11px] text-ink-faint transition-colors hover:border-accent/60 hover:text-accent"
          >
            <Plus size={11} />
            Add tag
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className="pb-menu z-50 w-56 rounded-lg border border-line-strong bg-raised p-2 shadow-xl shadow-black/40"
          >
            <div className="relative mb-1.5">
              <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find or create a tag…"
                className="w-full rounded-md border border-line bg-app py-1 pl-7 pr-2 text-[12px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
              />
            </div>
            <div className="max-h-44 space-y-0.5 overflow-y-auto">
              {candidates.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => pick(tag)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag.color ?? colorForName(tag.name) }}
                  />
                  <span className="min-w-0 truncate">{tag.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-faint">{tag.usageCount}</span>
                </button>
              ))}
              {query.trim() && !exactMatch && (
                <button
                  type="button"
                  onClick={() => {
                    createTag.mutate(query.trim());
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-accent transition-colors hover:bg-hover"
                >
                  <Plus size={11} />
                  Create “{query.trim()}”
                </button>
              )}
              {candidates.length === 0 && !query.trim() && (
                <p className="px-2 py-1 text-[11px] text-ink-faint">
                  {compact ? "Type to create one." : "All tags are already attached. Type to create one."}
                </p>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
