import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useAppMutation } from "../hooks/use-data";
import { userErrorMessage } from "../lib/errors";
import { colorForName } from "./ui";
import { useToast } from "../lib/toast";
import { useAppState } from "../state/app-state";
import { DialogShell } from "./dialogs";

const primaryButtonClass =
  "flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40";

const ghostButtonClass =
  "rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink";

/**
 * Confirmation for promptbranch://import deep links: shows exactly what will
 * be imported (title, tags, description, content, history size) BEFORE a new
 * local prompt is created. Importing is always an explicit button press.
 */
export function ImportSnapshotDialog() {
  const { importUrl, setImportUrl, selectPrompt } = useAppState();
  const { toast } = useToast();
  const open = importUrl !== null;
  const close = () => setImportUrl(null);

  const preview = useQuery({
    queryKey: ["share-import-preview", importUrl],
    queryFn: () => window.promptBuilder.share.importPreview(importUrl!),
    enabled: open,
  });

  const doImport = useAppMutation(
    () => window.promptBuilder.share.import(preview.data!),
    {
      quiet: true,
      onSuccess: (r) => {
        toast(`Imported "${r.title}"`);
        selectPrompt(r.promptId);
        close();
      },
    },
  );

  const snapshot = preview.data?.snapshot;
  const historyCount = snapshot?.history?.length ?? 0;

  return (
    <DialogShell open={open} onOpenChange={(next) => { if (!next) close(); }} title="Import shared prompt" width="max-w-lg">
      {preview.isPending && (
        <p className="flex items-center gap-1.5 text-[12px] text-ink-faint">
          <Loader2 size={12} className="animate-spin" /> Fetching snapshot…
        </p>
      )}
      {preview.isError && (
        <div className="space-y-4">
          <p className="text-[13px] text-danger">
            {userErrorMessage(preview.error)}
          </p>
          <div className="flex justify-end">
            <button type="button" className={ghostButtonClass} onClick={close}>
              Close
            </button>
          </div>
        </div>
      )}
      {snapshot && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-[14px] font-semibold text-ink">{snapshot.title}</p>
            {snapshot.description && (
              <p className="text-[12px] text-ink-dim">{snapshot.description}</p>
            )}
            {snapshot.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {snapshot.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1.5 rounded-full border border-line bg-raised px-2 py-0.5 text-[11px] text-ink-dim"
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colorForName(tag) }} />
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
          {historyCount > 0 && (
            <p className="text-[11px] text-ink-faint">
              The portal snapshot includes {historyCount} versions — the import takes the latest
              content as v1 (history stays viewable on the portal).
            </p>
          )}
          <pre className="max-h-40 overflow-auto rounded-md border border-line bg-app p-2 font-mono text-[11px] leading-snug text-ink-dim">
            {snapshot.content.length > 600 ? `${snapshot.content.slice(0, 600)}…` : snapshot.content}
          </pre>
          <p className="text-[11px] leading-relaxed text-ink-faint">
            This creates a new prompt in your library with a provenance note. Nothing is modified
            or linked to the original.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className={ghostButtonClass} onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={doImport.isPending}
              onClick={() => doImport.mutate(undefined)}
            >
              {doImport.isPending && <Loader2 size={11} className="animate-spin" />}
              Import prompt
            </button>
          </div>
        </div>
      )}
    </DialogShell>
  );
}
