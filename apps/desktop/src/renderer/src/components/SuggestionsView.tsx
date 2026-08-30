import { useState } from "react";
import { Bot, Check, Columns2, Inbox, X } from "lucide-react";
import type { SuggestionDto, VersionDto } from "../../../shared/ipc.js";
import { useAppMutation, useSuggestions, useVersionContent } from "../hooks/use-data";
import { relativeTime } from "../lib/time";
import { useAppState } from "../state/app-state";
import { CompareDialog } from "./CompareDialog";
import { ConfirmDialog } from "./dialogs";
import { EmptyState, Spinner } from "./ui";

/** Wraps CompareDialog, fetching the base version the suggestion was made from. */
function SuggestionDiff({
  suggestion,
  onOpenChange,
}: {
  suggestion: SuggestionDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const baseQuery = useVersionContent(suggestion?.baseVersionId ?? null);

  if (!suggestion) return null;
  const suggested: VersionDto = {
    id: suggestion.versionId,
    promptId: suggestion.promptId,
    branchId: "",
    branchName: suggestion.branchName,
    parentVersionId: suggestion.baseVersionId,
    number: 1,
    label: null,
    displayLabel: suggestion.displayLabel,
    changeNote: suggestion.rationale,
    author: suggestion.author,
    createdAt: suggestion.createdAt,
    isCurrent: false,
  };
  return (
    <CompareDialog
      base={baseQuery.data ?? null}
      other={suggested}
      open={baseQuery.data !== undefined}
      onOpenChange={onOpenChange}
    />
  );
}

/** Review queue for agent-suggested variations: agents propose, humans approve. */
export function SuggestionsView() {
  const { data: suggestions, isLoading } = useSuggestions();
  const { selectPrompt, setView } = useAppState();
  const [diffTarget, setDiffTarget] = useState<SuggestionDto | null>(null);
  const [rejectTarget, setRejectTarget] = useState<SuggestionDto | null>(null);
  const [setAsCurrent, setSetAsCurrent] = useState(true);

  const approve = useAppMutation(
    (versionId: string) => window.promptBuilder.suggestions.approve(versionId, setAsCurrent),
    { toast: () => (setAsCurrent ? "Suggestion approved and set as current" : "Suggestion approved") },
  );
  const reject = useAppMutation((versionId: string) => window.promptBuilder.suggestions.reject(versionId), {
    toast: "Suggestion rejected",
  });

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="flex items-end justify-between border-b border-line px-5 py-3.5">
        <div>
          <h1 className="text-[14px] font-semibold text-ink">Suggestions</h1>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            Variations proposed by agents — nothing becomes active until you approve it
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-dim">
          <input
            type="checkbox"
            checked={setAsCurrent}
            onChange={(e) => setSetAsCurrent(e.target.checked)}
            className="accent-accent"
          />
          Set as current on approve
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {isLoading && <Spinner />}
        {!isLoading && (suggestions ?? []).length === 0 && (
          <EmptyState
            icon={<Inbox size={16} />}
            title="No pending suggestions"
            hint="When an agent proposes a variation via the CLI or MCP server, it shows up here for review."
          />
        )}
        <div className="space-y-2">
          {(suggestions ?? []).map((s) => (
            <div
              key={s.versionId}
              className="rounded-lg border border-line bg-panel p-3 transition-colors hover:border-line-strong"
            >
              <div className="flex items-baseline justify-between gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setView({ kind: "library" });
                    selectPrompt(s.promptId);
                  }}
                  className="min-w-0 truncate text-left text-[13px] font-semibold text-ink hover:text-accent"
                >
                  {s.promptTitle}
                  <span className="ml-2 text-[11px] font-medium text-accent">{s.displayLabel}</span>
                </button>
                <span className="shrink-0 text-[11px] text-ink-faint">{relativeTime(s.createdAt)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-faint">
                <span className="flex items-center gap-1 rounded-full border border-line px-1.5 py-px">
                  <Bot size={10} />
                  {s.source}
                </span>
                <span className="truncate">branch: {s.branchName}</span>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-dim">
                {s.rationale ?? <span className="italic text-ink-faint">No rationale given</span>}
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDiffTarget(s)}
                  className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                >
                  <Columns2 size={11} />
                  View diff
                </button>
                <button
                  type="button"
                  onClick={() => approve.mutate(s.versionId)}
                  disabled={approve.isPending}
                  className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent-strong disabled:opacity-50"
                >
                  <Check size={11} />
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => setRejectTarget(s)}
                  className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-danger transition-colors hover:bg-danger-soft"
                >
                  <X size={11} />
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <SuggestionDiff suggestion={diffTarget} onOpenChange={(open) => !open && setDiffTarget(null)} />
      <ConfirmDialog
        open={rejectTarget !== null}
        onOpenChange={(open) => !open && setRejectTarget(null)}
        title="Reject suggestion?"
        description={`The suggested variation on "${rejectTarget?.promptTitle ?? ""}" (branch ${rejectTarget?.branchName ?? ""}) is marked rejected and stays out of the library. This cannot be undone.`}
        confirmLabel="Reject"
        danger
        onConfirm={() => {
          if (rejectTarget) reject.mutate(rejectTarget.versionId);
          setRejectTarget(null);
        }}
      />
    </div>
  );
}
