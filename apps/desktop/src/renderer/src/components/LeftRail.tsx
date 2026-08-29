import { useState } from "react";
import {
  BookOpen,
  Clock,
  CloudDownload,
  Folder,
  HardDrive,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Share2,
  Star,
  Trash2,
} from "lucide-react";
import iconUrl from "../assets/icon.png";
import { useAppMutation, useAppInfo, useCollections, useShares, useSuggestions, useTags } from "../hooks/use-data";
import { cx } from "../lib/time";
import { useAppState, type AppView } from "../state/app-state";
import { colorForName, SectionLabel } from "./ui";
import { NameDialog } from "./dialogs";
import { SyncStatusRow } from "./SyncStatusRow";

const TAG_PREVIEW_COUNT = 8;

function NavItem({
  view,
  label,
  icon,
  badge,
  collapsed,
}: {
  view: AppView;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  collapsed?: boolean;
}) {
  const { view: current, setView, selectPrompt } = useAppState();
  const active = current.kind === view.kind;

  if (collapsed) {
    return (
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={() => {
          setView(view);
          selectPrompt(null);
        }}
        className={cx(
          "relative flex h-8 w-8 items-center justify-center rounded-md transition-colors",
          active ? "bg-accent-soft text-accent" : "text-ink-dim hover:bg-hover hover:text-ink",
        )}
      >
        {icon}
        {badge !== undefined && badge > 0 && (
          <span className="absolute right-0.5 top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-accent px-0.5 text-[8px] font-semibold tabular-nums text-white">
            {badge}
          </span>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setView(view);
        selectPrompt(null);
      }}
      className={cx(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
        active ? "bg-accent-soft font-medium text-accent" : "text-ink-dim hover:bg-hover hover:text-ink",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto shrink-0 rounded-full bg-accent px-1.5 py-px text-[10px] font-semibold tabular-nums text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

export function LeftRail({
  collapsed = false,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { view, setView, selectPrompt, openSettings, updateAvailable, openUpdateDialog } = useAppState();
  const { data: tags } = useTags();
  const { data: collections } = useCollections();
  const { data: appInfo } = useAppInfo();
  const { data: suggestions } = useSuggestions();
  const { data: shares } = useShares();
  // Badge counts live (non-revoked) shares only — revoked ones need no attention.
  const activeShareCount = (shares ?? []).filter((share) => share.deletedAt === null).length;
  const [showAllTags, setShowAllTags] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [collectionDialogOpen, setCollectionDialogOpen] = useState(false);

  const createTag = useAppMutation((name: string) => window.promptBuilder.tags.create({ name, color: colorForName(name) }), {
    toast: (t) => `Tag "${t.name}" created`,
  });
  const createCollection = useAppMutation((name: string) => window.promptBuilder.collections.create(name), {
    toast: (c) => `Collection "${c.name}" created`,
  });

  const visibleTags = showAllTags ? (tags ?? []) : (tags ?? []).slice(0, TAG_PREVIEW_COUNT);

  // Slim icon-only strip shown when the rail panel is collapsed, so nav
  // stays reachable.
  if (collapsed) {
    return (
      <aside className="flex h-full w-full flex-col items-center bg-panel py-2">
        <img src={iconUrl} alt="PromptBranch" className="h-6 w-6 rounded-md" />
        <nav className="mt-3 flex flex-col items-center space-y-0.5">
          <NavItem collapsed view={{ kind: "library" }} label="Library" icon={<BookOpen size={15} />} />
          <NavItem collapsed view={{ kind: "history" }} label="History" icon={<Clock size={15} />} />
          <NavItem collapsed view={{ kind: "starred" }} label="Starred" icon={<Star size={15} />} />
          <NavItem
            collapsed
            view={{ kind: "shares" }}
            label="Shares"
            icon={<Share2 size={15} />}
            badge={activeShareCount > 0 ? activeShareCount : undefined}
          />
          <NavItem
            collapsed
            view={{ kind: "suggestions" }}
            label="Suggestions"
            icon={<Inbox size={15} />}
            badge={suggestions?.length}
          />
          <NavItem collapsed view={{ kind: "trash" }} label="Trash" icon={<Trash2 size={15} />} />
        </nav>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          className="mt-auto flex h-8 w-8 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        >
          <PanelLeftOpen size={15} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-full flex-col bg-panel">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <img src={iconUrl} alt="PromptBranch" className="h-6 w-6 shrink-0 rounded-md" />
        <span className="text-[13px] font-semibold tracking-tight text-ink">PromptBranch</span>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          className="ml-auto rounded p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        >
          <PanelLeftClose size={13} />
        </button>
      </div>

      <nav className="space-y-0.5 px-2 pt-1">
        <NavItem view={{ kind: "library" }} label="Library" icon={<BookOpen size={15} />} />
        <NavItem view={{ kind: "history" }} label="History" icon={<Clock size={15} />} />
        <NavItem view={{ kind: "starred" }} label="Starred" icon={<Star size={15} />} />
        <NavItem
          view={{ kind: "shares" }}
          label="Shares"
          icon={<Share2 size={15} />}
          badge={activeShareCount > 0 ? activeShareCount : undefined}
        />
        <NavItem
          view={{ kind: "suggestions" }}
          label="Suggestions"
          icon={<Inbox size={15} />}
          badge={suggestions?.length}
        />
        <NavItem view={{ kind: "trash" }} label="Trash" icon={<Trash2 size={15} />} />
      </nav>

      <div className="mt-5 px-2">
        <div className="flex items-center justify-between pr-1">
          <SectionLabel>Collections</SectionLabel>
          <button
            type="button"
            onClick={() => setCollectionDialogOpen(true)}
            className="mb-1 rounded p-0.5 text-ink-faint transition-colors hover:text-ink"
            aria-label="New collection"
          >
            <Plus size={13} />
          </button>
        </div>
        <div className="space-y-0.5">
          {(collections ?? []).map((c) => {
            const active = view.kind === "collection" && view.collectionId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setView({ kind: "collection", collectionId: c.id, collectionName: c.name });
                  selectPrompt(null);
                }}
                className={cx(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors",
                  active ? "bg-accent-soft font-medium text-accent" : "text-ink-dim hover:bg-hover hover:text-ink",
                )}
              >
                <Folder size={14} style={{ color: colorForName(c.name) }} />
                <span className="min-w-0 flex-1 truncate text-left">{c.name}</span>
                <span className="text-[11px] tabular-nums text-ink-faint">{c.promptCount}</span>
              </button>
            );
          })}
          {(collections ?? []).length === 0 && (
            <p className="px-2 py-1 text-[11px] text-ink-faint">No collections yet</p>
          )}
        </div>
      </div>

      <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2">
        <div className="flex items-center justify-between pr-1">
          <SectionLabel>Tags</SectionLabel>
          <button
            type="button"
            onClick={() => setTagDialogOpen(true)}
            className="mb-1 rounded p-0.5 text-ink-faint transition-colors hover:text-ink"
            aria-label="New tag"
          >
            <Plus size={13} />
          </button>
        </div>
        <div className="space-y-0.5">
          {visibleTags.map((tag) => (
            <div
              key={tag.id}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-[13px] text-ink-dim"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: tag.color ?? colorForName(tag.name) }}
              />
              <span className="min-w-0 flex-1 truncate">{tag.name}</span>
              <span className="text-[11px] tabular-nums text-ink-faint">{tag.usageCount}</span>
            </div>
          ))}
          {(tags ?? []).length > TAG_PREVIEW_COUNT && (
            <button
              type="button"
              onClick={() => setShowAllTags((v) => !v)}
              className="px-2 py-1 text-[11px] text-accent hover:underline"
            >
              {showAllTags ? "Show less" : `Show ${(tags ?? []).length - TAG_PREVIEW_COUNT} more`}
            </button>
          )}
          {(tags ?? []).length === 0 && <p className="px-2 py-1 text-[11px] text-ink-faint">No tags yet</p>}
        </div>
      </div>

      <div className="mt-auto border-t border-line px-2 py-2 space-y-0.5">
        <SyncStatusRow />
        <div className="flex items-center gap-2 rounded-md px-2 py-1">
          <HardDrive size={13} className="shrink-0 text-ink-faint" />
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-ink-dim">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
            <span className="truncate">Local Database</span>
          </span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-faint">
            v{appInfo?.version ?? "…"}
          </span>
          {updateAvailable && (
            <button
              type="button"
              onClick={() => openUpdateDialog(updateAvailable)}
              className="relative rounded p-1 text-accent transition-colors hover:bg-hover"
              aria-label={`Update available — v${updateAvailable.version}`}
              title={`Update available — v${updateAvailable.version}`}
            >
              <CloudDownload size={13} />
              <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
            </button>
          )}
          <button
            type="button"
            onClick={() => openSettings()}
            className="-mr-1 rounded p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            aria-label="Settings"
            title="Settings"
          >
            <Settings size={13} />
          </button>
        </div>
      </div>

      <NameDialog
        open={tagDialogOpen}
        onOpenChange={setTagDialogOpen}
        title="New tag"
        label="Name"
        placeholder="e.g. security"
        submitLabel="Create tag"
        onSubmit={(name) => createTag.mutate(name)}
      />
      <NameDialog
        open={collectionDialogOpen}
        onOpenChange={setCollectionDialogOpen}
        title="New collection"
        label="Name"
        placeholder="e.g. Architecture"
        submitLabel="Create collection"
        onSubmit={(name) => createCollection.mutate(name)}
      />
    </aside>
  );
}
