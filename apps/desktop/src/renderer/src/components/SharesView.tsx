import { useMemo, useState } from "react";
import { Copy, ExternalLink, FolderX, Link2, Search, Trash2 } from "lucide-react";
import type { SharedSnapshotDto } from "../../../shared/ipc.js";
import { useAppMutation, useShares } from "../hooks/use-data";
import { cx, relativeTime } from "../lib/time";
import { useToast } from "../lib/toast";
import { useAppState } from "../state/app-state";
import { ConfirmDialog } from "./dialogs";
import { EmptyState, Spinner } from "./ui";

type StatusFilter = "all" | "active" | "revoked";
type SortKey = "recent" | "title";

const inputClass =
  "w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";

const iconButtonClass =
  "shrink-0 rounded p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink";

function portalHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ShareRow({ share, onDelete }: { share: SharedSnapshotDto; onDelete: (share: SharedSnapshotDto) => void }) {
  const { toast } = useToast();
  const { selectPrompt, setView } = useAppState();
  const revoked = share.deletedAt !== null;

  const copy = () => {
    void navigator.clipboard.writeText(share.url).then(
      () => toast("Link copied"),
      () => toast("Copy failed"),
    );
  };

  const meta =
    share.deletedAt !== null
      ? `${portalHost(share.url)} · revoked ${relativeTime(share.deletedAt)}`
      : `${portalHost(share.url)} · published ${relativeTime(share.publishedAt)}`;

  return (
    <li
      className={cx(
        "rounded-lg border border-line bg-panel p-3 transition-colors hover:border-line-strong",
        revoked && "opacity-55",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link2 size={12} className="shrink-0 text-ink-faint" />
          {share.promptId !== null ? (
            <button
              type="button"
              title="Open the source prompt"
              onClick={() => {
                setView({ kind: "library" });
                selectPrompt(share.promptId);
              }}
              className="min-w-0 truncate text-left text-[13px] font-semibold text-ink transition-colors hover:text-accent"
            >
              {share.promptTitle}
            </button>
          ) : (
            <span className="min-w-0 truncate text-[13px] font-semibold text-ink" title="The source prompt was deleted">
              {share.promptTitle}
            </span>
          )}
          {share.promptId === null && (
            <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-[10px] text-ink-faint">
              Source deleted
            </span>
          )}
          {share.fullHistory && !revoked && (
            <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-[10px] text-ink-faint">
              Full history
            </span>
          )}
          {revoked && (
            <span className="shrink-0 rounded-full border border-danger/40 bg-danger-soft px-1.5 py-px text-[10px] text-danger">
              Revoked
            </span>
          )}
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">{relativeTime(share.publishedAt)}</span>
      </div>
      <p className="mt-1 truncate pl-[20px] font-mono text-[10px] text-ink-faint">{share.url}</p>
      <div className="mt-2 flex items-center gap-2 pl-[20px]">
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{meta}</span>
        <button type="button" aria-label={`Copy link to ${share.promptTitle}`} onClick={copy} className={iconButtonClass}>
          <Copy size={12} />
        </button>
        <button
          type="button"
          aria-label={`Open ${share.promptTitle} in browser`}
          onClick={() => {
            // Electron denies window.open — external links must go through
            // the main process (http/https validated there).
            void window.promptBuilder.app.openExternal(share.url).catch(() => toast("Could not open the link"));
          }}
          className={iconButtonClass}
        >
          <ExternalLink size={12} />
        </button>
        {!revoked && (
          <button
            type="button"
            aria-label={`Delete share of ${share.promptTitle}`}
            onClick={() => onDelete(share)}
            className={cx(iconButtonClass, "hover:text-danger")}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * Library-wide management view for published snapshots: search, status
 * filtering and per-share actions (copy link, open, revoke). Replacing the
 * old Settings list — the portal URL configuration stays in Settings.
 * The delete token never reaches the renderer; revoke runs in main.
 */
export function SharesView() {
  const { data: shares, isLoading } = useShares();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const [deleteTarget, setDeleteTarget] = useState<SharedSnapshotDto | null>(null);

  const deleteShare = useAppMutation(
    (snapshotId: string) => window.promptBuilder.share.delete(snapshotId),
    { toast: "Share deleted" },
  );

  const all = shares ?? [];
  const activeCount = all.filter((share) => share.deletedAt === null).length;
  const revokedCount = all.length - activeCount;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = all.filter((share) => {
      if (status === "active" && share.deletedAt !== null) return false;
      if (status === "revoked" && share.deletedAt === null) return false;
      if (needle === "") return true;
      return (
        share.promptTitle.toLowerCase().includes(needle) || share.url.toLowerCase().includes(needle)
      );
    });
    return filtered.sort((a, b) =>
      sort === "recent"
        ? b.publishedAt.localeCompare(a.publishedAt)
        : a.promptTitle.localeCompare(b.promptTitle),
    );
  }, [all, query, status, sort]);

  const statusButton = (value: StatusFilter, label: string) => (
    <button
      key={value}
      type="button"
      aria-pressed={status === value}
      onClick={() => setStatus(value)}
      className={cx(
        "rounded px-2.5 py-1 text-[12px] font-medium transition-colors",
        status === value
          ? "bg-raised text-ink shadow-sm"
          : "text-ink-faint hover:text-ink-dim active:translate-y-[1px]",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="border-b border-line px-5 py-3.5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-[14px] font-semibold text-ink">Shares</h1>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              {all.length === 0
                ? "Prompts published from this library show up here"
                : `${activeCount} active${revokedCount > 0 ? ` · ${revokedCount} revoked` : ""} — links stay valid until you revoke them`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="relative">
              <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
              <input
                aria-label="Search shares"
                placeholder="Search title or URL…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className={cx(inputClass, "w-52 pl-7")}
              />
            </div>
            <select
              aria-label="Sort shares"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-md border border-line bg-app px-2 py-1.5 text-[12px] text-ink transition-colors hover:border-line-strong"
            >
              <option value="recent">Recently published</option>
              <option value="title">Title</option>
            </select>
          </div>
        </div>
        <div className="mt-2.5 inline-flex items-center gap-0.5 rounded-lg border border-line bg-app p-0.5">
          {statusButton("all", "All")}
          {statusButton("active", "Active")}
          {statusButton("revoked", "Revoked")}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {isLoading && <Spinner />}
        {!isLoading && all.length === 0 && (
          <EmptyState
            icon={<Link2 size={16} />}
            title="Nothing published yet"
            hint="Use the Share button on a prompt to publish a snapshot to your portal."
          />
        )}
        {!isLoading && all.length > 0 && visible.length === 0 && (
          <EmptyState
            icon={<Search size={16} />}
            title="No matching shares"
            hint="Try a different search or status filter."
          />
        )}
        <ul className="space-y-2">
          {visible.map((share) => (
            <ShareRow key={share.snapshotId} share={share} onDelete={setDeleteTarget} />
          ))}
        </ul>
        {!isLoading && all.length === 0 && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2.5 text-[11px] text-ink-faint">
            <FolderX size={13} className="shrink-0" />
            Revoking a share deletes the snapshot on the portal — its link stops working. The local prompt is never touched.
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title={`Delete the share of "${deleteTarget?.promptTitle}"?`}
        description="The snapshot is deleted on the portal (its link stops working) and the local record is marked as revoked. This cannot be undone."
        confirmLabel="Delete share"
        danger
        onConfirm={() => {
          if (deleteTarget) deleteShare.mutate(deleteTarget.snapshotId);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
