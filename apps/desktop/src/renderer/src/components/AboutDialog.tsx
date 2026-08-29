import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, CloudDownload, ExternalLink, Loader2 } from "lucide-react";
import iconUrl from "../assets/icon.png";
import { useManualUpdateCheck, useAppInfo, useUpdateStatus } from "../hooks/use-data";
import { useToast } from "../lib/toast";
import { LicensesDialog } from "./LicensesDialog";

const WEBSITE_URL = "https://promptbranch.app/";

/** Branded About dialog; opened from the app menu, Help menu, or the settings popover. */
export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: appInfo } = useAppInfo();
  const { data: updateStatus } = useUpdateStatus();
  const checkUpdates = useManualUpdateCheck();
  const { toast } = useToast();
  const [licensesOpen, setLicensesOpen] = useState(false);

  const openWebsite = () => {
    void window.promptBuilder.app.openExternal(WEBSITE_URL).catch(() => {
      toast("Could not open link");
    });
  };

  const copyDbPath = () => {
    if (!appInfo) return;
    void navigator.clipboard.writeText(appInfo.dbPath).then(
      () => toast("DB path copied"),
      () => toast("Copy failed"),
    );
  };

  const runtimes: Array<[string, string]> = appInfo
    ? [
        ["Electron", appInfo.electronVersion],
        ["Chromium", appInfo.chromeVersion],
        ["Node.js", appInfo.nodeVersion],
      ]
    : [];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pb-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="pb-dialog fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line-strong bg-panel p-0 shadow-2xl shadow-black/50 focus:outline-none"
        >
          <div className="flex flex-col items-center px-6 pb-5 pt-7 text-center">
            <img src={iconUrl} alt="PromptBranch icon" className="h-16 w-16 rounded-2xl" />
            <Dialog.Title className="mt-3 text-base font-semibold tracking-tight text-ink">
              PromptBranch
            </Dialog.Title>
            <p className="mt-0.5 text-[12px] tabular-nums text-ink-dim">
              Version {appInfo?.version ?? "…"}
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-dim">
              Local-first prompt library and versioning tool
            </p>
            <button
              type="button"
              onClick={openWebsite}
              className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium text-accent transition-colors hover:bg-hover hover:text-accent-strong hover:underline"
            >
              https://promptbranch.app/
              <ExternalLink size={12} aria-hidden />
            </button>
            {updateStatus?.supported && (
              <button
                type="button"
                onClick={() => checkUpdates.mutate(undefined)}
                disabled={checkUpdates.isPending}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                {checkUpdates.isPending ? <Loader2 size={12} className="animate-spin" /> : <CloudDownload size={12} />}
                Check for Updates…
              </button>
            )}
            <p className="mt-2 text-[11px] text-ink-faint">© 2026 PromptBranch</p>
          </div>


          <div className="border-t border-line px-5 py-3">
            <dl className="space-y-1.5">
              {runtimes.map(([label, version]) => (
                <div key={label} className="flex items-baseline justify-between gap-4">
                  <dt className="text-[11px] text-ink-faint">{label}</dt>
                  <dd className="font-mono text-[11px] tabular-nums text-ink-dim">{version}</dd>
                </div>
              ))}
              <div className="flex items-center justify-between gap-2">
                <dt className="shrink-0 text-[11px] text-ink-faint">Database</dt>
                <dd className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-dim" title={appInfo?.dbPath}>
                  {appInfo?.dbPath ?? "…"}
                </dd>
                <button
                  type="button"
                  onClick={copyDbPath}
                  className="shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                  aria-label="Copy database path"
                >
                  <Copy size={11} />
                </button>
              </div>
            </dl>
          </div>

          <div className="flex justify-center border-t border-line px-5 py-2.5">
            <button
              type="button"
              onClick={() => setLicensesOpen(true)}
              className="text-[11px] text-ink-faint underline-offset-2 transition-colors hover:text-accent hover:underline"
            >
              Open Source Licenses
            </button>
          </div>

          <div className="flex items-center justify-between border-t border-line px-5 py-3">
            <span className="flex items-center gap-1.5 text-[11px] text-ink-dim">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              Local Database · Offline
            </span>
            <Dialog.Close className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink">
              Close
            </Dialog.Close>
          </div>
        </Dialog.Content>
        <LicensesDialog open={licensesOpen} onOpenChange={setLicensesOpen} />
      </Dialog.Portal>
    </Dialog.Root>
  );
}
