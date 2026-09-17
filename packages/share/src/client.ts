import {
  MAX_CONTROL_RESPONSE_BYTES,
  MAX_ERROR_BODY_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_SNAPSHOT_RESPONSE_BYTES,
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
  | { kind: "response-too-large"; actualBytes: number; maxBytes: number }
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

class ResponseTooLargeError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number,
  ) {
    super(`Portal response exceeded ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

function requestController(timeoutMs: number): { controller: AbortController; stop: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  return { controller, stop: () => clearTimeout(timer) };
}

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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

type StreamChunkResult = { done: boolean; value?: Uint8Array };

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<StreamChunkResult> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<StreamChunkResult>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function cappedBody(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  const declaredHeader = response.headers.get("content-length");
  const declaredBytes = declaredHeader !== null && /^\d+$/.test(declaredHeader)
    ? Number(declaredHeader)
    : null;

  const rejectOversize = async (actualBytes: number): Promise<never> => {
    const error = new ResponseTooLargeError(actualBytes, maxBytes);
    controller.abort(error);
    void reader?.cancel(error).catch(() => undefined);
    throw error;
  };

  if (declaredBytes !== null && declaredBytes > maxBytes) {
    return await rejectOversize(declaredBytes);
  }
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, controller.signal);
      if (done) break;
      if (!value) throw new TypeError("Response stream produced no chunk");
      total += value.byteLength;
      if (total > maxBytes) return await rejectOversize(total);
      chunks.push(value);
    }
  } catch (error) {
    if (!(error instanceof ResponseTooLargeError)) {
      void reader.cancel(error).catch(() => undefined);
    }
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function safeJson(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Record<string, unknown> | null> {
  const bytes = await cappedBody(response, maxBytes, controller);
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
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
async function errorBody(response: Response, controller: AbortController): Promise<string> {
  const bytes = await cappedBody(response, MAX_ERROR_BODY_BYTES, controller);
  return new TextDecoder().decode(bytes).slice(0, 200);
}

function responseError(error: unknown, timeoutMs: number): ShareError {
  if (error instanceof ResponseTooLargeError) {
    return {
      kind: "response-too-large",
      actualBytes: error.actualBytes,
      maxBytes: error.maxBytes,
    };
  }
  return networkError(error, timeoutMs);
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
  const request = requestController(timeoutMs);
  try {
    const response = await fetchImpl(`${base}/api/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: request.controller.signal,
    });
    if (response.status === 422) {
      const body = await safeJson(response, MAX_CONTROL_RESPONSE_BYTES, request.controller);
      const findings = Array.isArray(body?.["findings"]) ? (body["findings"] as Finding[]) : [];
      return { ok: false, error: { kind: "rejected", findings } };
    }
    if (response.status === 429) return { ok: false, error: rateLimited(response) };
    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind: "http",
          status: response.status,
          message: await errorBody(response, request.controller),
        },
      };
    }
    const parsed = publishResponseSchema.safeParse(
      await safeJson(response, MAX_CONTROL_RESPONSE_BYTES, request.controller),
    );
    if (!parsed.success) {
      return { ok: false, error: { kind: "invalid-response", message: parsed.error.message } };
    }
    return { ok: true, value: parsed.data };
  } catch (error) {
    return { ok: false, error: responseError(error, timeoutMs) };
  } finally {
    request.stop();
  }
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
  const request = requestController(timeoutMs);
  try {
    const response = await fetchImpl(`${base}/api/snapshots/${parsedId.id}`, {
      signal: request.controller.signal,
    });
    if (response.status === 404) return { ok: false, error: { kind: "not-found" } };
    if (response.status === 410) return { ok: false, error: { kind: "gone" } };
    if (response.status === 429) return { ok: false, error: rateLimited(response) };
    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind: "http",
          status: response.status,
          message: await errorBody(response, request.controller),
        },
      };
    }
    const parsed = snapshotResponseSchema.safeParse(
      await safeJson(response, MAX_SNAPSHOT_RESPONSE_BYTES, request.controller),
    );
    if (!parsed.success) {
      return { ok: false, error: { kind: "invalid-response", message: parsed.error.message } };
    }
    return { ok: true, value: parsed.data };
  } catch (error) {
    return { ok: false, error: responseError(error, timeoutMs) };
  } finally {
    request.stop();
  }
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
    case "response-too-large":
      return `Portal response is too large (${Math.ceil(error.actualBytes / 1024)} KiB; maximum ${Math.floor(error.maxBytes / 1024)} KiB)`;
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
  const request = requestController(timeoutMs);
  try {
    const response = await fetchImpl(`${base}/api/snapshots/${parsedId.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${deleteToken}` },
      signal: request.controller.signal,
    });
    if (response.status === 410) return { ok: true, value: { deleted: true } };
    if (response.status === 404) return { ok: false, error: { kind: "not-found" } };
    if (response.status === 429) return { ok: false, error: rateLimited(response) };
    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind: "http",
          status: response.status,
          message: await errorBody(response, request.controller),
        },
      };
    }
    return { ok: true, value: { deleted: true } };
  } catch (error) {
    return { ok: false, error: responseError(error, timeoutMs) };
  } finally {
    request.stop();
  }
}
