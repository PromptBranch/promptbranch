import { useEffect, useState } from "react";
import { ArrowRight, ExternalLink, Loader2 } from "lucide-react";
import { updateStateEventSchema, type UpdateAvailableInfo, type UpdateProgress } from "../../../shared/ipc.js";
import { userErrorMessage } from "../lib/errors";
import { cx } from "../lib/time";
import { useAppState } from "../state/app-state";
import { DialogShell } from "./dialogs";
import { MarkdownPreview } from "./MarkdownPreview";

const primaryButton =
  "rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40";

const ghostButton =
  "rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

type Phase = "idle" | "downloading" | "downloaded" | "error";

/**
 * "Update available" dialog: current → next version, the release notes, and
 * download → restart staged one step at a time. "Later" just closes it (a
 * background check re-offers later; a finished download installs on quit);
 * "Skip this version" sticks until the next release.
 */
export function UpdateDialog() {
  const { updateAvailable: info, updateDialogOpen, setUpdateDialogOpen, setUpdateAvailable } = useAppState();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fresh state each time the dialog opens.
  useEffect(() => {
    if (updateDialogOpen) {
      setPhase("idle");
      setProgress(null);
      setError(null);
    }
  }, [updateDialogOpen]);

  // Download lifecycle arrives as push events from main; payloads are
  // validated here, like sync status events.
  useEffect(
    () =>
      window.promptBuilder.updates.onStateChanged((raw) => {
        const parsed = updateStateEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const event = parsed.data;
        if (event.phase === "downloading") {
          setPhase("downloading");
          setProgress(event.progress);
        } else if (event.phase === "downloaded") {
          setPhase("downloaded");
        } else if (event.phase === "error") {
          setPhase("error");
          setError(event.message);
        }
      }),
    [],
  );

  if (!info) return null;

  const startDownload = () => {
    setError(null);
    setPhase("downloading");
    window.promptBuilder.updates.download().catch((err: unknown) => {
      setPhase("error");
      setError(userErrorMessage(err));
    });
  };

  const skip = () => {
    void window.promptBuilder.updates.skipVersion(info.version);
    setUpdateAvailable(null);
    setUpdateDialogOpen(false);
  };

  const openRelease = () => {
    void window.promptBuilder.app.openExternal(info.releaseUrl).catch(() => undefined);
  };

  const percent = Math.min(100, Math.max(0, progress?.percent ?? 0));

  return (
    <DialogShell
      open={updateDialogOpen}
      onOpenChange={(next) => {
        if (!next) setUpdateDialogOpen(false);
      }}
      title={`Update available — v${info.version}`}
      width="max-w-lg"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-line bg-app px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-ink-dim">
            v{info.currentVersion}
          </span>
          <ArrowRight size={12} className="text-ink-faint" aria-hidden />
          <span className="rounded-md border border-accent/40 bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums text-accent">
            v{info.version}
          </span>
          <button
            type="button"
            onClick={openRelease}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent transition-colors hover:underline"
          >
            View on GitHub
            <ExternalLink size={10} aria-hidden />
          </button>
        </div>

        {info.releaseNotes ? (
          <div className="max-h-72 overflow-y-auto rounded-md border border-line bg-app p-3 text-[12px]">
            <MarkdownPreview content={info.releaseNotes} />
          </div>
        ) : (
          <p className="text-[12px] text-ink-faint">No release notes were provided for this version.</p>
        )}

        {phase === "downloading" && (
          <div className="space-y-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${percent}%` }}
                role="progressbar"
                aria-valuenow={Math.round(percent)}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <p className="text-[11px] tabular-nums text-ink-faint">
              Downloading — {Math.round(percent)}%
              {progress ? ` · ${formatBytes(progress.bytesPerSecond)}/s` : ""}
            </p>
          </div>
        )}

        {phase === "downloaded" && (
          <p className="text-[12px] leading-relaxed text-ink-dim">
            Update downloaded. Restart now to finish installing — or keep working and it installs the next
            time you quit.
          </p>
        )}

        {phase === "error" && (
          <p className="text-[12px] leading-relaxed text-danger">Download failed — {error}</p>
        )}

        {phase === "idle" && (
          <p className="text-[12px] leading-relaxed text-ink-faint">
            The update is downloaded from GitHub Releases and installed when you restart.
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          {phase === "idle" && (
            <>
              <button type="button" className={ghostButton} onClick={skip}>
                Skip this version
              </button>
              <button type="button" className={ghostButton} onClick={() => setUpdateDialogOpen(false)}>
                Later
              </button>
              <button type="button" className={primaryButton} onClick={startDownload}>
                Download &amp; Install
              </button>
            </>
          )}
          {phase === "downloading" && (
            <>
              <span className="mr-auto inline-flex items-center gap-1.5 text-[11px] text-ink-faint">
                <Loader2 size={11} className="animate-spin" />
                You can keep working — it installs when you quit
              </span>
              <button type="button" className={ghostButton} onClick={() => setUpdateDialogOpen(false)}>
                Continue in background
              </button>
            </>
          )}
          {phase === "downloaded" && (
            <>
              <button type="button" className={ghostButton} onClick={() => setUpdateDialogOpen(false)}>
                Install on quit
              </button>
              <button
                type="button"
                className={cx(primaryButton, "inline-flex items-center gap-1.5")}
                onClick={() => window.promptBuilder.updates.install()}
              >
                Restart now
              </button>
            </>
          )}
          {phase === "error" && (
            <>
              <button type="button" className={ghostButton} onClick={() => setUpdateDialogOpen(false)}>
                Later
              </button>
              <button type="button" className={primaryButton} onClick={startDownload}>
                Retry download
              </button>
            </>
          )}
        </div>
      </div>
    </DialogShell>
  );
}
