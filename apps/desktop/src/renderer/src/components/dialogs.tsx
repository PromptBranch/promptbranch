import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Loader2, Sparkles, X } from "lucide-react";
import type { RatingAddInput, TagDto } from "../../../shared/ipc.js";
import { useAppMutation } from "../hooks/use-data";
import type { ModelRef } from "../lib/ai-prefs";
import { userErrorMessage } from "../lib/errors";
import { cx } from "../lib/time";
import { useToast } from "../lib/toast";
import { useAppState } from "../state/app-state";
import { ModelPicker, useAvailableModels } from "./model-picker";
import { colorForName, StarRatingInput } from "./ui";

export function DialogShell({
  open,
  onOpenChange,
  title,
  children,
  width = "max-w-md",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pb-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          className={cx(
            "pb-dialog fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto",
            "rounded-xl border border-line-strong bg-panel p-5 shadow-2xl shadow-black/50 focus:outline-none",
            width,
          )}
        >
          <div className="mb-4 flex items-center justify-between gap-2">
            <Dialog.Title className="min-w-0 break-words text-sm font-semibold text-ink">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="rounded-md p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <X size={15} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const inputClass =
  "w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";

const primaryButtonClass =
  "rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40";

const ghostButtonClass =
  "rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink";

/** Single-text-input dialog used for "new tag", "new collection", "rename". */
export function NameDialog({
  open,
  onOpenChange,
  title,
  label,
  initialValue = "",
  placeholder,
  submitLabel = "Save",
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onOpenChange(false);
  };

  return (
    <DialogShell open={open} onOpenChange={onOpenChange} title={title}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-dim">{label}</span>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className={inputClass}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostButtonClass} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass} disabled={!value.trim()}>
            {submitLabel}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

/** Destructive/confirming action dialog. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  danger,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        {/* z-60/70: must sit above the compare view (z-40/50) it opens from. */}
        <AlertDialog.Overlay className="pb-overlay fixed inset-0 z-[60] bg-black/60" />
        <AlertDialog.Content className="pb-dialog fixed left-1/2 top-1/2 z-[70] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line-strong bg-panel p-5 shadow-2xl shadow-black/50 focus:outline-none">
          <AlertDialog.Title className="break-words text-sm font-semibold text-ink">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] leading-relaxed text-ink-dim">
            {description}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel className={ghostButtonClass}>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={onConfirm}
              className={cx(
                "rounded-md px-3 py-1.5 text-[13px] font-medium text-white transition-colors",
                danger ? "bg-red-600 hover:bg-red-500" : "bg-accent hover:bg-accent-strong",
              )}
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** "New prompt" creation dialog. */
export function NewPromptDialog({
  open,
  onOpenChange,
  allTags,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allTags: TagDto[];
  onCreate: (input: { title: string; description: string; content: string; tagIds: string[] }) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const { toast } = useToast();
  const { openSettings } = useAppState();
  const availableModels = useAvailableModels();
  const [generateOpen, setGenerateOpen] = useState(false);
  const [genDescription, setGenDescription] = useState("");
  const [genModel, setGenModel] = useState<ModelRef | null>(null);
  const [genPickerOpen, setGenPickerOpen] = useState(false);
  // Generated draft awaiting the overwrite confirmation (non-null = dialog open).
  const [pendingGenerated, setPendingGenerated] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setContent("");
      setTagIds([]);
      setGenerateOpen(false);
      setGenDescription("");
      setGenModel(availableModels[0] ?? null);
      setPendingGenerated(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applyGenerated = (text: string) => {
    setContent(text);
    setGenerateOpen(false);
    toast("Draft generated — review it before creating the prompt");
  };

  const generate = useAppMutation(
    () =>
      window.promptBuilder.ai.assist({
        mode: "generate",
        description: genDescription.trim(),
        providerId: genModel!.providerId,
        modelId: genModel!.modelId,
      }),
    {
      quiet: true,
      onSuccess: (result) => {
        // Overwriting written content asks first — via the styled
        // ConfirmDialog (sits above this dialog: z-60/70 over z-40/50).
        if (content.trim()) {
          setPendingGenerated(result.text);
          return;
        }
        applyGenerated(result.text);
      },
    },
  );

  const openGenerate = () => {
    if (availableModels.length === 0) {
      toast("No AI providers connected — connect one in Settings → AI Providers", "error");
      onOpenChange(false);
      openSettings("ai");
      return;
    }
    setGenerateOpen((current) => !current);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    onCreate({ title: title.trim(), description: description.trim(), content, tagIds });
    onOpenChange(false);
  };

  return (
    <>
    <DialogShell open={open} onOpenChange={onOpenChange} title="New prompt" width="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-dim">Title</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Code review — security focus"
            className={inputClass}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-dim">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this prompt for?"
            className={inputClass}
          />
        </label>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-dim">Initial content (v1)</span>
            <button
              type="button"
              onClick={openGenerate}
              aria-expanded={generateOpen}
              className={cx(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
                generateOpen ? "bg-accent-soft text-accent" : "text-ink-dim hover:bg-hover hover:text-ink",
              )}
            >
              <Sparkles size={11} />
              Generate with AI…
            </button>
          </div>
          {generateOpen && (
            <div className="space-y-2 rounded-md border border-line bg-raised p-2.5">
              <textarea
                value={genDescription}
                onChange={(e) => setGenDescription(e.target.value)}
                placeholder="Describe the prompt you want, e.g. “A code reviewer that flags security issues first, answers in Markdown.”"
                rows={3}
                className={cx(inputClass, "resize-y text-[12px] leading-relaxed")}
              />
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <ModelPicker
                    multi={false}
                    selection={genModel ? [genModel] : []}
                    onChange={(next) => setGenModel(next[0] ?? null)}
                    open={genPickerOpen}
                    onOpenChange={setGenPickerOpen}
                    align="start"
                    fullWidthTrigger
                  />
                </div>
                <button
                  type="button"
                  onClick={() => generate.mutate(undefined)}
                  disabled={!genDescription.trim() || genModel === null || generate.isPending}
                  className={cx(primaryButtonClass, "flex shrink-0 items-center gap-1.5 text-[12px]")}
                >
                  {generate.isPending && <Loader2 size={11} className="animate-spin" />}
                  Generate
                </button>
              </div>
            </div>
          )}
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="You are a senior engineer reviewing code for…"
            rows={7}
            className={cx(inputClass, "resize-y font-mono text-xs leading-relaxed")}
          />
        </div>
        {allTags.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-ink-dim">Tags</span>
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((tag) => {
                const selected = tagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() =>
                      setTagIds((current) =>
                        selected ? current.filter((id) => id !== tag.id) : [...current, tag.id],
                      )
                    }
                    className={cx(
                      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                      selected
                        ? "border-accent/60 bg-accent-soft text-ink"
                        : "border-line bg-raised text-ink-dim hover:text-ink",
                    )}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: tag.color ?? colorForName(tag.name) }}
                    />
                    {tag.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={ghostButtonClass} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass} disabled={!title.trim()}>
            Create prompt
          </button>
        </div>
      </form>
    </DialogShell>
    <ConfirmDialog
      open={pendingGenerated !== null}
      onOpenChange={(next) => {
        if (!next) setPendingGenerated(null);
      }}
      title="Replace existing content?"
      description="You've already written content. Applying the generated draft replaces it."
      confirmLabel="Replace content"
      onConfirm={() => {
        if (pendingGenerated !== null) applyGenerated(pendingGenerated);
        setPendingGenerated(null);
      }}
    />
    </>
  );
}

/** "Save as new version" dialog — emphasizes the change note. */
export function SaveVersionDialog({
  open,
  onOpenChange,
  nextLabel,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nextLabel: string;
  onSave: (changeNote: string) => void;
}) {
  const [note, setNote] = useState("");
  useEffect(() => {
    if (open) setNote("");
  }, [open]);

  return (
    <DialogShell open={open} onOpenChange={onOpenChange} title={`Save as ${nextLabel}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(note.trim());
          onOpenChange(false);
        }}
        className="space-y-4"
      >
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink">
            What changed and why? <span className="font-normal text-ink-faint">(optional, but encouraged)</span>
          </span>
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Tightened the tone rules after a verbose output; added a JSON output example."
            rows={4}
            className={cx(inputClass, "resize-y leading-relaxed")}
          />
          <span className="block text-[11px] leading-relaxed text-ink-faint">
            Change notes become the changelog for this prompt — future-you will thank you.
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostButtonClass} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass}>
            Save version
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

const RATING_DIMENSIONS: Array<{ key: "effectiveness" | "clarity" | "completeness" | "actionability"; label: string }> = [
  { key: "effectiveness", label: "Effectiveness" },
  { key: "clarity", label: "Clarity" },
  { key: "completeness", label: "Completeness" },
  { key: "actionability", label: "Actionability" },
];

export type RatingScores = Partial<
  Pick<RatingAddInput, "effectiveness" | "clarity" | "completeness" | "actionability">
>;

/** Multi-dimension 1–5 rating dialog for a prompt or a version. */
export function RateDialog({
  open,
  onOpenChange,
  title,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "Rate v3" or "Rate prompt". */
  title: string;
  onSubmit: (scores: RatingScores) => void;
}) {
  const [scores, setScores] = useState<Record<string, number | null>>({});
  useEffect(() => {
    if (open) setScores({});
  }, [open]);

  const filled = Object.values(scores).filter((v) => v !== null && v !== undefined).length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (filled === 0) return;
    const payload: RatingScores = {};
    for (const dim of RATING_DIMENSIONS) {
      const value = scores[dim.key];
      if (value !== null && value !== undefined) payload[dim.key] = value;
    }
    onSubmit(payload);
    onOpenChange(false);
  };

  return (
    <DialogShell open={open} onOpenChange={onOpenChange} title={title}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2.5">
          {RATING_DIMENSIONS.map((dim) => (
            <div key={dim.key} className="flex items-center justify-between">
              <span className="text-[13px] text-ink-dim">{dim.label}</span>
              <StarRatingInput
                value={scores[dim.key] ?? null}
                onChange={(value) => setScores((current) => ({ ...current, [dim.key]: value }))}
              />
            </div>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-ink-faint">
          All dimensions are optional, but at least one is required. Ratings are append-only — a new
          rating replaces the previous one for display.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostButtonClass} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass} disabled={filled === 0}>
            Save rating
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

export interface LogRunInput {
  tool: string;
  model?: string;
  outcomeRating?: number;
  resultSummary?: string;
  startedAt?: string;
}

/** "YYYY-MM-DDTHH:mm" for a datetime-local input, in local time. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Manual run-log dialog: tool, model, outcome, summary, started-at. */
export function LogRunDialog({
  open,
  onOpenChange,
  versionLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Label of the version the run is logged against, e.g. "v3". */
  versionLabel: string;
  onSubmit: (input: LogRunInput) => void;
}) {
  const [tool, setTool] = useState("manual");
  const [model, setModel] = useState("");
  const [outcome, setOutcome] = useState<number | null>(null);
  const [summary, setSummary] = useState("");
  const [startedAt, setStartedAt] = useState(() => toLocalInputValue(new Date()));

  useEffect(() => {
    if (open) {
      setTool("manual");
      setModel("");
      setOutcome(null);
      setSummary("");
      setStartedAt(toLocalInputValue(new Date()));
    }
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedTool = tool.trim() || "manual";
    const parsedDate = new Date(startedAt);
    onSubmit({
      tool: trimmedTool,
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(outcome !== null ? { outcomeRating: outcome } : {}),
      ...(summary.trim() ? { resultSummary: summary.trim() } : {}),
      ...(Number.isNaN(parsedDate.getTime()) ? {} : { startedAt: parsedDate.toISOString() }),
    });
    onOpenChange(false);
  };

  return (
    <DialogShell open={open} onOpenChange={onOpenChange} title={`Log a run · ${versionLabel}`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-ink-dim">Tool</span>
            <input
              autoFocus
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              placeholder="kimi-cli"
              className={inputClass}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-ink-dim">
              Model <span className="font-normal text-ink-faint">(optional)</span>
            </span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. kimi-k2"
              className={inputClass}
            />
          </label>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-ink-dim">
            Outcome <span className="font-normal text-ink-faint">(optional)</span>
          </span>
          <StarRatingInput value={outcome} onChange={setOutcome} size={18} />
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-dim">
            Result summary <span className="font-normal text-ink-faint">(optional)</span>
          </span>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="What did you use it for, and how did it go?"
            rows={3}
            className={cx(inputClass, "resize-y leading-relaxed")}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-dim">Started at</span>
          <input
            type="datetime-local"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            className={inputClass}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostButtonClass} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass}>
            Log run
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

/** "Duplicate as variation" dialog: names a new branch from a source version. */
export function DuplicateBranchDialog({
  open,
  onOpenChange,
  sourceLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display label of the version being duplicated, e.g. "v3". */
  sourceLabel: string;
  /** Rejects with an Error whose message is shown inline (e.g. duplicate name). */
  onSubmit: (name: string, description: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setError(null);
    setBusy(true);
    try {
      await onSubmit(trimmed, description.trim());
      onOpenChange(false);
    } catch (err) {
      setError(userErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell open={open} onOpenChange={onOpenChange} title={`Duplicate ${sourceLabel} as variation`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-[12px] leading-relaxed text-ink-dim">
          Creates a new branch whose first version copies {sourceLabel}'s content. You can then
          evolve it independently of main.
        </p>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-dim">Variation name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. concise, for-sonnet"
            className={inputClass}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-dim">
            Description <span className="font-normal text-ink-faint">(optional)</span>
          </span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Why this variation exists"
            className={inputClass}
          />
        </label>
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostButtonClass} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass} disabled={!name.trim() || busy}>
            Create variation
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
