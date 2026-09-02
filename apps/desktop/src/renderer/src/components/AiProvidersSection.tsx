import { useEffect, useMemo, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  FlaskConical,
  Loader2,
  MoreHorizontal,
  SlidersHorizontal,
  Sparkles,
  Zap,
} from "lucide-react";
import type { AiProviderDto } from "../../../shared/ipc.js";
import { qk, useAiCatalog, useAiProviders, useAppMutation } from "../hooks/use-data";
import { chatModelTier } from "../lib/chat-models";
import { cx } from "../lib/time";
import { useAppState } from "../state/app-state";
import { ConnectProviderDialog } from "./ConnectProviderDialog";
import { ConfirmDialog } from "./dialogs";
import { ProviderTile } from "./ui";

const inputClass =
  "w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";

const ghostButtonClass =
  "rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

const primaryButtonClass =
  "rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40";

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <span className="text-[12px] font-medium text-ink-dim">{children}</span>
      {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p>}
    </div>
  );
}

// ----------------------------------------------------------- connection test

type TestState = {
  status: "idle" | "running" | "ok" | "error";
  error?: string;
  hint?: string;
  /** Replacement model named by the provider, for one-click recovery. */
  suggestedModel?: string;
};

function StatusDot({ state }: { state: TestState }) {
  if (state.status === "running") return <Loader2 size={11} className="shrink-0 animate-spin text-ink-faint" />;
  return (
    <span
      title={
        state.status === "ok"
          ? "Connection OK"
          : state.status === "error"
            ? (state.error ?? "Connection test failed")
            : "Not tested yet"
      }
      className={cx(
        "h-2 w-2 shrink-0 rounded-full",
        state.status === "ok" ? "bg-success" : state.status === "error" ? "bg-danger" : "bg-line-strong",
      )}
    />
  );
}

// ------------------------------------------------------------ provider rows

function RenameDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: AiProviderDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(provider.name);
  useEffect(() => {
    if (open) setName(provider.name);
  }, [open, provider.name]);
  const rename = useAppMutation(
    () => window.promptBuilder.ai.providers.update({ id: provider.id, patch: { name: name.trim() } }),
    { toast: "Provider renamed", onSuccess: () => onOpenChange(false) },
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pb-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="pb-dialog fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line-strong bg-panel p-5 shadow-2xl shadow-black/50 focus:outline-none"
        >
          <Dialog.Title className="mb-4 text-sm font-semibold text-ink">Rename {provider.name}</Dialog.Title>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) rename.mutate(undefined);
            }}
            className="space-y-4"
          >
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            <div className="flex justify-end gap-2">
              <button type="button" className={ghostButtonClass} onClick={() => onOpenChange(false)}>
                Cancel
              </button>
              <button type="submit" className={primaryButtonClass} disabled={!name.trim() || rename.isPending}>
                Rename
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Model chooser for the connection test. No automatic selection: declared
 * models (the user's own choice, so they may preselect) come first, then
 * catalog models chat-capable-first. Custom endpoints without either get a
 * manual model-id input.
 */
function TestModelDialog({
  provider,
  open,
  onOpenChange,
  onRun,
}: {
  provider: AiProviderDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: (modelId: string) => void;
}) {
  const { data: catalog } = useAiCatalog();
  const options = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    // Declared models first — preselecting one is the user's own prior
    // choice, not a guess. The remembered test model joins the list even
    // when the catalog doesn't include it (manual entries, stale caches).
    for (const id of [
      ...provider.models.filter((m) => m.enabled).map((m) => m.modelId),
      ...(provider.testModel ? [provider.testModel] : []),
    ]) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    const catalogIds = [...(catalog?.models[provider.type] ?? [])]
      .map((model) => ({
        id: model.id,
        tier: chatModelTier(model),
        cost: model.costInput ?? Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => a.tier - b.tier || a.cost - b.cost || a.id.localeCompare(b.id))
      .map((entry) => entry.id);
    for (const id of catalogIds) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }, [provider.models, provider.type, catalog]);

  const declaredFirst = provider.models.find((m) => m.enabled)?.modelId ?? "";
  const [selected, setSelected] = useState(provider.testModel ?? declaredFirst);
  const [manualId, setManualId] = useState("");
  useEffect(() => {
    if (open) {
      setSelected(provider.testModel ?? provider.models.find((m) => m.enabled)?.modelId ?? "");
      setManualId("");
    }
  }, [open, provider.testModel, provider.models]);

  const chosen = options.length > 0 ? selected : manualId.trim();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pb-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="pb-dialog fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line-strong bg-panel p-5 shadow-2xl shadow-black/50 focus:outline-none"
        >
          <Dialog.Title className="mb-1 text-sm font-semibold text-ink">
            Test {provider.name}
          </Dialog.Title>
          <p className="mb-4 text-[11px] leading-relaxed text-ink-faint">
            The connection check runs on one model — pick it. Models that can hold a conversation
            are listed first.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (chosen) {
                onRun(chosen);
                onOpenChange(false);
              }
            }}
            className="space-y-4"
          >
            {options.length > 0 ? (
              <select
                aria-label="Test model"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className={inputClass}
              >
                <option value="">Select a model…</option>
                {options.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                autoFocus
                aria-label="Test model"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                placeholder="Model id, e.g. llama3.1:8b"
                className={cx(inputClass, "font-mono text-xs")}
              />
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={ghostButtonClass} onClick={() => onOpenChange(false)}>
                Cancel
              </button>
              <button type="submit" className={primaryButtonClass} disabled={!chosen}>
                Run test
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Compact provider row: tile, name, availability count, status, overflow menu. */
function ProviderRow({ provider }: { provider: AiProviderDto }) {
  const { data: catalog } = useAiCatalog();
  const [renameOpen, setRenameOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testPickerOpen, setTestPickerOpen] = useState(false);
  const [testState, setTestState] = useState<TestState>({ status: "idle" });

  const remove = useAppMutation(() => window.promptBuilder.ai.providers.delete(provider.id), {
    toast: "Provider disconnected",
  });
  const test = useAppMutation(
    (modelId: string) => {
      setTestState({ status: "running" });
      return window.promptBuilder.ai.providers.test(provider.id, modelId);
    },
    {
      quiet: true,
      // The tested model is persisted server-side — the row must refetch so
      // later Re-test clicks see provider.testModel and run directly
      // instead of reopening the chooser.
      invalidateKeys: [qk.aiProviders],
      onSuccess: (result) =>
        setTestState(
          result.ok
            ? { status: "ok" }
            : {
                status: "error",
                ...(result.error ? { error: result.error } : {}),
                ...(result.hint ? { hint: result.hint } : {}),
                ...(result.suggestedModel ? { suggestedModel: result.suggestedModel } : {}),
              },
        ),
    },
  );

  const hiddenCount = provider.models.filter((m) => !m.enabled).length;
  const declaredCount = provider.models.filter((m) => m.enabled).length;
  const availability =
    provider.type === "openai-compatible"
      ? `${declaredCount} model${declaredCount === 1 ? "" : "s"} declared`
      : catalog
        ? `${(catalog.models[provider.type]?.length ?? 0) - hiddenCount} models available`
        : "catalog not fetched yet";

  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <ProviderTile label={provider.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{provider.name}</p>
          <p className="truncate text-[10px] text-ink-faint">
            {availability}
            {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
            {!provider.enabled ? " · disabled" : ""}
          </p>
        </div>
        <StatusDot state={testState} />
        {testState.status === "ok" && <span className="shrink-0 text-[11px] text-success">Connected</span>}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`Actions for ${provider.name}`}
              className="shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="pb-menu z-50 w-44 rounded-lg border border-line-strong bg-raised p-1 shadow-xl shadow-black/40"
            >
              <DropdownMenu.Item
                onSelect={() => setRenameOpen(true)}
                className="cursor-pointer rounded-md px-2 py-1.5 text-[12px] text-ink-dim outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
              >
                Rename…
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => {
                  // The remembered choice (or a declared model) is already
                  // the user's pick — test directly, no re-choosing. The
                  // picker only opens when nothing has been chosen yet.
                  const modelId = provider.testModel ?? provider.models.find((m) => m.enabled)?.modelId;
                  if (modelId) test.mutate(modelId);
                  else setTestPickerOpen(true);
                }}
                disabled={testState.status === "running"}
                className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-ink-dim outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
              >
                <FlaskConical size={11} />
                Re-test connection…
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => setTestPickerOpen(true)}
                className="cursor-pointer rounded-md px-2 py-1.5 text-[12px] text-ink-dim outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
              >
                Choose test model…
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item
                onSelect={() => setConfirmDelete(true)}
                className="cursor-pointer rounded-md px-2 py-1.5 text-[12px] text-danger outline-none data-[highlighted]:bg-danger-soft"
              >
                Disconnect…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {testState.status === "error" && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-danger/20 bg-danger-soft px-3 py-1.5">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] leading-relaxed text-danger">
              {testState.error ?? "Connection test failed"}
            </p>
            {testState.hint && (
              <p className="mt-0.5 text-[10px] leading-relaxed text-ink-dim">{testState.hint}</p>
            )}
          </div>
          {testState.suggestedModel && (
            <button
              type="button"
              onClick={() => test.mutate(testState.suggestedModel!)}
              className="shrink-0 rounded-md border border-line bg-panel px-2.5 py-1 text-[11px] font-medium text-ink transition-colors hover:bg-raised"
            >
              Switch to {testState.suggestedModel} and re-test
            </button>
          )}
        </div>
      )}
      <RenameDialog provider={provider} open={renameOpen} onOpenChange={setRenameOpen} />
      <TestModelDialog
        provider={provider}
        open={testPickerOpen}
        onOpenChange={setTestPickerOpen}
        onRun={(modelId) => test.mutate(modelId)}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Disconnect ${provider.name}?`}
        description="The stored API key and model preferences are removed. Run history recorded with this provider is kept."
        confirmLabel="Disconnect"
        danger
        onConfirm={() => remove.mutate(undefined)}
      />
    </div>
  );
}

// ----------------------------------------------------------------- section

export function AiProvidersSection() {
  const { data: providers } = useAiProviders();
  const { setManageModelsOpen } = useAppState();
  const [connectOpen, setConnectOpen] = useState(false);

  return (
    <div className="space-y-4">
      <FieldLabel hint="Connect a provider once and all of its catalog models are instantly available — pick them from the model picker next to Run. API keys are stored encrypted with your OS keychain.">
        Connected providers
      </FieldLabel>
      {(providers ?? []).length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong px-4 py-6 text-center">
          <Sparkles size={16} className="text-ink-faint" />
          <p className="text-[12px] text-ink-dim">Connect a provider to run prompts against real models.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(providers ?? []).map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setConnectOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
        >
          <Zap size={12} />
          Connect a provider…
        </button>
        {(providers ?? []).length > 0 && (
          <button
            type="button"
            onClick={() => setManageModelsOpen(true)}
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
          >
            <SlidersHorizontal size={12} />
            Manage models
          </button>
        )}
      </div>
      <ConnectProviderDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}
