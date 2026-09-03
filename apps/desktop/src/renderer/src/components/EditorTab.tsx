import { memo, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { Bold, Braces, Code, Columns2, Eye, Italic, Link, List, ListChecks, Loader2, Save, Sparkles, SquarePen, X } from "lucide-react";
import type { PromptDetail, VersionContentDto } from "../../../shared/ipc.js";
import { qk, useAppMutation } from "../hooks/use-data";
import { getPref, usePref } from "../lib/prefs";
import type { ModelRef } from "../lib/ai-prefs";
import { enqueuePromptDraftWrite } from "../lib/draft-save-coordinator";
import { useResolvedTheme } from "../lib/theme";
import { clockTime, cx, wordCount } from "../lib/time";
import { useToast } from "../lib/toast";
import { useAppState } from "../state/app-state";
import { SaveVersionDialog } from "./dialogs";
import { MarkdownPreview } from "./MarkdownPreview";
import { ModelPicker, useAvailableModels } from "./model-picker";

const darkTheme = EditorView.theme({}, { dark: true });
const lightTheme = EditorView.theme({}, { dark: false });

type EditorMode = "edit" | "preview" | "split";

const MODES: Array<{ value: EditorMode; label: string; icon: React.ReactNode }> = [
  { value: "edit", label: "Edit", icon: <SquarePen size={12} /> },
  { value: "preview", label: "Preview", icon: <Eye size={12} /> },
  { value: "split", label: "Split", icon: <Columns2 size={12} /> },
];

/** Read-only (historical) versions always open in Preview; the current
   version opens in the user's default mode (Settings → Appearance). */

function wrapSelection(view: EditorView, before: string, after = before) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: `${before}${selected}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
  });
  view.focus();
}

function insertText(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  });
  view.focus();
}

function prefixLines(view: EditorView, prefix: string) {
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  const changes = [];
  for (let line = startLine.number; line <= endLine.number; line += 1) {
    changes.push({ from: view.state.doc.line(line).from, insert: prefix });
  }
  view.dispatch({ changes });
  view.focus();
}

interface ToolbarAction {
  label: string;
  icon: React.ReactNode;
  run: (view: EditorView) => void;
}

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { label: "Bold", icon: <Bold size={13} />, run: (v) => wrapSelection(v, "**") },
  { label: "Italic", icon: <Italic size={13} />, run: (v) => wrapSelection(v, "*") },
  { label: "Inline code", icon: <Code size={13} />, run: (v) => wrapSelection(v, "`") },
  { label: "Link", icon: <Link size={13} />, run: (v) => wrapSelection(v, "[", "](https://)") },
  { label: "Bullet list", icon: <List size={13} />, run: (v) => prefixLines(v, "- ") },
  { label: "Checklist", icon: <ListChecks size={13} />, run: (v) => prefixLines(v, "- [ ] ") },
  { label: "Insert variable", icon: <Braces size={13} />, run: (v) => insertText(v, "{{variable}}") },
];

const inputClass =
  "w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";

/**
 * "Improve with AI": instruction + model → ai:assist(mode 'improve') on the
 * current draft, with a preview before applying. Applying only replaces the
 * draft content — saving as a version stays a separate user action.
 */
function ImproveDialog({
  open,
  onOpenChange,
  content,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current editor content (draft included) at invocation time. */
  content: string;
  onApply: (improved: string) => void;
}) {
  const availableModels = useAvailableModels();
  const [instruction, setInstruction] = useState("");
  const [model, setModel] = useState<ModelRef | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setInstruction("");
      setModel(availableModels[0] ?? null);
      setResult(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const improve = useAppMutation(
    () =>
      window.promptBuilder.ai.assist({
        mode: "improve",
        content,
        instruction: instruction.trim(),
        providerId: model!.providerId,
        modelId: model!.modelId,
      }),
    { quiet: true, onSuccess: (r) => setResult(r.text) },
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pb-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="pb-dialog fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line-strong bg-panel p-5 shadow-2xl shadow-black/50 focus:outline-none"
        >
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Sparkles size={14} className="text-accent" />
              Improve with AI
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="rounded-md p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <X size={15} />
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-ink-dim">Instruction</span>
              <textarea
                autoFocus
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="Make it more concise…"
                rows={2}
                className={cx(inputClass, "resize-y leading-relaxed")}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-ink-dim">Model</span>
              <ModelPicker
                multi={false}
                selection={model ? [model] : []}
                onChange={(next) => setModel(next[0] ?? null)}
                open={modelPickerOpen}
                onOpenChange={setModelPickerOpen}
                align="start"
                fullWidthTrigger
              />
            </label>
            {(result !== null || improve.isPending) && (
              <div className="min-h-0 flex-1 space-y-1.5">
                <span className="text-xs font-medium text-ink-dim">Result</span>
                <div className="max-h-64 overflow-y-auto rounded-md border border-line bg-app p-3">
                  {improve.isPending ? (
                    <p className="flex items-center gap-2 text-[12px] text-ink-faint">
                      <Loader2 size={12} className="animate-spin" />
                      Improving…
                    </p>
                  ) : (
                    <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink">{result}</pre>
                  )}
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
              >
                Cancel
              </button>
              {result !== null && !improve.isPending && (
                <button
                  type="button"
                  onClick={() => improve.mutate(undefined)}
                  className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                >
                  Try again
                </button>
              )}
              {result === null || improve.isPending ? (
                <button
                  type="button"
                  onClick={() => improve.mutate(undefined)}
                  disabled={!instruction.trim() || model === null || improve.isPending}
                  className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {improve.isPending && <Loader2 size={12} className="animate-spin" />}
                  Improve
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    onApply(result);
                    onOpenChange(false);
                  }}
                  className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-strong"
                >
                  Apply to editor
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Memoized: MainPane holds the live-run state, so every streamed delta would
 * otherwise re-render the whole pane — including this CodeMirror editor. All
 * props keep identity across delta renders (query-cached objects + a ref).
 */
export const EditorTab = memo(function EditorTab({
  prompt,
  version,
  isCurrent,
  liveContentRef,
}: {
  prompt: PromptDetail;
  version: VersionContentDto;
  isCurrent: boolean;
  /** Mirror of the current editor content (incl. unsaved edits) for the Run flow. */
  liveContentRef?: { current: string | null };
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { openSettings } = useAppState();
  const availableModels = useAvailableModels();
  const [improveOpen, setImproveOpen] = useState(false);
  const initialContent = isCurrent ? (prompt.draftContent ?? version.content) : version.content;
  const [content, setContent] = useState(initialContent);
  const [savedAt, setSavedAt] = useState<number | null>(isCurrent && prompt.draftContent ? Date.now() : null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [defaultMode, setDefaultMode] = usePref("editor-mode");
  const [wordWrap] = usePref("word-wrap");
  const resolvedTheme = useResolvedTheme();
  const [mode, setModeState] = useState<EditorMode>(() => (isCurrent ? defaultMode : "preview"));
  const viewRef = useRef<EditorView | null>(null);

  const setMode = (next: EditorMode) => {
    setModeState(next);
    // Switching modes updates the default for the next prompt too.
    setDefaultMode(next);
  };

  const dirty = isCurrent && content !== version.content;
  const isInitialPlaceholder =
    isCurrent &&
    version.branchName === "main" &&
    version.number === 1 &&
    version.parentVersionId === null &&
    version.content.length === 0;

  // Debounced draft autosave (current version only). lastSavedDraft avoids
  // redundant writes; refs keep the unmount flush accurate. When the
  // "autosave drafts" pref is off, drafts are never persisted — edits live
  // only in memory until saved as a new version.
  const contentRef = useRef(content);
  const versionContentRef = useRef(version.content);
  const lastSavedDraftRef = useRef<string | null>(prompt.draftContent ?? null);
  const localEditGenerationRef = useRef(0);
  const authoritativeEditGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const draftClearRequestedRef = useRef(false);
  contentRef.current = content;
  versionContentRef.current = version.content;
  if (liveContentRef) liveContentRef.current = content;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persistDraft = useRef<(
    value: string | null,
    showSavedAt?: boolean,
    editGeneration?: number,
  ) => void>(() => undefined);
  persistDraft.current = (
    draftValue,
    showSavedAt = true,
    editGeneration = localEditGenerationRef.current,
  ) => {
    enqueuePromptDraftWrite(queryClient, prompt.id, {
      value: draftValue,
      persist: () => window.promptBuilder.drafts.set(prompt.id, draftValue),
      onAccepted: () => {
        lastSavedDraftRef.current = draftValue;
        authoritativeEditGenerationRef.current = editGeneration;
        queryClient.setQueryData<PromptDetail>(qk.prompt(prompt.id), (cached) =>
          cached ? { ...cached, draftContent: draftValue } : cached,
        );
        if (mountedRef.current && showSavedAt) setSavedAt(Date.now());
      },
      onRejected: () => {
        toast("Failed to save draft", "error");
      },
    });
  };

  const saveDraft = useRef<() => void>(() => undefined);
  saveDraft.current = () => {
    if (!isCurrent || !getPref("autosave-drafts")) return;
    if (draftClearRequestedRef.current) {
      persistDraft.current(null, false);
      return;
    }
    const value = contentRef.current;
    const draftValue = value === versionContentRef.current ? null : value;
    const hasUnpersistedLocalIntent =
      localEditGenerationRef.current !== authoritativeEditGenerationRef.current;
    if (draftValue === lastSavedDraftRef.current && !hasUnpersistedLocalIntent) return;
    persistDraft.current(draftValue);
  };

  useEffect(() => {
    if (!isCurrent) return;
    const refreshedContent = prompt.draftContent ?? version.content;
    const hasNewerLocalEdit =
      localEditGenerationRef.current !== authoritativeEditGenerationRef.current;
    lastSavedDraftRef.current = prompt.draftContent;
    if (!hasNewerLocalEdit && contentRef.current !== refreshedContent) {
      contentRef.current = refreshedContent;
      setContent(refreshedContent);
    }
  }, [isCurrent, prompt.draftContent, version.content]);

  useEffect(() => {
    if (!isCurrent) return;
    const timer = window.setTimeout(() => saveDraft.current(), 800);
    return () => window.clearTimeout(timer);
  }, [content, isCurrent]);

  // Flush any pending draft when leaving this prompt/version.
  useEffect(() => {
    return () => {
      saveDraft.current();
      if (liveContentRef) liveContentRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createVersion = useAppMutation(
    (input: { changeNote: string; content: string }) =>
      window.promptBuilder.versions.create({
        promptId: prompt.id,
        branchId: version.branchId,
        content: input.content,
        ...(input.changeNote ? { changeNote: input.changeNote } : {}),
      }),
    {
      onSuccess: (created, submitted) => {
        versionContentRef.current = submitted.content;
        if (contentRef.current === submitted.content) {
          // This editor still contains the content that just became a version.
          // Until invalidation replaces it, every timer/unmount flush must keep
          // reinforcing the clear instead of re-queuing that promoted content.
          draftClearRequestedRef.current = true;
          persistDraft.current(null, false);
        } else {
          // Edits made while version creation was in flight belong to the new
          // version as its draft; the submitted snapshot alone was promoted.
          draftClearRequestedRef.current = false;
          persistDraft.current(contentRef.current);
        }
        toast(`Saved as ${created.displayLabel}`);
      },
    },
  );

  const editor = (
    <CodeMirror
      value={content}
      onChange={(value) => {
        draftClearRequestedRef.current = false;
        localEditGenerationRef.current += 1;
        contentRef.current = value;
        setContent(value);
      }}
      onCreateEditor={(view) => {
        viewRef.current = view;
      }}
      extensions={[markdown({ base: markdownLanguage }), ...(wordWrap ? [EditorView.lineWrapping] : [])]}
      theme={resolvedTheme === "dark" ? darkTheme : lightTheme}
      readOnly={!isCurrent}
      editable={isCurrent}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: isCurrent,
        highlightActiveLineGutter: isCurrent,
        foldGutter: false,
        autocompletion: false,
        searchKeymap: true,
      }}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 border-b border-line px-2 py-1">
        {isCurrent && mode !== "preview" &&
          TOOLBAR_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              title={action.label}
              aria-label={action.label}
              onClick={() => {
                if (viewRef.current) action.run(viewRef.current);
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            >
              {action.icon}
            </button>
          ))}
        {isCurrent && mode !== "preview" && (
          <button
            type="button"
            title="Improve with AI"
            aria-label="Improve with AI"
            onClick={() => {
              if (availableModels.length === 0) {
                toast("No AI providers connected — connect one in Settings → AI Providers", "error");
                openSettings("ai");
                return;
              }
              setImproveOpen(true);
            }}
            className="ml-1 flex h-6 items-center gap-1 rounded border border-line px-1.5 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-accent"
          >
            <Sparkles size={12} />
            Improve
          </button>
        )}
        {isCurrent && mode !== "preview" && (
          <span className="ml-2 hidden text-[10px] text-ink-faint @md:inline">
            Markdown · use {"{{variable}}"} for placeholders
          </span>
        )}
        <div className="ml-auto flex shrink-0 rounded-md border border-line p-0.5">
          {MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setMode(option.value)}
              title={`${option.label} mode`}
              className={cx(
                "flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors",
                mode === option.value ? "bg-accent-soft text-accent" : "text-ink-dim hover:text-ink",
              )}
            >
              {option.icon}
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {mode === "edit" && <div className="cm-host min-h-0 flex-1">{editor}</div>}
      {mode === "preview" && (
        <div className="min-h-0 flex-1">
          <MarkdownPreview content={content} />
        </div>
      )}
      {mode === "split" && (
        <div className="flex min-h-0 flex-1">
          <div className="cm-host min-h-0 min-w-0 flex-1">{editor}</div>
          <div className="min-h-0 min-w-0 flex-1 border-l border-line">
            <MarkdownPreview content={content} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line px-3 py-1.5">
        <span className="min-w-0 truncate text-[11px] text-ink-faint">
          {isCurrent
            ? dirty
              ? savedAt
                ? `Draft saved ${clockTime(savedAt)}`
                : "Unsaved changes…"
              : "No unsaved changes"
            : `Viewing ${version.displayLabel} (read-only)`}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
            {wordCount(content)} words · {content.length} chars
          </span>
          {isCurrent && (
            <button
              type="button"
              disabled={!dirty}
              onClick={() => setSaveDialogOpen(true)}
              className={cx(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium text-white transition-colors",
                "bg-accent hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              <Save size={12} />
              {isInitialPlaceholder ? "Save version 1" : "Save as new version"}
            </button>
          )}
        </div>
      </div>

      <SaveVersionDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        nextLabel={
          isInitialPlaceholder
            ? "v1"
            : version.branchName === "main"
              ? `v${version.number + 1}`
              : `${version.branchName} v${version.number + 1}`
        }
        onSave={(note) => createVersion.mutate({ changeNote: note, content: contentRef.current })}
      />
      <ImproveDialog
        open={improveOpen}
        onOpenChange={setImproveOpen}
        content={content}
        onApply={(improved) => {
          draftClearRequestedRef.current = false;
          localEditGenerationRef.current += 1;
          contentRef.current = improved;
          setContent(improved);
          toast("Improved draft applied — save it as a new version to keep it");
        }}
      />
    </div>
  );
});
