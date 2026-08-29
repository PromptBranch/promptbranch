import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { useAppMutation, usePortalBaseUrl, useShares } from "../hooks/use-data";
import { useAppState } from "../state/app-state";

const inputClass =
  "w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <span className="text-[12px] font-medium text-ink-dim">{children}</span>
      {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p>}
    </div>
  );
}

/**
 * Settings → Sharing: which portal this library publishes to, plus a summary
 * pointing at the Shares view where published snapshots are managed
 * (search, filter, revoke). The delete token never reaches the renderer.
 */
export function SharingSection() {
  const { data: portalBaseUrl } = usePortalBaseUrl();
  const { data: shares } = useShares();
  const { setView, setSettingsOpen } = useAppState();
  // null = untouched (show the stored value); a string = the user's draft.
  const [urlDraft, setUrlDraft] = useState<string | null>(null);

  const savePortal = useAppMutation(
    (baseUrl: string) => window.promptBuilder.share.setPortalBaseUrl(baseUrl),
    {
      toast: "Portal URL saved",
      invalidateKeys: [["portal-base-url"]],
      onSuccess: () => setUrlDraft(null),
    },
  );

  const shownUrl = urlDraft ?? portalBaseUrl ?? "";
  const all = shares ?? [];
  const activeCount = all.filter((share) => share.deletedAt === null).length;
  const revokedCount = all.length - activeCount;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <FieldLabel hint="Where snapshots are published. Leave the default to use the official instance (https://promptbranch.app), or enter your self-hosted portal. Saving an empty value resets to the official instance.">
          Portal
        </FieldLabel>
        <div className="flex items-center gap-2">
          <input
            aria-label="Portal base URL"
            value={shownUrl}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="https://promptbranch.app"
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => savePortal.mutate(shownUrl)}
            disabled={urlDraft === null || savePortal.isPending}
            className="shrink-0 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            Save portal URL
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <FieldLabel hint="Published snapshots are managed in the Shares view — search, open, copy links and revoke.">
          Published snapshots
        </FieldLabel>
        <button
          type="button"
          onClick={() => {
            setSettingsOpen(false);
            setView({ kind: "shares" });
          }}
          className="flex w-full items-center justify-between gap-3 rounded-md border border-line bg-app px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-hover"
        >
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">
              {all.length === 0
                ? "Nothing published yet"
                : `${activeCount} active share${activeCount === 1 ? "" : "s"}${revokedCount > 0 ? `, ${revokedCount} revoked` : ""}`}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
              Manage search, links and revocation in the Shares view
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-accent">
            Manage shares
            <ArrowRight size={13} />
          </span>
        </button>
      </div>
    </div>
  );
}
