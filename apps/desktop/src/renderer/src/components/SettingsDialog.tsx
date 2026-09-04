import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  CloudDownload,
  Copy,
  Cpu,
  Database,
  Download,
  ExternalLink,
  HardDrive,
  Info,
  Palette,
  RefreshCcw,
  Share2,
  SquarePen,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import iconUrl from "../assets/icon.png";
import { useAppInfo, useAppMutation } from "../hooks/use-data";
import { usePref, type PrefKey } from "../lib/prefs";
import { useThemeMode, type ThemeMode } from "../lib/theme";
import { cx } from "../lib/time";
import { useToast } from "../lib/toast";
import { useAppState, type SettingsSection } from "../state/app-state";
import { AiProvidersSection } from "./AiProvidersSection";
import { ConfirmDialog } from "./dialogs";
import { LicensesDialog } from "./LicensesDialog";
import { SharingSection } from "./SharingSection";
import { SyncSection } from "./SyncSection";
import { UpdatesSection } from "./UpdatesSection";

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: React.ReactNode }> = [
  { id: "appearance", label: "Appearance", icon: <Palette size={13} /> },
  { id: "editor", label: "Editor", icon: <SquarePen size={13} /> },
  { id: "ai", label: "AI Providers", icon: <Cpu size={13} /> },
  { id: "data", label: "Data & Backup", icon: <Database size={13} /> },
  { id: "agent", label: "Agent integration", icon: <HardDrive size={13} /> },
  { id: "sharing", label: "Sharing", icon: <Share2 size={13} /> },
  { id: "sync", label: "Sync", icon: <RefreshCcw size={13} /> },
  { id: "updates", label: "Updates", icon: <CloudDownload size={13} /> },
  { id: "about", label: "About", icon: <Info size={13} /> },
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[13px] font-semibold text-ink">{children}</h3>;
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <span className="text-[12px] font-medium text-ink-dim">{children}</span>
      {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p>}
    </div>
  );
}

/** Horizontal segmented control used for theme, font size and editor mode. */
function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex w-fit rounded-md border border-line p-0.5">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cx(
            "rounded px-2.5 py-1 text-[11px] transition-colors",
            value === option.value ? "bg-accent-soft font-medium text-accent" : "text-ink-dim hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** On/off switch bound to a boolean pref. */
function PrefToggle({ pref, label, hint }: { pref: PrefKey & ("word-wrap" | "autosave-drafts"); label: string; hint?: string }) {
  const [value, setValue] = usePref(pref);
  return (
    <div className="flex items-center justify-between gap-4">
      <FieldLabel hint={hint}>{label}</FieldLabel>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => setValue(!value)}
        className={cx(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          value ? "bg-accent" : "bg-line-strong",
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]",
            value ? "left-4.5" : "left-0.5",
          )}
        />
      </button>
    </div>
  );
}

function AppearanceSection() {
  const [themeMode, setThemeMode] = useThemeMode();
  const [fontSize, setFontSize] = usePref("editor-font-size");
  const [editorMode, setEditorMode] = usePref("editor-mode");

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <FieldLabel hint="System Default follows your OS appearance.">Theme</FieldLabel>
        <SegmentedControl<ThemeMode>
          ariaLabel="Theme"
          value={themeMode}
          onChange={setThemeMode}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "System Default" },
          ]}
        />
      </div>
      <div className="space-y-2">
        <FieldLabel>Editor font size</FieldLabel>
        <SegmentedControl<number>
          ariaLabel="Editor font size"
          value={fontSize}
          onChange={setFontSize}
          options={[
            { value: 13, label: "13 px" },
            { value: 14, label: "14 px" },
            { value: 16, label: "16 px" },
          ]}
        />
      </div>
      <div className="space-y-2">
        <FieldLabel hint="Read-only versions always open in Preview.">
          Default editor mode
        </FieldLabel>
        <SegmentedControl<"edit" | "preview" | "split">
          ariaLabel="Default editor mode"
          value={editorMode}
          onChange={setEditorMode}
          options={[
            { value: "edit", label: "Edit" },
            { value: "preview", label: "Preview" },
            { value: "split", label: "Split" },
          ]}
        />
      </div>
    </div>
  );
}

function EditorSection() {
  return (
    <div className="space-y-5">
      <PrefToggle pref="word-wrap" label="Word wrap" hint="Wrap long lines in the editor instead of scrolling horizontally." />
      <PrefToggle
        pref="autosave-drafts"
        label="Autosave drafts"
        hint="Persist in-progress edits as you type. When off, changes are kept only in memory until you save them as a new version — leaving the prompt discards them."
      />
    </div>
  );
}

function DataSection() {
  const { data: appInfo } = useAppInfo();
  const { toast } = useToast();
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);

  const exportLibrary = useAppMutation(() => window.promptBuilder.library.exportJson(), {
    toast: (r) => (r.canceled ? "Export canceled" : `Library exported to ${r.path}`),
  });
  const importLibrary = useAppMutation(() => window.promptBuilder.library.importJson(), {
    onSuccess: (r) => {
      if (r.canceled || !r.summary) return;
      const prompts = r.summary["prompts"]?.inserted ?? 0;
      const versions = r.summary["versions"]?.inserted ?? 0;
      toast(`Imported ${prompts} prompts and ${versions} versions`);
    },
  });
  const backupNow = useAppMutation(() => window.promptBuilder.library.backupNow(), {
    toast: (path) => `Backup written: ${path.split(/[\\/]/).pop()}`,
  });
  const emptyTrash = useAppMutation(() => window.promptBuilder.library.emptyTrash(), {
    toast: (count) => (count === 0 ? "Trash is already empty" : `Permanently deleted ${count} prompt${count === 1 ? "" : "s"}`),
  });

  const copyDbPath = () => {
    if (!appInfo) return;
    void navigator.clipboard.writeText(appInfo.dbPath).then(
      () => toast("DB path copied"),
      () => toast("Copy failed"),
    );
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <FieldLabel>Database location</FieldLabel>
        <div className="flex items-center gap-1.5 rounded-md border border-line bg-app px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-dim" title={appInfo?.dbPath}>
            {appInfo?.dbPath ?? "…"}
          </span>
          <button
            type="button"
            onClick={copyDbPath}
            className="shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            aria-label="Copy database path"
          >
            <Copy size={12} />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <FieldLabel hint="A backup is also written automatically once a day; the last 10 are kept.">
          Backups
        </FieldLabel>
        <button
          type="button"
          onClick={() => backupNow.mutate(undefined)}
          disabled={backupNow.isPending}
          className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
        >
          <HardDrive size={12} />
          Back up now
        </button>
      </div>

      <div className="space-y-2">
        <FieldLabel hint="Export writes the whole library as JSON; import merges a JSON export back in.">
          Library transfer
        </FieldLabel>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => exportLibrary.mutate(undefined)}
            disabled={exportLibrary.isPending}
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            <Upload size={12} />
            Export library…
          </button>
          <button
            type="button"
            onClick={() => importLibrary.mutate(undefined)}
            disabled={importLibrary.isPending}
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            <Download size={12} />
            Import library…
          </button>
        </div>
      </div>

      <div className="space-y-2 rounded-lg border border-danger/20 bg-danger-soft p-3">
        <FieldLabel hint="Hard-deletes every prompt currently in Trash. This cannot be undone.">
          Danger zone
        </FieldLabel>
        <button
          type="button"
          onClick={() => setEmptyTrashOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-danger/30 px-3 py-1.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger-soft"
        >
          <Trash2 size={12} />
          Permanently empty Trash
        </button>
      </div>

      <ConfirmDialog
        open={emptyTrashOpen}
        onOpenChange={setEmptyTrashOpen}
        title="Permanently empty Trash?"
        description="Every prompt currently in Trash — including all of its versions, notes and run history — will be hard-deleted. This cannot be undone."
        confirmLabel="Empty Trash"
        danger
        onConfirm={() => emptyTrash.mutate(undefined)}
      />
    </div>
  );
}

function AgentSection() {
  const { data: appInfo } = useAppInfo();
  const { toast } = useToast();

  const copy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast(`${label} copied`),
      () => toast("Copy failed"),
    );
  };

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        promptbranch: { command: "npx", args: ["-y", "@promptbranch/mcp@latest"] },
      },
    },
    null,
    2,
  );

  if (!appInfo) return null;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <FieldLabel>Database path</FieldLabel>
        <div className="flex items-center gap-1.5 rounded-md border border-line bg-app px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-dim" title={appInfo.dbPath}>
            {appInfo.dbPath}
          </span>
          <button
            type="button"
            onClick={() => copy(appInfo.dbPath, "DB path")}
            className="shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            aria-label="Copy database path"
          >
            <Copy size={12} />
          </button>
        </div>
      </div>
      <div className="space-y-1.5">
        <FieldLabel>MCP client config</FieldLabel>
        <pre className="max-h-36 overflow-auto rounded-md border border-line bg-app p-2 font-mono text-[11px] leading-snug text-ink-dim">
          {mcpConfig}
        </pre>
        <button
          type="button"
          onClick={() => copy(mcpConfig, "MCP config")}
          className="flex items-center gap-1 rounded-md bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-hover"
        >
          <Copy size={11} />
          Copy MCP client config
        </button>
        <p className="text-[11px] leading-snug text-ink-faint">
          Or use the CLI: <span className="font-mono">npx -y @promptbranch/cli@latest get
          &lt;name&gt; --json</span>.
          The <span className="font-mono">@promptbranch/mcp</span> package also includes an agent skill file.
        </p>
      </div>
    </div>
  );
}

function AboutSection({ onOpenAboutDialog }: { onOpenAboutDialog: () => void }) {
  const { data: appInfo } = useAppInfo();
  const { toast } = useToast();
  const [licensesOpen, setLicensesOpen] = useState(false);

  const openWebsite = () => {
    void window.promptBuilder.app.openExternal("https://promptbranch.app/").catch(() => {
      toast("Could not open link");
    });
  };

  const runtimes: Array<[string, string]> = appInfo
    ? [
        ["Electron", appInfo.electronVersion],
        ["Chromium", appInfo.chromeVersion],
        ["Node.js", appInfo.nodeVersion],
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <img src={iconUrl} alt="PromptBranch icon" className="h-12 w-12 rounded-xl" />
        <div>
          <p className="text-[14px] font-semibold tracking-tight text-ink">PromptBranch</p>
          <p className="text-[12px] tabular-nums text-ink-dim">Version {appInfo?.version ?? "…"}</p>
          <p className="text-[11px] text-ink-faint">Local-first prompt library and versioning tool</p>
          <button
            type="button"
            onClick={openWebsite}
            className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-accent transition-colors hover:underline"
          >
            https://promptbranch.app/
            <ExternalLink size={10} aria-hidden />
          </button>
        </div>
      </div>
      <dl className="space-y-1.5 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[11px] text-ink-faint">Website</dt>
          <dd className="text-[11px]">
            <button
              type="button"
              onClick={openWebsite}
              className="inline-flex items-center gap-1 text-accent transition-colors hover:underline"
            >
              promptbranch.app
              <ExternalLink size={10} aria-hidden />
            </button>
          </dd>
        </div>
        {runtimes.map(([label, version]) => (
          <div key={label} className="flex items-baseline justify-between gap-4">
            <dt className="text-[11px] text-ink-faint">{label}</dt>
            <dd className="font-mono text-[11px] tabular-nums text-ink-dim">{version}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-between border-t border-line pt-3">
        <p className="text-[11px] text-ink-faint">© 2026 PromptBranch</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setLicensesOpen(true)}
            className="text-[11px] text-accent hover:underline"
          >
            Open Source Licenses
          </button>
          <button
            type="button"
            onClick={onOpenAboutDialog}
            className="text-[11px] text-accent hover:underline"
          >
            Open About window
          </button>
        </div>
      </div>
      <LicensesDialog open={licensesOpen} onOpenChange={setLicensesOpen} />
    </div>
  );
}

/**
 * Settings window-dialog: left section nav + right content. Opened from the
 * left-rail gear or the app menu (app:open-settings); the section can be
 * preselected via app state.
 */
export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen, settingsSection, setAboutOpen } = useAppState();
  const [section, setSection] = useState<SettingsSection>(settingsSection);

  // Opening via menu/gear may target a specific section; adopt it on open.
  useEffect(() => {
    if (settingsOpen) setSection(settingsSection);
  }, [settingsOpen, settingsSection]);

  return (
    <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="pb-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="pb-dialog fixed left-1/2 top-1/2 z-50 flex h-[min(520px,calc(100vh-2rem))] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/50 focus:outline-none"
        >
          <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-line bg-app p-2">
            <Dialog.Title className="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              Settings
            </Dialog.Title>
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={cx(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors",
                  section === item.id
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-ink-dim hover:bg-hover hover:text-ink",
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <SectionTitle>{SECTIONS.find((s) => s.id === section)?.label}</SectionTitle>
              <Dialog.Close
                aria-label="Close"
                className="rounded-md p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
              >
                <X size={15} />
              </Dialog.Close>
            </div>
            <div className="@container min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {section === "appearance" && <AppearanceSection />}
              {section === "editor" && <EditorSection />}
              {section === "ai" && <AiProvidersSection />}
              {section === "data" && <DataSection />}
              {section === "agent" && <AgentSection />}
              {section === "sharing" && <SharingSection />}
              {section === "sync" && <SyncSection />}
              {section === "updates" && <UpdatesSection />}
              {section === "about" && (
                <AboutSection
                  onOpenAboutDialog={() => {
                    setSettingsOpen(false);
                    setAboutOpen(true);
                  }}
                />
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
