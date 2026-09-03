import { useEffect, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { AboutDialog } from "./components/AboutDialog";
import { CommandPalette } from "./components/CommandPalette";
import { NewPromptDialog } from "./components/dialogs";
import { HistoryView } from "./components/HistoryView";
import { ImportSnapshotDialog } from "./components/ImportSnapshotDialog";
import { LeftRail } from "./components/LeftRail";
import { MainPane, MainPaneEmpty } from "./components/MainPane";
import { ManageModelsDialog } from "./components/ManageModelsDialog";
import { PromptListPane } from "./components/PromptListPane";
import { SettingsDialog } from "./components/SettingsDialog";
import { SharesView } from "./components/SharesView";
import { SuggestionsView } from "./components/SuggestionsView";
import { SyncPairRequestDialog } from "./components/SyncPairRequestDialog";
import {
  useAppMutation,
  usePromptDetail,
  usePromptList,
  useTags,
  useUpdateEvents,
} from "./hooks/use-data";
import { togglePanel } from "./lib/panels";
import { usePref } from "./lib/prefs";
import { useAppState } from "./state/app-state";

/** 1px divider between panels; hover/drag styling lives in index.css. */
function ResizeSeparator() {
  return <Separator className="w-px shrink-0" />;
}

function useGlobalShortcuts() {
  const { paletteOpen, setPaletteOpen } = useAppState();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(!paletteOpen);
      } else if (mod && event.key.toLowerCase() === "f") {
        event.preventDefault();
        document.getElementById("prompt-search-input")?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen, setPaletteOpen]);
}

export default function App() {
  const {
    view,
    selectedPromptId,
    selectPrompt,
    newPromptOpen,
    newPromptCollection,
    setNewPromptOpen,
    setView,
    aboutOpen,
    setAboutOpen,
    openSettings,
    manageModelsOpen,
    setManageModelsOpen,
    setImportUrl,
  } = useAppState();
  const { data: prompt } = usePromptDetail(selectedPromptId);
  const { data: allTags } = useTags();
  const { data: list } = usePromptList();
  const [editorFontSize] = usePref("editor-font-size");
  useGlobalShortcuts();
  useUpdateEvents();

  // "About PromptBranch" from the macOS app menu / Help menu opens the
  // branded in-app dialog; "Settings…" (⌘,) opens the Settings dialog.
  useEffect(() => window.promptBuilder.app.onOpenAbout(() => setAboutOpen(true)), [setAboutOpen]);
  useEffect(() => window.promptBuilder.app.onOpenSettings(() => openSettings()), [openSettings]);

  // promptbranch://import?url=… deep links (portal "Open in PromptBranch").
  useEffect(() => window.promptBuilder.share.onOpenImport((url) => setImportUrl(url)), [setImportUrl]);

  // Editor font size pref → CSS var consumed by .cm-host in index.css.
  useEffect(() => {
    document.documentElement.style.setProperty("--cm-font-size", `${editorFontSize}px`);
  }, [editorFontSize]);

  // Resizable/collapsible layout: rail | list | main. Layouts (including
  // collapsed state) persist in localStorage via useDefaultLayout.
  const rootLayout = useDefaultLayout({ id: "promptbuilder-root", storage: localStorage });
  const columnLayout = useDefaultLayout({ id: "promptbuilder-columns", storage: localStorage });
  const railRef = usePanelRef();
  const listRef = usePanelRef();
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(false);

  // Auto-select the first prompt so the main pane is never needlessly empty.
  const isFullPageView = view.kind === "history" || view.kind === "suggestions" || view.kind === "shares";
  useEffect(() => {
    if (isFullPageView || selectedPromptId !== null) return;
    const first = list?.[0];
    if (first) selectPrompt(first.id);
  }, [isFullPageView, selectedPromptId, list, selectPrompt]);

  const createPrompt = useAppMutation(
    (input: {
      title: string;
      description: string;
      content: string;
      tagIds: string[];
      collectionId?: string;
      collectionName?: string;
    }) =>
      window.promptBuilder.prompts.create({
        title: input.title,
        content: input.content,
        ...(input.description ? { description: input.description } : {}),
        ...(input.tagIds.length > 0 ? { tagIds: input.tagIds } : {}),
        ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      }),
    {
      onSuccess: (created, input) => {
        if (input.collectionId) {
          setView({
            kind: "collection",
            collectionId: input.collectionId,
            collectionName: input.collectionName,
          });
        } else if (view.kind === "trash") {
          setView({ kind: "library" });
        }
        selectPrompt(created.id);
      },
      toast: (created) => `Created “${created.title}”`,
    },
  );

  return (
    <>
      <Group
        orientation="horizontal"
        className="h-full bg-app text-ink"
        defaultLayout={rootLayout.defaultLayout}
        onLayoutChanged={rootLayout.onLayoutChanged}
      >
        <Panel
          id="rail"
          collapsible
          collapsedSize={48}
          minSize={180}
          maxSize={320}
          defaultSize={224}
          groupResizeBehavior="preserve-pixel-size"
          panelRef={railRef}
          onResize={(size) => setRailCollapsed(size.inPixels <= 49)}
          className="min-h-0"
        >
          <LeftRail
            collapsed={railCollapsed}
            onToggleCollapse={() => togglePanel(railRef.current, setRailCollapsed)}
          />
        </Panel>
        <ResizeSeparator />
        <Panel id="content" minSize={480} className="min-h-0 min-w-0">
          {view.kind === "history" ? (
            <HistoryView />
          ) : view.kind === "suggestions" ? (
            <SuggestionsView />
          ) : view.kind === "shares" ? (
            <SharesView />
          ) : (
            <Group
              orientation="horizontal"
              className="h-full"
              defaultLayout={columnLayout.defaultLayout}
              onLayoutChanged={columnLayout.onLayoutChanged}
            >
              <Panel
                id="list"
                collapsible
                collapsedSize={36}
                minSize={280}
                maxSize={520}
                defaultSize={340}
                groupResizeBehavior="preserve-pixel-size"
                panelRef={listRef}
                onResize={(size) => setListCollapsed(size.inPixels <= 37)}
                className="min-h-0"
              >
                <PromptListPane
                  collapsed={listCollapsed}
                  onToggleCollapse={() => togglePanel(listRef.current, setListCollapsed)}
                />
              </Panel>
              <ResizeSeparator />
              <Panel id="main" minSize={320} className="min-h-0 min-w-0">
                {selectedPromptId && prompt ? <MainPane prompt={prompt} /> : <MainPaneEmpty />}
              </Panel>
            </Group>
          )}
        </Panel>
      </Group>

      <CommandPalette />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <ImportSnapshotDialog />
      <SyncPairRequestDialog />
      <SettingsDialog />
      <ManageModelsDialog open={manageModelsOpen} onOpenChange={setManageModelsOpen} />
      <NewPromptDialog
        open={newPromptOpen}
        onOpenChange={setNewPromptOpen}
        allTags={allTags ?? []}
        onCreate={(input) =>
          createPrompt.mutate({
            ...input,
            ...(newPromptCollection
              ? {
                  collectionId: newPromptCollection.id,
                  collectionName: newPromptCollection.name,
                }
              : {}),
          })
        }
      />
    </>
  );
}
