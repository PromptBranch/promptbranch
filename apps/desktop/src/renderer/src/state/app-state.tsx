import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { SortKey, UpdateAvailableInfo } from "../../../shared/ipc.js";

export type ViewKind = "library" | "history" | "starred" | "shares" | "trash" | "collection" | "suggestions";

export type SettingsSection = "appearance" | "editor" | "ai" | "data" | "agent" | "sharing" | "sync" | "updates" | "about";

export interface AppView {
  kind: ViewKind;
  /** Set when kind === "collection". */
  collectionId?: string;
  collectionName?: string;
}

export interface ListFilters {
  tagIds: string[];
  starredOnly: boolean;
  minRating?: number;
}

export const EMPTY_FILTERS: ListFilters = { tagIds: [], starredOnly: false };

interface AppStateValue {
  view: AppView;
  setView: (view: AppView) => void;
  selectedPromptId: string | null;
  selectPrompt: (id: string | null) => void;
  /** Version being viewed in the main pane; null = the current version. */
  viewingVersionId: string | null;
  setViewingVersionId: (id: string | null) => void;
  sort: SortKey;
  setSort: (sort: SortKey) => void;
  filters: ListFilters;
  setFilters: (filters: ListFilters) => void;
  listSearch: string;
  setListSearch: (value: string) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  newPromptOpen: boolean;
  setNewPromptOpen: (open: boolean) => void;
  aboutOpen: boolean;
  setAboutOpen: (open: boolean) => void;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  openSettings: (section?: SettingsSection) => void;
  setSettingsOpen: (open: boolean) => void;
  /** Snapshot URL/id delivered by a promptbranch://import deep link; non-null opens the import dialog. */
  importUrl: string | null;
  setImportUrl: (url: string | null) => void;
  /** The "Manage models" dialog, opened from the model picker footer or Settings. */
  manageModelsOpen: boolean;
  setManageModelsOpen: (open: boolean) => void;
  /** Latest release a check found; non-null shows the left-rail update badge. */
  updateAvailable: UpdateAvailableInfo | null;
  setUpdateAvailable: (info: UpdateAvailableInfo | null) => void;
  /** Whether the update dialog is open ("Later" closes it; the badge stays). */
  updateDialogOpen: boolean;
  setUpdateDialogOpen: (open: boolean) => void;
  /** Records the release and opens the update dialog. */
  openUpdateDialog: (info: UpdateAvailableInfo) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<AppView>({ kind: "library" });
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [viewingVersionId, setViewingVersionId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("updated");
  const [filters, setFilters] = useState<ListFilters>(EMPTY_FILTERS);
  const [listSearch, setListSearch] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newPromptOpen, setNewPromptOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  const [importUrl, setImportUrl] = useState<string | null>(null);
  const [manageModelsOpen, setManageModelsOpen] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<UpdateAvailableInfo | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);

  const selectPrompt = useCallback((id: string | null) => {
    setSelectedPromptId(id);
    setViewingVersionId(null);
  }, []);

  const openSettings = useCallback((section: SettingsSection = "appearance") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const openUpdateDialog = useCallback((info: UpdateAvailableInfo) => {
    setUpdateAvailable(info);
    setUpdateDialogOpen(true);
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({
      view,
      setView,
      selectedPromptId,
      selectPrompt,
      viewingVersionId,
      setViewingVersionId,
      sort,
      setSort,
      filters,
      setFilters,
      listSearch,
      setListSearch,
      paletteOpen,
      setPaletteOpen,
      newPromptOpen,
      setNewPromptOpen,
      aboutOpen,
      setAboutOpen,
      settingsOpen,
      settingsSection,
      openSettings,
      setSettingsOpen,
      importUrl,
      setImportUrl,
      manageModelsOpen,
      setManageModelsOpen,
      updateAvailable,
      setUpdateAvailable,
      updateDialogOpen,
      setUpdateDialogOpen,
      openUpdateDialog,
    }),
    [view, selectedPromptId, selectPrompt, viewingVersionId, sort, filters, listSearch, paletteOpen, newPromptOpen, aboutOpen, settingsOpen, settingsSection, openSettings, importUrl, manageModelsOpen, updateAvailable, updateDialogOpen, openUpdateDialog],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used inside <AppStateProvider>");
  return ctx;
}
