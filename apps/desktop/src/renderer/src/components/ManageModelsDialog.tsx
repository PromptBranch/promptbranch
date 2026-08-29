/**
 * "Manage models" dialog (OpenCode-style): one group per connected provider,
 * each with a master toggle (providers.enabled — a disabled provider's models
 * vanish from the picker) and per-model toggle switches mapping to the
 * hidden-model mechanism (provider_models enabled=0). Custom OpenAI-compatible
 * providers manage their declared models here (toggles + inline add field).
 */
import { useMemo, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import type { AiProviderDto } from "../../../shared/ipc.js";
import { qk, useAiCatalog, useAiProviders, useAppMutation } from "../hooks/use-data";
import { cx } from "../lib/time";
import { ConnectProviderDialog } from "./ConnectProviderDialog";
import { formatContext, formatPricing } from "./model-picker";
import { ProviderTile, ToggleSwitch } from "./ui";

const inputClass =
  "w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";

interface ModelRow {
  modelId: string;
  displayName: string | null;
  visible: boolean;
  hint: string | null;
}

function matches(model: ModelRow, providerName: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    model.modelId.toLowerCase().includes(q) ||
    (model.displayName ?? "").toLowerCase().includes(q) ||
    providerName.toLowerCase().includes(q)
  );
}

/** Declared-models editor for custom openai-compatible providers. */
function DeclaredModelsEditor({ provider }: { provider: AiProviderDto }) {
  const [value, setValue] = useState("");
  const setModels = useAppMutation(
    (models: Array<{ modelId: string; displayName?: string; enabled?: boolean }>) =>
      window.promptBuilder.ai.providers.setModels({ providerId: provider.id, models }),
    { quiet: true, invalidateKeys: [qk.aiProviders] },
  );

  const toInputs = (models: AiProviderDto["models"]) =>
    models.map((m) => ({
      modelId: m.modelId,
      ...(m.displayName !== null ? { displayName: m.displayName } : {}),
      enabled: m.enabled,
    }));

  const add = (event: FormEvent) => {
    event.preventDefault();
    const modelId = value.trim();
    if (!modelId || provider.models.some((m) => m.modelId === modelId)) return;
    setModels.mutate([...toInputs(provider.models), { modelId, enabled: true }]);
    setValue("");
  };

  return (
    <form onSubmit={add} className="flex gap-1.5 px-2 py-1.5">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Add a model id, e.g. llama3.1:8b"
        className={cx(inputClass, "py-1 text-[12px]")}
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
      >
        Add
      </button>
    </form>
  );
}

function ProviderGroup({ provider, query }: { provider: AiProviderDto; query: string }) {
  const { data: catalog } = useAiCatalog();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  // Toggles update the providers cache immediately (rolled back on error) and
  // only invalidate the providers query — not every query in the app.
  const setEnabled = useAppMutation(
    (enabled: boolean) => window.promptBuilder.ai.providers.update({ id: provider.id, patch: { enabled } }),
    {
      quiet: true,
      invalidateKeys: [qk.aiProviders],
      optimistic: {
        queryKey: qk.aiProviders,
        update: (enabled, previous) =>
          ((previous as AiProviderDto[] | undefined) ?? []).map((p) =>
            p.id === provider.id ? { ...p, enabled } : p,
          ),
      },
    },
  );
  const setHidden = useAppMutation(
    (input: { modelId: string; hidden: boolean }) =>
      window.promptBuilder.ai.providers.setModelHidden({ providerId: provider.id, ...input }),
    {
      quiet: true,
      invalidateKeys: [qk.aiProviders],
      optimistic: {
        queryKey: qk.aiProviders,
        // Mirrors the main-process semantics: an unknown model gets a row.
        update: (input, previous) =>
          ((previous as AiProviderDto[] | undefined) ?? []).map((p) => {
            if (p.id !== provider.id) return p;
            const models = p.models.some((m) => m.modelId === input.modelId)
              ? p.models.map((m) => (m.modelId === input.modelId ? { ...m, enabled: !input.hidden } : m))
              : [...p.models, { modelId: input.modelId, displayName: null, enabled: !input.hidden }];
            return { ...p, models };
          }),
      },
    },
  );
  const setModels = useAppMutation(
    (models: Array<{ modelId: string; displayName?: string; enabled?: boolean }>) =>
      window.promptBuilder.ai.providers.setModels({ providerId: provider.id, models }),
    { quiet: true, invalidateKeys: [qk.aiProviders] },
  );

  const isCustom = provider.type === "openai-compatible";
  const rows: ModelRow[] = useMemo(() => {
    if (isCustom) {
      return provider.models.map((m) => ({
        modelId: m.modelId,
        displayName: m.displayName,
        visible: m.enabled,
        hint: null,
      }));
    }
    const hidden = new Set(provider.models.filter((m) => !m.enabled).map((m) => m.modelId));
    return (catalog?.models[provider.type] ?? []).map((m) => ({
      modelId: m.id,
      displayName: m.name,
      visible: !hidden.has(m.id),
      hint: [formatContext(m.contextWindow), formatPricing(m)].filter(Boolean).join(" · ") || null,
    }));
  }, [isCustom, provider, catalog]);

  const visible = rows.filter((row) => matches(row, provider.name, query));

  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2.5 border-b border-line px-3 py-2">
        <ProviderTile label={provider.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium text-ink">{provider.name}</p>
          <p className="truncate text-[10px] text-ink-faint">
            {isCustom ? `${rows.length} declared model${rows.length === 1 ? "" : "s"}` : `${rows.length} catalog models`}
            {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
          </p>
        </div>
        <ToggleSwitch
          checked={provider.enabled}
          onChange={(enabled) => setEnabled.mutate(enabled)}
          label={`${provider.enabled ? "Disable" : "Enable"} ${provider.name}`}
          disabled={setEnabled.isPending}
        />
      </div>
      <div className={cx("p-1", !provider.enabled && "pointer-events-none opacity-45")}>
        {!isCustom && catalog === null ? (
          <div className="flex items-center justify-between gap-2 px-2 py-2">
            <p className="text-[11px] text-ink-faint">Model catalog not fetched yet — refresh to list models.</p>
            <button
              type="button"
              onClick={() => {
                setRefreshing(true);
                void window.promptBuilder.ai.catalog
                  .refresh()
                  .then(() => queryClient.invalidateQueries())
                  .finally(() => setRefreshing(false));
              }}
              className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            >
              {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              Refresh
            </button>
          </div>
        ) : visible.length === 0 && !isCustom ? (
          <p className="px-2 py-2 text-[11px] text-ink-faint">No models match “{query}”.</p>
        ) : (
          visible.map((row) => (
            <div key={row.modelId} className="flex items-center gap-2 rounded-md px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-dim">
                {row.displayName ?? row.modelId}
                {row.displayName && row.displayName !== row.modelId && (
                  <span className="ml-1.5 font-mono text-[10px] text-ink-faint">{row.modelId}</span>
                )}
              </span>
              {row.hint && <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">{row.hint}</span>}
              {isCustom && (
                <button
                  type="button"
                  aria-label={`Remove ${row.modelId}`}
                  onClick={() =>
                    setModels.mutate(
                      provider.models
                        .filter((m) => m.modelId !== row.modelId)
                        .map((m) => ({
                          modelId: m.modelId,
                          ...(m.displayName !== null ? { displayName: m.displayName } : {}),
                          enabled: m.enabled,
                        })),
                    )
                  }
                  className="shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:text-danger"
                >
                  <X size={11} />
                </button>
              )}
              <ToggleSwitch
                checked={row.visible}
                onChange={(visibleNow) => setHidden.mutate({ modelId: row.modelId, hidden: !visibleNow })}
                label={`${row.visible ? "Hide" : "Show"} ${row.modelId}`}
                disabled={setHidden.isPending}
              />
            </div>
          ))
        )}
        {isCustom && <DeclaredModelsEditor provider={provider} />}
      </div>
    </div>
  );
}

export function ManageModelsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: providers } = useAiProviders();
  const { data: catalog } = useAiCatalog();
  const [query, setQuery] = useState("");
  const [connectOpen, setConnectOpen] = useState(false);

  const list = providers ?? [];
  const filtered = list; // groups self-filter their rows by `query`

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="pb-overlay fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content
            aria-describedby={undefined}
            className="pb-dialog fixed left-1/2 top-1/2 z-50 flex h-[min(560px,calc(100vh-2rem))] w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/50 focus:outline-none"
          >
            <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
              <div>
                <Dialog.Title className="text-sm font-semibold text-ink">Manage models</Dialog.Title>
                <p className="mt-0.5 text-[11px] text-ink-faint">
                  Customize which models appear in the model selector
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setConnectOpen(true)}
                  className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong"
                >
                  <Plus size={12} />
                  Connect provider
                </button>
                <Dialog.Close
                  aria-label="Close"
                  className="rounded-md p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                >
                  <X size={15} />
                </Dialog.Close>
              </div>
            </div>
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <Search size={12} className="shrink-0 text-ink-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models"
                aria-label="Search models"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-ink placeholder:text-ink-faint focus:outline-none"
              />
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {list.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
                  <p className="text-[12px] text-ink-dim">Connect a provider to see its models here.</p>
                  <button
                    type="button"
                    onClick={() => setConnectOpen(true)}
                    className="mt-1 flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong"
                  >
                    <Plus size={12} />
                    Connect provider
                  </button>
                </div>
              ) : (
                filtered.map((provider) => <ProviderGroup key={provider.id} provider={provider} query={query} />)
              )}
              {list.length > 0 && catalog === null && (
                <p className="px-1 pt-1 text-center text-[10px] text-ink-faint">
                  The model catalog has not been fetched yet — catalog-backed providers will list models after a
                  refresh.
                </p>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <ConnectProviderDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </>
  );
}
