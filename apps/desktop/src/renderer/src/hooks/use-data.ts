import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { syncStatusDtoSchema, type PromptListQuery, type SyncStatusDto } from "../../../shared/ipc.js";
import { userErrorMessage } from "../lib/errors";
import { useAppState } from "../state/app-state";
import { useToast } from "../lib/toast";

export const api = () => window.promptBuilder;

/** Query keys. Lists/content are invalidated wholesale after any mutation. */
export const qk = {
  prompts: (query: PromptListQuery) => ["prompts", query] as const,
  prompt: (id: string) => ["prompt", id] as const,
  versions: (promptId: string) => ["versions", promptId] as const,
  versionContent: (versionId: string) => ["version", versionId] as const,
  notes: (promptId: string) => ["notes", promptId] as const,
  tags: ["tags"] as const,
  collections: ["collections"] as const,
  stats: ["stats"] as const,
  activity: ["activity"] as const,
  ratings: (targetId: string) => ["ratings", targetId] as const,
  latestRating: (targetId: string) => ["latest-rating", targetId] as const,
  versionRatings: (promptId: string) => ["version-ratings", promptId] as const,
  runs: (promptId: string) => ["runs", promptId] as const,
  runGroups: (promptId: string) => ["run-groups", promptId] as const,
  aiProviders: ["ai-providers"] as const,
  aiProviderTypes: ["ai-provider-types"] as const,
  aiCatalog: ["ai-catalog"] as const,
  aiEnvDetect: ["ai-env-detect"] as const,
  suggestions: ["suggestions"] as const,
  appInfo: ["app-info"] as const,
  licenses: ["licenses"] as const,
  shares: ["shares"] as const,
  portalBaseUrl: ["portal-base-url"] as const,
  syncStatus: ["sync-status"] as const,
};

export function usePromptList() {
  const { view, sort, filters } = useAppState();
  const query: PromptListQuery = { sort };
  if (view.kind === "trash") {
    query.deletedOnly = true;
  } else {
    if (view.kind === "starred") query.starred = true;
    if (view.kind === "collection" && view.collectionId) query.collectionId = view.collectionId;
    if (view.kind === "library") {
      if (filters.tagIds.length > 0) query.tagIds = filters.tagIds;
      if (filters.starredOnly) query.starred = true;
      if (filters.minRating !== undefined) query.minRating = filters.minRating;
    }
  }
  return useQuery({
    queryKey: qk.prompts(query),
    queryFn: () => api().prompts.list(query),
  });
}

export function usePromptDetail(promptId: string | null) {
  return useQuery({
    queryKey: qk.prompt(promptId ?? "none"),
    queryFn: () => api().prompts.get(promptId!),
    enabled: promptId !== null,
  });
}

export function useVersions(promptId: string | null) {
  return useQuery({
    queryKey: qk.versions(promptId ?? "none"),
    queryFn: () => api().versions.list(promptId!),
    enabled: promptId !== null,
  });
}

export function useVersionContent(versionId: string | null) {
  return useQuery({
    queryKey: qk.versionContent(versionId ?? "none"),
    queryFn: () => api().versions.get(versionId!),
    enabled: versionId !== null,
  });
}

export function useNotes(promptId: string | null) {
  return useQuery({
    queryKey: qk.notes(promptId ?? "none"),
    queryFn: () => api().notes.list(promptId!),
    enabled: promptId !== null,
    // Agents can write notes via CLI/MCP while the app is open; refresh on focus.
    refetchOnWindowFocus: true,
  });
}

export function useTags() {
  return useQuery({ queryKey: qk.tags, queryFn: () => api().tags.list() });
}

export function useCollections() {
  return useQuery({ queryKey: qk.collections, queryFn: () => api().collections.list() });
}

export function useStats() {
  return useQuery({ queryKey: qk.stats, queryFn: () => api().library.stats() });
}

export function useAppInfo() {
  return useQuery({ queryKey: qk.appInfo, queryFn: () => api().app.info(), staleTime: Infinity });
}

/** Bundled third-party notices markdown (THIRD_PARTY_NOTICES.md, via main). */
export function useLicensesText(enabled = true) {
  return useQuery({
    queryKey: qk.licenses,
    queryFn: () => api().app.licensesText(),
    staleTime: Infinity,
    enabled,
  });
}

/** This library's published snapshots (revoked included, greyed in the UI). */
export function useShares() {
  return useQuery({
    queryKey: qk.shares,
    queryFn: () => api().share.list(),
    refetchOnWindowFocus: true,
  });
}

/** Effective portal base URL (official instance unless overridden). */
export function usePortalBaseUrl() {
  return useQuery({ queryKey: qk.portalBaseUrl, queryFn: () => api().share.getPortalBaseUrl() });
}

/**
 * Sync status, kept fresh by main's throttled push events. Background
 * applies update the library, so a changed lastSyncedAt invalidates
 * everything — the same refetch-on-external-writer pattern as CLI/MCP.
 * A peer crossing into unhealthy toasts once per episode; recovery is silent.
 */
export function useSyncStatus() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const toastRef = useRef(toast);
  const unhealthyNames = useRef(new Map<string, string>());
  const query = useQuery({
    queryKey: qk.syncStatus,
    queryFn: () => api().sync.getStatus(),
  });
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);
  useEffect(() => {
    let lastSyncedAt = queryClient.getQueryData<SyncStatusDto>(qk.syncStatus)?.lastSyncedAt ?? null;
    const unsubscribe = api().sync.onStateChanged((raw: SyncStatusDto) => {
      // Push payloads are validated here, like ai:run-progress events.
      const parsed = syncStatusDtoSchema.safeParse(raw);
      if (!parsed.success) return;
      const status = parsed.data;
      queryClient.setQueryData(qk.syncStatus, status);
      if (status.lastSyncedAt !== lastSyncedAt) {
        lastSyncedAt = status.lastSyncedAt;
        void queryClient.invalidateQueries();
      }
      for (const peer of status.peers) {
        const was = unhealthyNames.current.has(peer.fingerprint);
        if (peer.unhealthy && !was) {
          toastRef.current(`Sync with ${peer.name} keeps failing`, "error");
        }
        // Recovery ends the episode so a later failure toasts again.
        if (peer.unhealthy) unhealthyNames.current.set(peer.fingerprint, peer.name);
        else unhealthyNames.current.delete(peer.fingerprint);
      }
      // Forget entries for peers no longer paired so re-pairing starts clean.
      const known = new Set(status.peers.map((p) => p.fingerprint));
      for (const fingerprint of [...unhealthyNames.current.keys()]) {
        if (!known.has(fingerprint)) unhealthyNames.current.delete(fingerprint);
      }
    });
    return unsubscribe;
  }, [queryClient]);
  return query;
}

export function useActivity() {
  return useQuery({ queryKey: qk.activity, queryFn: () => api().library.recentActivity(80) });
}

export function useRatingAverages(targetId: string | null) {
  return useQuery({
    queryKey: qk.ratings(targetId ?? "none"),
    queryFn: () => api().ratings.averages("version", targetId!),
    enabled: targetId !== null,
    refetchOnWindowFocus: true,
  });
}

export function useLatestRating(targetType: "prompt" | "version", targetId: string | null) {
  return useQuery({
    queryKey: qk.latestRating(targetId ?? "none"),
    queryFn: () => api().ratings.latest(targetType, targetId!),
    enabled: targetId !== null,
    refetchOnWindowFocus: true,
  });
}

/** Average ratings per version of a prompt, keyed by version id. */
export function useVersionRatingSummaries(promptId: string | null) {
  return useQuery({
    queryKey: qk.versionRatings(promptId ?? "none"),
    queryFn: () => api().ratings.forPromptVersions(promptId!),
    enabled: promptId !== null,
    refetchOnWindowFocus: true,
  });
}

export function useRuns(promptId: string | null) {
  return useQuery({
    queryKey: qk.runs(promptId ?? "none"),
    queryFn: () => api().runs.list(promptId!),
    enabled: promptId !== null,
    // Agents report runs via CLI/MCP while the app is open; refresh on focus.
    refetchOnWindowFocus: true,
  });
}

/** Stored multi-model run groups of a prompt (compare view history). */
export function useRunGroups(promptId: string | null) {
  return useQuery({
    queryKey: qk.runGroups(promptId ?? "none"),
    queryFn: () => api().ai.runGroups(promptId!),
    enabled: promptId !== null,
  });
}

/** Configured AI providers incl. their model lists. */
export function useAiProviders() {
  return useQuery({ queryKey: qk.aiProviders, queryFn: () => api().ai.providers.list() });
}

/** Static provider-type registry metadata (display names, doc URLs). */
export function useAiProviderTypes() {
  return useQuery({
    queryKey: qk.aiProviderTypes,
    queryFn: () => api().ai.providerTypes(),
    staleTime: Infinity,
  });
}

/** Cached models.dev catalog, or null when never refreshed. */
export function useAiCatalog() {
  return useQuery({ queryKey: qk.aiCatalog, queryFn: () => api().ai.catalog.get() });
}

/** Which provider types have an API key in the environment (booleans only). */
export function useAiEnvDetect() {
  return useQuery({ queryKey: qk.aiEnvDetect, queryFn: () => api().ai.envDetect() });
}

/** Pending agent suggestions, refreshed on window focus (agents write via CLI/MCP). */
export function useSuggestions() {
  return useQuery({
    queryKey: qk.suggestions,
    queryFn: () => api().suggestions.list(),
    refetchOnWindowFocus: true,
  });
}

/**
 * Mutation wrapper: invalidates all queries on success (or only
 * `invalidateKeys` when given), toasts on success/error. Pass `quiet` for
 * high-frequency writes (draft autosave). `optimistic` applies an immediate
 * `setQueryData` update (rolled back on error) so toggles feel instant.
 */
export function useAppMutation<TInput, TOutput = unknown>(
  fn: (input: TInput) => Promise<TOutput>,
  options?: {
    toast?: string | ((result: TOutput) => string);
    quiet?: boolean;
    invalidate?: boolean;
    /** Invalidate only these query keys instead of every query. */
    invalidateKeys?: readonly (readonly unknown[])[];
    /** Immediate cache update applied before the mutation settles. */
    optimistic?: { queryKey: readonly unknown[]; update: (input: TInput, previous: unknown) => unknown };
    onSuccess?: (result: TOutput, input: TInput) => void;
    /** Called after the error toast (e.g. to reset local UI state). */
    onError?: (error: Error, input: TInput) => void;
  },
) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<TOutput, Error, TInput, { previous: unknown } | undefined>({
    mutationFn: fn,
    onMutate: async (input) => {
      if (!options?.optimistic) return undefined;
      const { queryKey, update } = options.optimistic;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, update(input, previous));
      return { previous };
    },
    onSuccess: (result, input) => {
      if (options?.invalidateKeys) {
        for (const queryKey of options.invalidateKeys) void queryClient.invalidateQueries({ queryKey });
      } else if (options?.invalidate !== false) {
        void queryClient.invalidateQueries();
      }
      // A local write landed — give P2P sync a nudge to ship it now instead
      // of waiting for the 60s background drain. No-op when sync is off.
      void api().sync.now().catch(() => undefined);
      if (!options?.quiet && options?.toast) {
        toast(typeof options.toast === "function" ? options.toast(result) : options.toast);
      }
      options?.onSuccess?.(result, input);
    },
    onError: (err, _input, context) => {
      if (options?.optimistic && context) {
        queryClient.setQueryData(options.optimistic.queryKey, context.previous);
      }
      toast(userErrorMessage(err), "error");
      options?.onError?.(err instanceof Error ? err : new Error(String(err)), _input);
    },
  });
}
