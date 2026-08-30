import { Clock, FileText } from "lucide-react";
import { useActivity } from "../hooks/use-data";
import { relativeTime } from "../lib/time";
import { useAppState } from "../state/app-state";
import { EmptyState, Spinner } from "./ui";

/** Global activity feed: recent versions created across all prompts. */
export function HistoryView() {
  const { data: activity, isLoading } = useActivity();
  const { selectPrompt, setView } = useAppState();

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="border-b border-line px-5 py-3.5">
        <h1 className="text-[14px] font-semibold text-ink">History</h1>
        <p className="mt-0.5 text-[11px] text-ink-faint">Recent versions across your whole library</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {isLoading && <Spinner />}
        {!isLoading && (activity ?? []).length === 0 && (
          <EmptyState
            icon={<Clock size={16} />}
            title="No activity yet"
            hint="New versions across all prompts will show up here."
          />
        )}
        <div className="space-y-1.5">
          {(activity ?? []).map((item) => (
            <button
              key={item.versionId}
              type="button"
              onClick={() => {
                setView({ kind: "library" });
                selectPrompt(item.promptId);
              }}
              className="flex w-full items-start gap-3 rounded-lg border border-line bg-panel p-3 text-left transition-colors hover:border-line-strong hover:bg-raised"
            >
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                <FileText size={13} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[13px] font-semibold text-ink">
                    {item.promptTitle}
                    <span className="ml-2 text-[11px] font-medium text-accent">{item.displayLabel}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-faint">{relativeTime(item.createdAt)}</span>
                </div>
                <p className="mt-0.5 truncate text-[12px] text-ink-dim">
                  {item.changeNote ?? <span className="italic text-ink-faint">No change note</span>}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
