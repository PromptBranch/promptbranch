import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { MarkdownImportPreviewDto } from "../../../shared/ipc.js";
import { useAppMutation } from "../hooks/use-data";
import { userErrorMessage } from "../lib/errors";
import { useToast } from "../lib/toast";
import { useAppState } from "../state/app-state";
import { DialogShell } from "./dialogs";

const primaryButtonClass =
  "flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40";

const ghostButtonClass =
  "rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

/** A user-triggered fetch and explicit review before a public Markdown import. */
export function ImportMarkdownDialog() {
  const { markdownImportUrl, setMarkdownImportUrl, selectPrompt } = useAppState();
  const { toast } = useToast();
  const [preview, setPreviewState] = useState<MarkdownImportPreviewDto | null>(null);
  const [title, setTitle] = useState("");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const generation = useRef(0);
  const previewRef = useRef<MarkdownImportPreviewDto | null>(null);
  const open = markdownImportUrl !== null;

  const setPreview = (value: MarkdownImportPreviewDto | null) => {
    previewRef.current = value;
    setPreviewState(value);
  };

  const discardPreview = (previewId: string) => {
    void window.promptBuilder.markdown.discard(previewId).catch(() => undefined);
  };

  const close = () => {
    generation.current++;
    setMarkdownImportUrl(null);
  };

  useEffect(() => {
    generation.current++;
    setPreview(null);
    setTitle("");
    setFetchError(null);
    setIsFetching(false);
    return () => {
      generation.current++;
      const current = previewRef.current;
      if (current) discardPreview(current.previewId);
    };
  }, [markdownImportUrl]);

  const importPrompt = useAppMutation(
    ({ previewId, title: chosenTitle }: { previewId: string; title: string }) =>
      window.promptBuilder.markdown.confirm({ previewId, title: chosenTitle }),
    {
      quiet: true,
      onSuccess: (result) => {
        toast(`Imported "${result.title}"`);
        selectPrompt(result.promptId);
        close();
      },
    },
  );

  const fetchMarkdown = async () => {
    const sourceUrl = markdownImportUrl;
    if (!sourceUrl) return;

    const requestGeneration = ++generation.current;
    const existing = previewRef.current;
    if (existing) discardPreview(existing.previewId);
    setPreview(null);
    setFetchError(null);
    setTitle("");
    setIsFetching(true);
    try {
      const result = await window.promptBuilder.markdown.preview(sourceUrl);
      if (generation.current !== requestGeneration) {
        discardPreview(result.previewId);
        return;
      }
      setPreview(result);
      setTitle(result.suggestedTitle);
    } catch (error) {
      if (generation.current === requestGeneration) setFetchError(userErrorMessage(error));
    } finally {
      if (generation.current === requestGeneration) setIsFetching(false);
    }
  };

  const canImport = Boolean(preview && title.trim() && title.trim().length <= 200);

  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Import Markdown prompt"
      width="max-w-2xl"
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <p className="text-[12px] text-ink-dim">
            Review a public Markdown file before adding it as a new prompt.
          </p>
          <p className="break-all rounded-md border border-line bg-app px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-faint">
            {preview?.sourceUrl ?? markdownImportUrl}
          </p>
          {preview && (
            <p className="break-all text-[11px] leading-relaxed text-ink-faint">
              Final URL: {preview.finalUrl}
            </p>
          )}
        </div>

        {fetchError && (
          <p role="alert" className="text-[12px] text-danger">
            {fetchError}
          </p>
        )}

        {!preview && isFetching && (
          <p className="flex items-center gap-1.5 text-[12px] text-ink-faint" role="status">
            <Loader2 size={12} className="animate-spin" /> Fetching Markdown…
          </p>
        )}

        {preview && (
          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-ink-dim">Prompt title</span>
              <input
                aria-label="Prompt title"
                autoFocus
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-[13px] text-ink focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </label>
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-ink-faint">Markdown preview</p>
              <pre
                aria-label="Markdown content"
                className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-app p-3 font-mono text-[11px] leading-relaxed text-ink-dim"
              >
                {preview.content}
              </pre>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-faint">
              This creates a separate local prompt from the reviewed text and records both source
              URLs in a note. It does not publish the content.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className={ghostButtonClass} onClick={close}>
            Cancel
          </button>
          {!preview && (
            <button
              type="button"
              className={primaryButtonClass}
              disabled={!markdownImportUrl || isFetching || importPrompt.isPending}
              onClick={() => void fetchMarkdown()}
            >
              {isFetching && <Loader2 size={11} className="animate-spin" />}
              {isFetching ? "Fetching…" : "Fetch Markdown"}
            </button>
          )}
          {preview && (
            <>
              <button
                type="button"
                className={ghostButtonClass}
                disabled={isFetching || importPrompt.isPending}
                onClick={() => void fetchMarkdown()}
              >
                Fetch again
              </button>
              <button
                type="button"
                className={primaryButtonClass}
                disabled={!canImport || isFetching || importPrompt.isPending}
                onClick={() =>
                  importPrompt.mutate({ previewId: preview.previewId, title: title.trim() })
                }
              >
                {importPrompt.isPending && <Loader2 size={11} className="animate-spin" />}
                Import as new prompt
              </button>
            </>
          )}
        </div>
      </div>
    </DialogShell>
  );
}
