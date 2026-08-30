/**
 * Main-process share service on top of @promptbranch/share + @promptbranch/core.
 * Mirrors ai.ts: pure functions taking explicit deps; portal traffic goes
 * through injectable impls so tests never touch sockets. The renderer never
 * fetches — and the delete token never leaves this process.
 */
import type { PromptLibrary } from "@promptbranch/core";
import {
  buildSnapshotPayload,
  deleteSnapshot,
  describeShareError,
  fetchSnapshot,
  publishSnapshot,
  resolvePortalBaseUrl,
  scanForSecrets,
  uniqueImportTitle,
  OFFICIAL_PORTAL_BASE_URL,
  type Finding,
  type PublishResponse,
  type SnapshotPayload,
  type SnapshotResponse,
} from "@promptbranch/share";

/** settings-table key holding the self-hosted portal override ("" = official). */
export const PORTAL_BASE_URL_SETTING = "portal_base_url";

export interface ShareServiceDeps {
  lib: PromptLibrary;
  /** The __APP_VERSION__ define from main/index.ts. */
  appVersion: string;
  publishImpl?: typeof publishSnapshot;
  fetchImpl?: typeof fetchSnapshot;
  deleteImpl?: typeof deleteSnapshot;
  now?: () => Date;
}

export interface ShareScopeInput {
  promptId: string;
  includeHistory: boolean;
  description?: string;
}

export interface SharePreview {
  payload: SnapshotPayload;
  findings: Finding[];
}

function buildPayload(deps: ShareServiceDeps, input: ShareScopeInput): SnapshotPayload {
  const prompt = deps.lib.getPrompt(input.promptId);
  if (!prompt) throw new Error(`Prompt not found: ${input.promptId}`);
  const current = prompt.current_version_id ? deps.lib.getVersion(prompt.current_version_id) : null;
  if (!current) throw new Error("Prompt has no current version");
  const history = input.includeHistory
    ? deps.lib.listDefaultBranchVersions(input.promptId).map((v) => ({
        version: v.number,
        content: v.content,
        changeNote: v.change_note ?? "",
      }))
    : undefined;
  const parentId = parentSnapshotId(deps, input.promptId, getPortalBaseUrl(deps));
  return buildSnapshotPayload({
    title: prompt.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    promptDescription: prompt.description,
    content: current.content,
    tags: deps.lib.listTagsForPrompt(input.promptId).map((t) => t.name),
    ...(history ? { history } : {}),
    ...(parentId ? { parentId } : {}),
    appVersion: deps.appVersion,
    ...(deps.now ? { now: deps.now } : {}),
  });
}

/**
 * Re-sharing a prompt links the new snapshot to the latest still-active share
 * of the same prompt on the same portal — that chain is the public update
 * history. Shares on other portals (or already revoked ones) don't count.
 */
export function parentSnapshotId(
  deps: ShareServiceDeps,
  promptId: string,
  baseUrl: string,
): string | undefined {
  return deps.lib
    .listSharedSnapshots(promptId)
    .find((record) => !record.deleted_at && record.portal_base_url === baseUrl)?.snapshot_id;
}

/**
 * Builds the exact payload and scans it — the Share dialog shows both before
 * the user commits. No network. Findings point into the pretty-printed JSON
 * so their line numbers match the payload preview the dialog displays.
 */
export function previewShare(deps: ShareServiceDeps, input: ShareScopeInput): SharePreview {
  const payload = buildPayload(deps, input);
  return { payload, findings: scanForSecrets(JSON.stringify(payload, null, 2)) };
}

export async function publishShare(
  deps: ShareServiceDeps,
  input: ShareScopeInput,
): Promise<PublishResponse> {
  const { payload, findings } = previewShare(deps, input);
  const high = findings.filter((f) => f.severity === "high");
  // The dialog blocks too; this is the main-process backstop for direct IPC.
  if (high.length > 0) {
    const list = high.map((f) => `${f.rule} (line ${f.line})`).join(", ");
    throw new Error(`Publishing blocked: ${high.length} high-severity finding(s) — ${list}`);
  }
  const baseUrl = getPortalBaseUrl(deps);
  const publish = deps.publishImpl ?? publishSnapshot;
  let result = await publish(baseUrl, payload);
  if (!result.ok && result.error.kind === "http" && result.error.status === 400 && payload.parentId) {
    // Stale lineage (portal DB reset or parent purged server-side): retry once
    // unlinked rather than failing a publish the user already confirmed. Any
    // other 400 simply fails again on retry — dropping parentId can't fix it.
    const { parentId: _dropped, ...unlinked } = payload;
    result = await publish(baseUrl, unlinked);
  }
  if (!result.ok) throw new Error(describeShareError(result.error));
  deps.lib.recordSharedSnapshot({
    snapshotId: result.value.id,
    promptId: input.promptId,
    portalBaseUrl: baseUrl,
    url: result.value.url,
    deleteToken: result.value.deleteToken,
    fullHistory: input.includeHistory,
    publishedAt: payload.publishedAt,
  });
  return result.value;
}

/** Effective portal base URL: the stored override, or the official instance. */
export function getPortalBaseUrl(deps: ShareServiceDeps): string {
  const stored = deps.lib.getSetting(PORTAL_BASE_URL_SETTING);
  return stored && stored.trim() ? stored.trim() : OFFICIAL_PORTAL_BASE_URL;
}

/**
 * Stores a portal override ("" resets to the official instance) and returns
 * the effective URL. http(s) only — snapshots carry no credentials, so plain
 * http is fine for LAN/self-hosted portals (unlike AI provider base URLs).
 */
export function setPortalBaseUrl(deps: ShareServiceDeps, baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed === OFFICIAL_PORTAL_BASE_URL) {
    deps.lib.setSetting(PORTAL_BASE_URL_SETTING, "");
    return OFFICIAL_PORTAL_BASE_URL;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Portal URL must be a valid http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Portal URL must be a valid http(s) URL");
  }
  deps.lib.setSetting(PORTAL_BASE_URL_SETTING, trimmed);
  return trimmed;
}

/**
 * Revokes a share: DELETE on the portal with the locally stored token, then
 * soft-delete the local row. A 404 means there is nothing left to revoke, so
 * the row is marked either way; other failures keep the row active.
 */
export async function deleteShare(deps: ShareServiceDeps, snapshotId: string): Promise<void> {
  const record = deps.lib.getSharedSnapshot(snapshotId);
  if (!record) throw new Error(`Unknown shared snapshot: ${snapshotId}`);
  if (record.deleted_at) return;
  const remove = deps.deleteImpl ?? deleteSnapshot;
  const result = await remove(record.portal_base_url, record.snapshot_id, record.delete_token);
  if (!result.ok && result.error.kind !== "not-found") {
    throw new Error(describeShareError(result.error));
  }
  deps.lib.markSharedSnapshotDeleted(snapshotId);
}

/** Fetches a snapshot for the import confirmation dialog (no local writes). */
export async function importSnapshotPreview(
  deps: ShareServiceDeps,
  url: string,
): Promise<SnapshotResponse> {
  // Same http(s) gate as setPortalBaseUrl: a URL-shaped input names its own
  // portal via its origin, so a non-http(s) scheme must never reach fetch.
  // Raw ids don't parse as URLs and resolve against the configured portal.
  let parsed: URL | null = null;
  try {
    parsed = new URL(url.trim());
  } catch {
    parsed = null;
  }
  if (parsed && parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Snapshot URL must be a valid http(s) URL");
  }
  const fetcher = deps.fetchImpl ?? fetchSnapshot;
  const result = await fetcher(resolvePortalBaseUrl(url, getPortalBaseUrl(deps)), url);
  if (!result.ok) throw new Error(describeShareError(result.error));
  return result.value;
}

/**
 * Creates a NEW local prompt from a validated snapshot: snapshot content as
 * v1, tags applied by name (created when missing), provenance in the v1
 * change note and a library note. Snapshot history stays on the portal — v1
 * imports do not recreate the version chain.
 */
export function importSnapshot(
  deps: ShareServiceDeps,
  preview: SnapshotResponse,
): { promptId: string; title: string } {
  const title = uniqueImportTitle(
    deps.lib.listPrompts().map((p) => p.title),
    preview.snapshot.title,
  );
  const tagIds = preview.snapshot.tags.map((name) => {
    const existing = deps.lib
      .listTags()
      .find((t) => t.name.toLowerCase() === name.toLowerCase());
    return existing ? existing.id : deps.lib.createTag({ name }).id;
  });
  const prompt = deps.lib.createPrompt({
    title,
    ...(preview.snapshot.description ? { description: preview.snapshot.description } : {}),
    tagIds,
    content: preview.snapshot.content,
    changeNote: `Imported from ${preview.url}`,
  });
  deps.lib.addNote({ promptId: prompt.id, body: `Imported from ${preview.url}` });
  return { promptId: prompt.id, title: prompt.title };
}
