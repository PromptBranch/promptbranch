import {
  MAX_PAYLOAD_BYTES,
  publishResponseSchema,
  snapshotResponseSchema,
  type PublishResponse,
  type SnapshotPayload,
  type SnapshotResponse,
} from "./schema.js";
import type { Finding } from "./scanner.js";
import { parseSnapshotUrl } from "./url.js";

/** Operational error taxonomy — callers switch on `kind`, never on message text. */
export type ShareError =
  | { kind: "network"; message: string }
  | { kind: "too-large"; actualBytes: number; maxBytes: number }
  | { kind: "invalid-id"; input: string }
  | { kind: "not-found" }
  | { kind: "gone" }
  | { kind: "rejected"; findings: Finding[] }
  | { kind: "rate-limited"; retryAfterSeconds: number | null }
  | { kind: "invalid-response"; message: string }
  | { kind: "http"; status: number; message: string };

export type ShareResult<T> = { ok: true; value: T } | { ok: false; error: ShareError };

export interface ShareClientDeps {
  /** Overridable in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Request deadline; defaults to 30 seconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function networkError(error: unknown, timeoutMs: number): ShareError {
  return {
    kind: "network",
    message:
      error instanceof Error && error.name === "TimeoutError"
        ? `Request timed out after ${timeoutMs}ms`
        : errorMessage(error),
  };
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const data: unknown = await response.json();
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function rateLimited(response: Response): ShareError {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number.parseInt(header, 10) : Number.NaN;
  return { kind: "rate-limited", retryAfterSeconds: Number.isFinite(seconds) ? seconds : null };
}

/**
 * Body excerpt for `http` errors. Capped: portals behind proxies can answer
 * with huge HTML error pages, and this string lands in toasts and stderr.
 */
async function errorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 200);
}

export async function publishSnapshot(
  baseUrl: string,
  payload: SnapshotPayload,
  deps: ShareClientDeps = {},
): Promise<ShareResult<PublishResponse>> {
  const body = JSON.stringify({ snapshot: payload });
  const bodyBytes = new TextEncoder().encode(body).byteLength;
  if (bodyBytes > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      error: { kind: "too-large", actualBytes: bodyBytes, maxBytes: MAX_PAYLOAD_BYTES },
    };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: networkError(error, timeoutMs) };
  }
  if (response.status === 422) {
    const body = await safeJson(response);
    const findings = Array.isArray(body?.["findings"]) ? (body["findings"] as Finding[]) : [];
    return { ok: false, error: { kind: "rejected", findings } };
  }
  if (response.status === 429) return { ok: false, error: rateLimited(response) };
  if (!response.ok) {
    return { ok: false, error: { kind: "http", status: response.status, message: await errorBody(response) } };
  }
  const parsed = publishResponseSchema.safeParse(await safeJson(response));
  if (!parsed.success) return { ok: false, error: { kind: "invalid-response", message: parsed.error.message } };
  return { ok: true, value: parsed.data };
}

export async function fetchSnapshot(
  baseUrl: string,
  idOrUrl: string,
  deps: ShareClientDeps = {},
): Promise<ShareResult<SnapshotResponse>> {
  const parsedId = parseSnapshotUrl(idOrUrl);
  if (!parsedId) return { ok: false, error: { kind: "invalid-id", input: idOrUrl } };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/snapshots/${parsedId.id}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: networkError(error, timeoutMs) };
  }
  if (response.status === 404) return { ok: false, error: { kind: "not-found" } };
  if (response.status === 410) return { ok: false, error: { kind: "gone" } };
  if (response.status === 429) return { ok: false, error: rateLimited(response) };
  if (!response.ok) {
    return { ok: false, error: { kind: "http", status: response.status, message: await errorBody(response) } };
  }
  const parsed = snapshotResponseSchema.safeParse(await safeJson(response));
  if (!parsed.success) return { ok: false, error: { kind: "invalid-response", message: parsed.error.message } };
  return { ok: true, value: parsed.data };
}

/** Official hosted portal; self-hosted users override per library (settings key portal_base_url). */
export const OFFICIAL_PORTAL_BASE_URL = "https://promptbranch.app";

/** Human-readable one-liner for UI toasts / CLI stderr. Callers still switch on `kind`. */
export function describeShareError(error: ShareError): string {
  switch (error.kind) {
    case "network":
      return `Could not reach the portal: ${error.message}`;
    case "too-large":
      return `Snapshot is too large to publish (${Math.ceil(error.actualBytes / 1024)} KiB; maximum ${Math.floor(error.maxBytes / 1024)} KiB)`;
    case "invalid-id":
      return `Not a snapshot link: ${error.input}`;
    case "not-found":
      return "Snapshot not found on the portal";
    case "gone":
      return "Snapshot was deleted from the portal";
    case "rejected":
      return `The portal rejected the snapshot: ${error.findings.length} secret finding(s)`;
    case "rate-limited":
      return error.retryAfterSeconds !== null
        ? `Rate limited by the portal — retry in ${error.retryAfterSeconds}s`
        : "Rate limited by the portal";
    case "invalid-response":
      return "The portal returned an unexpected response";
    case "http":
      return `Portal error (HTTP ${error.status}): ${error.message}`;
  }
}

/**
 * Revokes a published snapshot with its one-time delete token. 410 maps to
 * success: already deleted is the desired end state (and the portal's DELETE
 * is idempotent anyway).
 */
export async function deleteSnapshot(
  baseUrl: string,
  idOrUrl: string,
  deleteToken: string,
  deps: ShareClientDeps = {},
): Promise<ShareResult<{ deleted: true }>> {
  const parsedId = parseSnapshotUrl(idOrUrl);
  if (!parsedId) return { ok: false, error: { kind: "invalid-id", input: idOrUrl } };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/snapshots/${parsedId.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${deleteToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: networkError(error, timeoutMs) };
  }
  if (response.status === 410) return { ok: true, value: { deleted: true } };
  if (response.status === 404) return { ok: false, error: { kind: "not-found" } };
  if (response.status === 429) return { ok: false, error: rateLimited(response) };
  if (!response.ok) {
    return { ok: false, error: { kind: "http", status: response.status, message: await errorBody(response) } };
  }
  return { ok: true, value: { deleted: true } };
}
