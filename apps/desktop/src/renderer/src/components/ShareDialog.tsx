import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import type { PromptDetail, SharePublishResult } from "../../../shared/ipc.js";
import { useAppMutation } from "../hooks/use-data";
import { userErrorMessage } from "../lib/errors";
import { useToast } from "../lib/toast";
import { DialogShell } from "./dialogs";

const primaryButtonClass =
  "flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40";

const ghostButtonClass =
  "rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink";

const copyButtonClass =
  "shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink";

/**
 * Deliberate-publish flow (spec: security model): choose scope → see the
 * secret-scan verdict → review the exact JSON payload → explicit Publish
 * press. High-severity findings block; medium findings warn. The success
 * screen shows the URL; the delete token never crosses IPC — it is recorded
 * by the main process so the share can be revoked later.
 */
export function ShareDialog({
  open,
  onOpenChange,
  prompt,
  content,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt: PromptDetail;
  /** Current editor content; omitted when the current version is not loaded. */
  content?: string;
}) {
  const [includeHistory, setIncludeHistory] = useState(false);
  const [result, setResult] = useState<SharePublishResult | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      setIncludeHistory(false);
      setResult(null);
    }
  }, [open]);

  const preview = useQuery({
    queryKey: ["share-preview", prompt.id, includeHistory, content],
    queryFn: () =>
      window.promptBuilder.share.preview({
        promptId: prompt.id,
        includeHistory,
        ...(content !== undefined ? { content } : {}),
      }),
    enabled: open && result === null,
  });

  const publish = useAppMutation(
    () =>
      window.promptBuilder.share.publish({
        promptId: prompt.id,
        includeHistory,
        ...(content !== undefined ? { content } : {}),
      }),
    { quiet: true, onSuccess: (r) => setResult(r) },
  );

  const copy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast(`${label} copied`),
      () => toast("Copy failed"),
    );
  };

  const findings = preview.data?.findings ?? [];
  const high = findings.filter((f) => f.severity === "high");
  const medium = findings.filter((f) => f.severity === "medium");

  return (
    <DialogShell open={open} onOpenChange={onOpenChange} title={`Share "${prompt.title}"`} width="max-w-lg">
      {result ? (
        <div className="space-y-4">
          <p className="text-[13px] text-ink-dim">
            Published. Anyone with this link can view the snapshot:
          </p>
          <div className="flex items-center gap-1.5 rounded-md border border-line bg-app px-2.5 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-dim">
              {result.url}
            </span>
            <button
              type="button"
              aria-label="Copy link"
              onClick={() => copy(result.url, "Link")}
              className={copyButtonClass}
            >
              <Copy size={12} />
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-faint">
            The delete token is stored locally on this device — you can revoke this share later
            from Settings → Sharing.
          </p>
          <div className="flex justify-end">
            <button type="button" className={primaryButtonClass} onClick={() => onOpenChange(false)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-ink-dim">What to share</span>
            <div role="radiogroup" aria-label="Share scope" className="space-y-1.5">
              {(
                [
                  {
                    value: false,
                    label: "Current content only",
                    hint: "What is currently in the editor, including unsaved edits.",
                  },
                  {
                    value: true,
                    label: "Include full history",
                    hint: "Saved main-branch versions, plus the current editor content as the shared snapshot.",
                  },
                ] as const
              ).map((option) => (
                <label
                  key={String(option.value)}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-line bg-app px-2.5 py-2"
                >
                  <input
                    type="radio"
                    name="share-scope"
                    className="mt-0.5"
                    checked={includeHistory === option.value}
                    onChange={() => setIncludeHistory(option.value)}
                  />
                  <span>
                    <span className="block text-[12px] font-medium text-ink">{option.label}</span>
                    <span className="block text-[11px] text-ink-faint">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {preview.isPending && (
            <p className="flex items-center gap-1.5 text-[12px] text-ink-faint">
              <Loader2 size={12} className="animate-spin" /> Scanning for secrets…
            </p>
          )}
          {preview.isError && (
            <p className="text-[12px] text-danger">
              {userErrorMessage(preview.error)}
            </p>
          )}

          {high.length > 0 && (
            <div role="alert" className="space-y-1.5 rounded-lg border border-danger/30 bg-danger-soft p-3">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-danger">
                <ShieldAlert size={13} />
                Publishing blocked — {high.length} potential secret{high.length === 1 ? "" : "s"} found
              </p>
              <ul className="space-y-0.5 font-mono text-[11px] leading-relaxed text-danger/90">
                {high.map((f, i) => (
                  <li key={i}>
                    line {f.line} — {f.rule}: {f.match}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {high.length === 0 && medium.length > 0 && (
            <div role="status" className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-amber-500">
                <TriangleAlert size={13} />
                {medium.length} warning{medium.length === 1 ? "" : "s"} — review before publishing
              </p>
              <ul className="space-y-0.5 font-mono text-[11px] leading-relaxed text-amber-500/90">
                {medium.map((f, i) => (
                  <li key={i}>
                    line {f.line} — {f.rule}: {f.match}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.data && (
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-ink-dim">Exactly what will be sent</span>
              <pre className="max-h-48 overflow-auto rounded-md border border-line bg-app p-2 font-mono text-[11px] leading-snug text-ink-dim">
                {JSON.stringify(preview.data.payload, null, 2)}
              </pre>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className={ghostButtonClass} onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={!preview.data || high.length > 0 || publish.isPending}
              onClick={() => publish.mutate(undefined)}
            >
              {publish.isPending && <Loader2 size={11} className="animate-spin" />}
              Publish
            </button>
          </div>
        </div>
      )}
    </DialogShell>
  );
}
