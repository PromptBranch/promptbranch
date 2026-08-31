import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  updateStateDtoSchema,
  type UpdateAssetDto,
  type UpdateStateDto,
} from "../../../shared/ipc.js";
import { qk, useUpdateState } from "../hooks/use-data";
import { cx, relativeTime } from "../lib/time";
import { useToast } from "../lib/toast";
import { useAppState } from "../state/app-state";

const secondaryButton =
  "inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40";

const primaryButton =
  "inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-40";

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function downloadLabel(asset: UpdateAssetDto, assetCount: number): string {
  if (assetCount === 1) return "Download Update";
  if (asset.kind === "appimage") return "Download AppImage";
  if (asset.kind === "deb") return "Download .deb";
  return "Download " + asset.label;
}

function statusCopy(state: UpdateStateDto): {
  title: string;
  description: string;
  icon: ReactNode;
  tone: string;
} {
  const target = state.platform + " " + state.architecture;
  switch (state.status) {
    case "checking":
      return {
        title: "Checking for updates…",
        description: "Looking for the latest stable PromptBranch release for " + target + ".",
        icon: <RefreshCw size={16} className="animate-spin" aria-hidden />,
        tone: "border-accent/25 bg-accent-soft text-accent",
      };
    case "up-to-date":
      return {
        title: "PromptBranch is up to date",
        description: "Version " + state.currentVersion + " is the latest stable release.",
        icon: <CheckCircle2 size={16} aria-hidden />,
        tone: "border-success/25 bg-success/10 text-success",
      };
    case "update-available":
      return {
        title: "PromptBranch " + (state.latestVersion ?? "") + " is available",
        description: "A matching installer is available for " + target + ".",
        icon: <Sparkles size={16} aria-hidden />,
        tone: "border-accent/25 bg-accent-soft text-accent",
      };
    case "no-compatible-download":
      return {
        title: "No compatible installer",
        description:
          "PromptBranch " +
          (state.latestVersion ?? "the latest release") +
          " is available, but no installer was published for " +
          target +
          " yet.",
        icon: <AlertTriangle size={16} aria-hidden />,
        tone: "border-line-strong bg-raised text-ink-dim",
      };
    case "newer-build":
      return {
        title: "You’re running a newer build",
        description:
          "Installed version " +
          state.currentVersion +
          " is newer than the latest stable release" +
          (state.latestVersion ? " (" + state.latestVersion + ")" : "") +
          ".",
        icon: <Sparkles size={16} aria-hidden />,
        tone: "border-line-strong bg-raised text-ink-dim",
      };
    case "error":
      return {
        title: "Couldn’t check for updates",
        description: state.errorMessage ?? "Check your connection and try again.",
        icon: <AlertTriangle size={16} aria-hidden />,
        tone: "border-danger/25 bg-danger-soft text-danger",
      };
    case "not-checked":
      return {
        title: "Ready to check",
        description:
          "Check the latest stable PromptBranch release and find the right installer for this device.",
        icon: <RefreshCw size={16} aria-hidden />,
        tone: "border-line-strong bg-raised text-ink-dim",
      };
  }
}

/** Settings -> Updates: detection is automatic; installation remains user-controlled. */
export function UpdatesSection() {
  const queryClient = useQueryClient();
  const updateQuery = useUpdateState();
  const { setSettingsOpen } = useAppState();
  const { toast } = useToast();
  const [preferencePending, setPreferencePending] = useState(false);

  const setState = (state: UpdateStateDto) => {
    queryClient.setQueryData<UpdateStateDto>(qk.updateState, state);
  };

  if (updateQuery.isPending) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-24 animate-pulse rounded-lg border border-line bg-app" />
        <p className="text-[11px] text-ink-faint">Loading update status…</p>
      </div>
    );
  }

  if (!updateQuery.data) {
    return (
      <div className="rounded-lg border border-danger/25 bg-danger-soft p-4 text-danger">
        <p className="text-[12px] font-medium">Update status unavailable</p>
        <button
          type="button"
          onClick={() => void updateQuery.refetch()}
          className="mt-3 rounded-md border border-danger/30 px-3 py-1.5 text-[12px] font-medium hover:bg-danger/10"
        >
          Try Again
        </button>
      </div>
    );
  }

  const state = updateQuery.data;
  const status = statusCopy(state);
  const checking = state.status === "checking";
  const checkLabel =
    state.status === "error"
      ? "Try Again"
      : checking
        ? "Checking…"
        : state.status === "not-checked"
          ? "Check for Updates"
          : "Check Again";
  const lastChecked = state.lastCheckedAt
    ? capitalize(relativeTime(state.lastCheckedAt))
    : "Never";

  const checkNow = () => {
    if (checking) return;
    setState({
      ...state,
      status: "checking",
      checkSource: "manual",
      errorMessage: null,
    });
    void window.promptBuilder.updates
      .check()
      .then((next) => setState(updateStateDtoSchema.parse(next)))
      .catch(() => {
        setState({
          ...state,
          status: "error",
          lastCheckedAt: new Date().toISOString(),
          checkSource: "manual",
          errorMessage: "Could not check for updates. Check your connection and try again.",
        });
      });
  };

  const setAutomaticChecks = () => {
    if (preferencePending) return;
    setPreferencePending(true);
    void window.promptBuilder.updates
      .setAutomaticChecks(!state.automaticChecksEnabled)
      .then((next) => setState(updateStateDtoSchema.parse(next)))
      .catch(() => toast("Could not save the update preference", "error"))
      .finally(() => setPreferencePending(false));
  };

  const openDownload = (asset: UpdateAssetDto) => {
    void window.promptBuilder.updates
      .openDownload(asset.name)
      .catch(() => toast("Could not open the update download", "error"));
  };

  const openReleaseNotes = () => {
    void window.promptBuilder.updates
      .openReleaseNotes()
      .catch(() => toast("Could not open the release notes", "error"));
  };

  const showRelease =
    state.status === "update-available" || state.status === "no-compatible-download";

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-lg border border-line bg-app">
        <div
          role="status"
          aria-live="polite"
          className={cx("flex items-start gap-3 border-b px-4 py-3.5", status.tone)}
        >
          <span className="mt-0.5 shrink-0">{status.icon}</span>
          <div className="min-w-0">
            <h4 className="text-[13px] font-semibold tracking-tight">{status.title}</h4>
            <p className="mt-0.5 max-w-[52ch] text-[11px] leading-relaxed opacity-80">
              {status.description}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3.5">
          <div>
            <dt className="text-[10px] font-medium uppercase tracking-[0.06em] text-ink-faint">
              Current version
            </dt>
            <dd className="mt-0.5 font-mono text-[12px] tabular-nums text-ink">
              {state.currentVersion}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-medium uppercase tracking-[0.06em] text-ink-faint">
              Latest version
            </dt>
            <dd className="mt-0.5 font-mono text-[12px] tabular-nums text-ink">
              {state.latestVersion ?? "Not checked"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-medium uppercase tracking-[0.06em] text-ink-faint">
              This build
            </dt>
            <dd className="mt-0.5 text-[11px] text-ink-dim">
              {state.platform} · {state.architecture}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-medium uppercase tracking-[0.06em] text-ink-faint">
              Last checked
            </dt>
            <dd
              className="mt-0.5 text-[11px] text-ink-dim"
              title={state.lastCheckedAt ? new Date(state.lastCheckedAt).toLocaleString() : undefined}
            >
              {lastChecked}
            </dd>
          </div>
        </dl>
      </section>

      {showRelease && state.releaseNotes ? (
        <section className="space-y-1.5">
          <h4 className="text-[11px] font-semibold text-ink-dim">What’s new</h4>
          <p className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-app px-3 py-2.5 text-[11px] leading-relaxed text-ink-dim">
            {state.releaseNotes}
          </p>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {state.status === "update-available"
          ? state.assets.map((asset) => {
              const label = downloadLabel(asset, state.assets.length);
              return (
                <button
                  key={asset.name}
                  type="button"
                  aria-label={label}
                  onClick={() => openDownload(asset)}
                  className={primaryButton}
                >
                  <Download size={12} aria-hidden />
                  {label}
                  {asset.recommended && state.assets.length > 1 ? (
                    <span
                      aria-hidden
                      className="ml-0.5 rounded bg-white/15 px-1 py-px text-[9px] font-medium"
                    >
                      Recommended
                    </span>
                  ) : null}
                </button>
              );
            })
          : null}
        {state.status !== "update-available" ? (
          <button
            type="button"
            onClick={checkNow}
            disabled={checking}
            className={secondaryButton}
          >
            <RefreshCw
              size={12}
              className={checking ? "animate-spin" : undefined}
              aria-hidden
            />
            {checkLabel}
          </button>
        ) : null}
        {showRelease ? (
          <button type="button" onClick={openReleaseNotes} className={secondaryButton}>
            Full release notes
            <ExternalLink size={12} aria-hidden />
          </button>
        ) : null}
        {state.status === "update-available" ? (
          <button
            type="button"
            onClick={() => setSettingsOpen(false)}
            className="rounded-md px-2 py-1.5 text-[12px] text-ink-faint transition-colors hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Later
          </button>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
        <div>
          <p className="text-[12px] font-medium text-ink-dim">
            Automatically check for updates
          </p>
          <p className="mt-0.5 max-w-[48ch] text-[11px] leading-relaxed text-ink-faint">
            Checks when PromptBranch starts. Manual checks remain available when this is off.
            PromptBranch never downloads or installs an update without you.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={state.automaticChecksEnabled}
          aria-label="Automatically check for updates"
          disabled={preferencePending}
          onClick={setAutomaticChecks}
          className={cx(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40",
            state.automaticChecksEnabled ? "bg-accent" : "bg-line-strong",
          )}
        >
          <span
            className={cx(
              "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]",
              state.automaticChecksEnabled ? "left-4.5" : "left-0.5",
            )}
          />
        </button>
      </div>
    </div>
  );
}
