import { useState } from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import type { UpdateCheckResultDto } from "../../../shared/ipc.js";
import { useAppMutation, useUpdateStatus } from "../hooks/use-data";
import { cx } from "../lib/time";
import { useAppState } from "../state/app-state";

const ghostButton =
  "flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-40";

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <span className="text-[12px] font-medium text-ink-dim">{children}</span>
      {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p>}
    </div>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Settings → Updates: automatic-check toggle, manual "Check for Updates" with
 * inline up-to-date/error feedback, and the last-check facts. Updates are
 * delivered from GitHub Releases; dev builds and non-AppImage Linux installs
 * explain why they can't self-update.
 */
export function UpdatesSection() {
  const { data: status } = useUpdateStatus();
  const { openUpdateDialog } = useAppState();
  const [result, setResult] = useState<UpdateCheckResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setAutoCheck = useAppMutation((enabled: boolean) => window.promptBuilder.updates.setAutoCheck(enabled), {
    quiet: true,
    invalidateKeys: [["update-status"]],
  });
  const check = useAppMutation(() => window.promptBuilder.updates.check(), {
    quiet: true,
    invalidateKeys: [["update-status"]],
    onSuccess: (res) => {
      setResult(res);
      setError(null);
      if (res.status === "available") {
        openUpdateDialog({
          currentVersion: res.currentVersion,
          version: res.version,
          releaseNotes: res.releaseNotes,
          releaseUrl: res.releaseUrl,
        });
      }
    },
    onError: (err) => {
      setResult(null);
      setError(err.message);
    },
  });
  const offerAgain = useAppMutation(() => window.promptBuilder.updates.skipVersion(null), {
    quiet: true,
    invalidateKeys: [["update-status"]],
  });

  if (!status) return null;

  const openReleases = () => {
    void window.promptBuilder.app
      .openExternal("https://github.com/PromptBranch/promptbranch/releases")
      .catch(() => undefined);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <FieldLabel hint="Check GitHub Releases in the background shortly after launch and every 6 hours. When something new is found, a dialog offers the update.">
          Check for updates automatically
        </FieldLabel>
        <button
          type="button"
          role="switch"
          aria-checked={status.autoCheckEnabled}
          aria-label="Check for updates automatically"
          onClick={() => setAutoCheck.mutate(!status.autoCheckEnabled)}
          className={cx(
            "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
            status.autoCheckEnabled ? "bg-accent" : "bg-line-strong",
          )}
        >
          <span
            className={cx(
              "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]",
              status.autoCheckEnabled ? "left-4.5" : "left-0.5",
            )}
          />
        </button>
      </div>

      {status.supported ? (
        <div className="space-y-2">
          <FieldLabel hint="Checks right now, regardless of the automatic setting — a skipped version is offered again.">
            Manual check
          </FieldLabel>
          <button
            type="button"
            onClick={() => check.mutate(undefined)}
            disabled={check.isPending}
            className={ghostButton}
          >
            {check.isPending ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            Check for Updates…
          </button>
          {result?.status === "up-to-date" && (
            <p className="text-[12px] text-ink-dim">You're up to date — v{result.currentVersion} is the latest release.</p>
          )}
          {result?.status === "error" && (
            <p className="text-[12px] text-danger">Check failed — {result.message}</p>
          )}
          {error && <p className="text-[12px] text-danger">Check failed — {error}</p>}
        </div>
      ) : (
        <div className="space-y-2 rounded-md border border-line bg-app p-3">
          <FieldLabel>
            {status.unsupportedReason === "linux-package"
              ? "This install can't update itself"
              : "Updates unavailable in development builds"}
          </FieldLabel>
          <p className="text-[11px] leading-relaxed text-ink-faint">
            {status.unsupportedReason === "linux-package"
              ? "In-app updates need the AppImage build. Package-manager installs (deb) update by installing a new release manually."
              : "Dev checkouts run from source — packaged builds check GitHub Releases automatically."}
          </p>
          <button type="button" onClick={openReleases} className="inline-flex items-center gap-1 text-[11px] font-medium text-accent transition-colors hover:underline">
            Open releases page
            <ExternalLink size={10} aria-hidden />
          </button>
        </div>
      )}

      <dl className="space-y-1.5 border-t border-line pt-3">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-[11px] text-ink-faint">Current version</dt>
          <dd className="font-mono text-[11px] tabular-nums text-ink-dim">v{status.currentVersion}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-[11px] text-ink-faint">Last checked</dt>
          <dd className="text-[11px] tabular-nums text-ink-dim">{relativeTime(status.lastCheckAt)}</dd>
        </div>
        {status.skippedVersion && (
          <div className="flex items-center justify-between gap-4">
            <dt className="text-[11px] text-ink-faint">Skipping</dt>
            <dd className="flex items-center gap-2 text-[11px] tabular-nums text-ink-dim">
              v{status.skippedVersion}
              <button
                type="button"
                onClick={() => offerAgain.mutate(undefined)}
                className="text-accent transition-colors hover:underline"
              >
                Offer again
              </button>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
