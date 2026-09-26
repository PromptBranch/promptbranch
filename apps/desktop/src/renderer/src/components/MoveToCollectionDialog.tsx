import { useEffect, useRef, useState } from "react";
import type { PromptDetail } from "../../../shared/ipc.js";
import { useAppMutation, useCollections } from "../hooks/use-data";
import { DialogShell } from "./dialogs";

export function MoveToCollectionDialog({
  prompt,
  open,
  onOpenChange,
}: {
  prompt: PromptDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: collections } = useCollections();
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>(prompt.collectionIds);
  const wasOpen = useRef(false);
  const previousPromptId = useRef(prompt.id);
  const updateMemberships = useAppMutation(
    async ({ add, remove }: { add: string[]; remove: string[] }) => {
      await Promise.all([
        ...add.map((collectionId) =>
          window.promptBuilder.collections.addPrompt(collectionId, prompt.id),
        ),
        ...remove.map((collectionId) =>
          window.promptBuilder.collections.removePrompt(collectionId, prompt.id),
        ),
      ]);
    },
    { quiet: true },
  );

  useEffect(() => {
    if (open && (!wasOpen.current || previousPromptId.current !== prompt.id)) {
      setSelectedCollectionIds(prompt.collectionIds);
    }
    wasOpen.current = open;
    previousPromptId.current = prompt.id;
  }, [open, prompt.id, prompt.collectionIds]);

  const save = async () => {
    const current = new Set(prompt.collectionIds);
    const selected = new Set(selectedCollectionIds);
    const add = selectedCollectionIds.filter((id) => !current.has(id));
    const remove = prompt.collectionIds.filter((id) => !selected.has(id));

    if (add.length === 0 && remove.length === 0) {
      onOpenChange(false);
      return;
    }

    try {
      await updateMemberships.mutateAsync({ add, remove });
      onOpenChange(false);
    } catch {
      // Keep the draft open so the user can retry after the mutation error toast.
    }
  };

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Move to collection"
      width="max-w-sm"
    >
      <div className="max-h-64 space-y-0.5 overflow-y-auto">
        {(collections ?? []).length === 0 && (
          <p className="text-[12px] text-ink-faint">
            No collections yet — create one from the left rail.
          </p>
        )}
        {(collections ?? []).map((collection) => {
          const member = selectedCollectionIds.includes(collection.id);
          return (
            <label
              key={collection.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink-dim hover:bg-hover"
            >
              <input
                type="checkbox"
                aria-label={collection.name}
                checked={member}
                disabled={updateMemberships.isPending}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setSelectedCollectionIds((current) => {
                    if (checked) {
                      return current.includes(collection.id) ? current : [...current, collection.id];
                    }
                    return current.filter((id) => id !== collection.id);
                  });
                }}
                className="accent-accent"
              />
              {collection.name}
              <span className="ml-auto text-[11px] tabular-nums text-ink-faint">
                {collection.promptCount}
              </span>
            </label>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={updateMemberships.isPending}
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </DialogShell>
  );
}
