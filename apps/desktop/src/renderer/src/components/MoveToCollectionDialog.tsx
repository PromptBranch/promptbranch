import type { PromptDetail } from "../../../shared/ipc.js";
import { useAppMutation, useCollections } from "../hooks/use-data";

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
  const toggle = useAppMutation(
    async ({ collectionId, member }: { collectionId: string; member: boolean }) => {
      if (member) await window.promptBuilder.collections.removePrompt(collectionId, prompt.id);
      else await window.promptBuilder.collections.addPrompt(collectionId, prompt.id);
    },
    { quiet: true },
  );

  if (!open) return null;
  return (
    <div
      className="pb-overlay fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-sm overflow-y-auto rounded-xl border border-line-strong bg-panel p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Move to collection"
      >
        <h2 className="mb-3 text-sm font-semibold text-ink">Collections</h2>
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {(collections ?? []).length === 0 && (
            <p className="text-[12px] text-ink-faint">
              No collections yet — create one from the left rail.
            </p>
          )}
          {(collections ?? []).map((collection) => {
            const member = prompt.collectionIds.includes(collection.id);
            return (
              <label
                key={collection.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink-dim hover:bg-hover"
              >
                <input
                  type="checkbox"
                  aria-label={collection.name}
                  checked={member}
                  onChange={() => toggle.mutate({ collectionId: collection.id, member })}
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
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
