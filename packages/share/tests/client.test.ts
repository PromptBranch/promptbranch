import { describe, expect, it } from "vitest";
import { deleteSnapshot, describeShareError, fetchSnapshot, publishSnapshot } from "../src/client.js";
import {
  MAX_CONTROL_RESPONSE_BYTES,
  MAX_ERROR_BODY_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_SNAPSHOT_RESPONSE_BYTES,
  type SnapshotPayload,
} from "../src/schema.js";

const BASE = "https://prompts.example.com";
const ID = "V1StGXR8_Z5jdHi6B-myT";

const payload: SnapshotPayload = {
  formatVersion: 1,
  title: "security-audit",
  content: "You are a security auditor.",
  tags: [],
  publishedAt: "2026-08-25T12:00:00.000Z",
};

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function streamedResponse(
  status: number,
  chunks: Uint8Array[],
  headers?: Record<string, string>,
): { response: Response; reads: () => number; cancels: () => number } {
  let index = 0;
  let reads = 0;
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads += 1;
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancels += 1;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, { status, headers }),
    reads: () => reads,
    cancels: () => cancels,
  };
}

function fetchWithAbortObservation(
  response: Response,
  wasAborted: () => void,
): typeof fetch {
  return async (_input, init) => {
    init?.signal?.addEventListener("abort", wasAborted, { once: true });
    return response;
  };
}

describe("publishSnapshot", () => {
  it("posts the snapshot and validates the 201 response", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return jsonResponse(201, { id: ID, url: `${BASE}/p/${ID}`, deleteToken: "tok" });
    };
    const result = await publishSnapshot(BASE, payload, { fetchImpl });
    expect(result).toEqual({ ok: true, value: { id: ID, url: `${BASE}/p/${ID}`, deleteToken: "tok" } });
    expect(calls[0]!.url).toBe(`${BASE}/api/snapshots`);
    expect(calls[0]!.body).toEqual({ snapshot: payload });
  });

  it("strips a trailing slash from the base URL", async () => {
    let seenUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      seenUrl = String(input);
      return jsonResponse(201, { id: ID, url: `${BASE}/p/${ID}`, deleteToken: "tok" });
    };
    await publishSnapshot(`${BASE}/`, payload, { fetchImpl });
    expect(seenUrl).toBe(`${BASE}/api/snapshots`);
  });

  it("maps 422 to rejected with the server's finding list", async () => {
    const findings = [{ severity: "high", rule: "openai-api-key", line: 1, match: "sk-…" }];
    const fetchImpl: typeof fetch = async () => jsonResponse(422, { findings });
    const result = await publishSnapshot(BASE, payload, { fetchImpl });
    expect(result).toEqual({ ok: false, error: { kind: "rejected", findings } });
  });

  it("caps a 422 findings body before parsing it", async () => {
    const stream = streamedResponse(422, [
      new Uint8Array(MAX_CONTROL_RESPONSE_BYTES),
      new Uint8Array([1]),
    ]);

    const result = await publishSnapshot(BASE, payload, { fetchImpl: async () => stream.response });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "response-too-large",
        actualBytes: MAX_CONTROL_RESPONSE_BYTES + 1,
        maxBytes: MAX_CONTROL_RESPONSE_BYTES,
      },
    });
  });

  it("maps 429 to rate-limited, parsing retry-after", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(429, { error: "rate limited" }, { "retry-after": "30" });
    const result = await publishSnapshot(BASE, payload, { fetchImpl });
    expect(result).toEqual({ ok: false, error: { kind: "rate-limited", retryAfterSeconds: 30 } });
  });

  it("maps other failures to http and network errors", async () => {
    const failing: typeof fetch = async () => new Response("boom", { status: 500 });
    expect(await publishSnapshot(BASE, payload, { fetchImpl: failing })).toEqual({
      ok: false,
      error: { kind: "http", status: 500, message: "boom" },
    });

    const offline: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await publishSnapshot(BASE, payload, { fetchImpl: offline });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ kind: "network", message: "fetch failed" });
  });

  it("caps within-limit http error bodies at 200 chars", async () => {
    const huge: typeof fetch = async () =>
      new Response("x".repeat(MAX_ERROR_BODY_BYTES), { status: 502 });
    const published = await publishSnapshot(BASE, payload, { fetchImpl: huge });
    expect(published).toEqual({
      ok: false,
      error: { kind: "http", status: 502, message: "x".repeat(200) },
    });
    const fetched = await fetchSnapshot(BASE, ID, { fetchImpl: huge });
    expect(fetched).toEqual({
      ok: false,
      error: { kind: "http", status: 502, message: "x".repeat(200) },
    });
    const deleted = await deleteSnapshot(BASE, ID, "tok", { fetchImpl: huge });
    expect(deleted).toEqual({
      ok: false,
      error: { kind: "http", status: 502, message: "x".repeat(200) },
    });
  });

  it("maps syntactically malformed bounded JSON to invalid-response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"id":', {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    const result = await publishSnapshot(BASE, payload, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-response");
  });

  it("accepts a valid publish response exactly at the control byte cap", async () => {
    const encoder = new TextEncoder();
    const empty = JSON.stringify({ id: ID, url: `${BASE}/p/${ID}`, deleteToken: "" });
    const deleteToken = "x".repeat(MAX_CONTROL_RESPONSE_BYTES - encoder.encode(empty).byteLength);
    const body = JSON.stringify({ id: ID, url: `${BASE}/p/${ID}`, deleteToken });
    expect(encoder.encode(body)).toHaveLength(MAX_CONTROL_RESPONSE_BYTES);

    const result = await publishSnapshot(BASE, payload, {
      fetchImpl: async () => new Response(body, { status: 201 }),
    });

    expect(result).toEqual({
      ok: true,
      value: { id: ID, url: `${BASE}/p/${ID}`, deleteToken },
    });
  });

  it("rejects a declared oversized control response before reading its stream", async () => {
    const stream = streamedResponse(201, [new TextEncoder().encode("never read")], {
      "content-length": String(MAX_CONTROL_RESPONSE_BYTES + 1),
    });
    let aborted = false;

    const result = await publishSnapshot(BASE, payload, {
      fetchImpl: fetchWithAbortObservation(stream.response, () => (aborted = true)),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "response-too-large",
        actualBytes: MAX_CONTROL_RESPONSE_BYTES + 1,
        maxBytes: MAX_CONTROL_RESPONSE_BYTES,
      },
    });
    expect(stream.reads()).toBe(0);
    expect(stream.cancels()).toBe(1);
    expect(aborted).toBe(true);
  });

  it("allows a request exactly at the portal byte limit", async () => {
    const emptyBody = JSON.stringify({ snapshot: { ...payload, content: "" } });
    const content = "x".repeat(MAX_PAYLOAD_BYTES - new TextEncoder().encode(emptyBody).byteLength);
    const exactPayload = { ...payload, content };
    const exactBody = JSON.stringify({ snapshot: exactPayload });
    expect(new TextEncoder().encode(exactBody).byteLength).toBe(MAX_PAYLOAD_BYTES);

    let sentBody = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      sentBody = String(init?.body);
      return jsonResponse(201, { id: ID, url: `${BASE}/p/${ID}`, deleteToken: "tok" });
    };

    const result = await publishSnapshot(BASE, exactPayload, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(sentBody).toBe(exactBody);
  });

  it("rejects an oversized request before contacting the portal", async () => {
    const emptyBody = JSON.stringify({ snapshot: { ...payload, content: "" } });
    const content = "x".repeat(
      MAX_PAYLOAD_BYTES - new TextEncoder().encode(emptyBody).byteLength + 1,
    );
    const oversizedPayload = { ...payload, content };
    let requested = false;
    const fetchImpl: typeof fetch = async () => {
      requested = true;
      return jsonResponse(201, { id: ID, url: `${BASE}/p/${ID}`, deleteToken: "tok" });
    };

    const result = await publishSnapshot(BASE, oversizedPayload, { fetchImpl });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "too-large",
        actualBytes: MAX_PAYLOAD_BYTES + 1,
        maxBytes: MAX_PAYLOAD_BYTES,
      },
    });
    expect(requested).toBe(false);
  });

  it("measures UTF-8 bytes rather than JavaScript string length", async () => {
    const emptyBody = JSON.stringify({ snapshot: { ...payload, content: "" } });
    const emptyBytes = new TextEncoder().encode(emptyBody).byteLength;
    const emojiCount = Math.floor((MAX_PAYLOAD_BYTES - emptyBytes) / 4) + 1;
    const unicodePayload = { ...payload, content: "😀".repeat(emojiCount) };
    const unicodeBody = JSON.stringify({ snapshot: unicodePayload });
    const actualBytes = new TextEncoder().encode(unicodeBody).byteLength;
    expect(unicodeBody.length).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(actualBytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);

    let requested = false;
    const fetchImpl: typeof fetch = async () => {
      requested = true;
      return jsonResponse(201, { id: ID, url: `${BASE}/p/${ID}`, deleteToken: "tok" });
    };

    expect(await publishSnapshot(BASE, unicodePayload, { fetchImpl })).toEqual({
      ok: false,
      error: { kind: "too-large", actualBytes, maxBytes: MAX_PAYLOAD_BYTES },
    });
    expect(requested).toBe(false);
  });
});

describe("fetchSnapshot", () => {
  const snapshotResponse = {
    id: ID,
    url: `${BASE}/p/${ID}`,
    publishedAt: "2026-08-25T12:00:00.000Z",
    snapshot: payload,
  };

  it("fetches by raw id and by full URL", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(200, snapshotResponse);
    expect(await fetchSnapshot(BASE, ID, { fetchImpl })).toEqual({ ok: true, value: snapshotResponse });
    expect(await fetchSnapshot(BASE, `${BASE}/p/${ID}`, { fetchImpl })).toEqual({
      ok: true,
      value: snapshotResponse,
    });
  });

  it("maps 404 and 410", async () => {
    const notFound: typeof fetch = async () => jsonResponse(404, { error: "not found" });
    expect(await fetchSnapshot(BASE, ID, { fetchImpl: notFound })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    const gone: typeof fetch = async () => jsonResponse(410, { error: "snapshot deleted" });
    expect(await fetchSnapshot(BASE, ID, { fetchImpl: gone })).toEqual({
      ok: false,
      error: { kind: "gone" },
    });
  });

  it("accepts a snapshot response exactly at the decoded byte cap", async () => {
    const empty = JSON.stringify({
      ...snapshotResponse,
      snapshot: { ...snapshotResponse.snapshot, content: "" },
    });
    const content = "x".repeat(MAX_SNAPSHOT_RESPONSE_BYTES - new TextEncoder().encode(empty).byteLength);
    const exact = JSON.stringify({
      ...snapshotResponse,
      snapshot: { ...snapshotResponse.snapshot, content },
    });
    expect(new TextEncoder().encode(exact)).toHaveLength(MAX_SNAPSHOT_RESPONSE_BYTES);

    const result = await fetchSnapshot(BASE, ID, {
      fetchImpl: async () => new Response(exact, { status: 200 }),
    });

    expect(result.ok).toBe(true);
  });

  it("cancels and aborts on the first no-header chunk over the snapshot cap", async () => {
    const first = new Uint8Array(MAX_SNAPSHOT_RESPONSE_BYTES);
    const stream = streamedResponse(200, [first, new Uint8Array([1]), new Uint8Array([2])]);
    let aborted = false;

    const result = await fetchSnapshot(BASE, ID, {
      fetchImpl: fetchWithAbortObservation(stream.response, () => (aborted = true)),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "response-too-large",
        actualBytes: MAX_SNAPSHOT_RESPONSE_BYTES + 1,
        maxBytes: MAX_SNAPSHOT_RESPONSE_BYTES,
      },
    });
    expect(stream.reads()).toBe(2);
    expect(stream.cancels()).toBe(1);
    expect(aborted).toBe(true);
  });

  it("counts observed bytes when a dishonest content-length understates the body", async () => {
    const stream = streamedResponse(200, [
      new Uint8Array(MAX_SNAPSHOT_RESPONSE_BYTES),
      new Uint8Array([1]),
      new Uint8Array([2]),
    ], { "content-length": "12" });

    const result = await fetchSnapshot(BASE, ID, { fetchImpl: async () => stream.response });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "response-too-large",
        actualBytes: MAX_SNAPSHOT_RESPONSE_BYTES + 1,
        maxBytes: MAX_SNAPSHOT_RESPONSE_BYTES,
      },
    });
    expect(stream.reads()).toBe(2);
    expect(stream.cancels()).toBe(1);
  });

  it("counts multibyte UTF-8 bytes across the snapshot boundary", async () => {
    const encoder = new TextEncoder();
    const prefix = JSON.stringify({
      ...snapshotResponse,
      snapshot: { ...snapshotResponse.snapshot, content: "" },
    });
    const insertion = prefix.indexOf('"",') + 1;
    const body = `${prefix.slice(0, insertion)}${"x".repeat(
      MAX_SNAPSHOT_RESPONSE_BYTES - encoder.encode(prefix).byteLength,
    )}😀${prefix.slice(insertion)}`;
    const bytes = encoder.encode(body);
    expect(bytes.byteLength).toBe(MAX_SNAPSHOT_RESPONSE_BYTES + 4);
    const stream = streamedResponse(200, [
      bytes.slice(0, MAX_SNAPSHOT_RESPONSE_BYTES - 1),
      bytes.slice(MAX_SNAPSHOT_RESPONSE_BYTES - 1),
    ]);

    const result = await fetchSnapshot(BASE, ID, { fetchImpl: async () => stream.response });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "response-too-large",
        actualBytes: MAX_SNAPSHOT_RESPONSE_BYTES + 4,
        maxBytes: MAX_SNAPSHOT_RESPONSE_BYTES,
      },
    });
    expect(stream.reads()).toBe(2);
  });

  it("caps decoded response bytes even when compressed content-length is small", async () => {
    // Fetch exposes decoded response bytes. This stream models gzip expansion
    // while retaining the compressed wire length in the response headers.
    const stream = streamedResponse(200, [
      new Uint8Array(MAX_SNAPSHOT_RESPONSE_BYTES),
      new Uint8Array([1]),
    ], { "content-encoding": "gzip", "content-length": "1024" });

    const result = await fetchSnapshot(BASE, ID, { fetchImpl: async () => stream.response });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "response-too-large",
        actualBytes: MAX_SNAPSHOT_RESPONSE_BYTES + 1,
        maxBytes: MAX_SNAPSHOT_RESPONSE_BYTES,
      },
    });
  });

  it("rejects input that is neither an id nor a snapshot URL", async () => {
    const result = await fetchSnapshot(BASE, "definitely not a link", { fetchImpl: async () => jsonResponse(200, {}) });
    expect(result).toEqual({ ok: false, error: { kind: "invalid-id", input: "definitely not a link" } });
  });
});

describe("deleteSnapshot", () => {
  it("sends DELETE with the bearer token to /api/snapshots/<id>", async () => {
    const calls: Array<{ url: string; method?: string; auth?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        auth: (init?.headers as Record<string, string>)["authorization"],
      });
      return new Response(null, { status: 200 });
    };
    const result = await deleteSnapshot(`${BASE}/`, ID, "tok-123", { fetchImpl });
    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(calls[0]).toEqual({
      url: `${BASE}/api/snapshots/${ID}`,
      method: "DELETE",
      auth: "Bearer tok-123",
    });
  });

  it("treats 410 (already deleted) as success but maps 404", async () => {
    const gone: typeof fetch = async () => new Response(null, { status: 410 });
    expect(await deleteSnapshot(BASE, ID, "tok", { fetchImpl: gone })).toEqual({
      ok: true,
      value: { deleted: true },
    });
    const missing: typeof fetch = async () => new Response(null, { status: 404 });
    expect(await deleteSnapshot(BASE, ID, "tok", { fetchImpl: missing })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("maps a wrong token to http and network failures to network", async () => {
    const forbidden: typeof fetch = async () => new Response("forbidden", { status: 403 });
    expect(await deleteSnapshot(BASE, ID, "wrong", { fetchImpl: forbidden })).toEqual({
      ok: false,
      error: { kind: "http", status: 403, message: "forbidden" },
    });
    const offline: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await deleteSnapshot(BASE, ID, "tok", { fetchImpl: offline });
    expect(result).toEqual({ ok: false, error: { kind: "network", message: "fetch failed" } });
  });

  it("rejects a malformed id without a request", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not be called");
    };
    expect(await deleteSnapshot(BASE, "not-an-id", "tok", { fetchImpl })).toEqual({
      ok: false,
      error: { kind: "invalid-id", input: "not-an-id" },
    });
  });
});

describe("describeShareError", () => {
  it("renders one line per error kind", () => {
    expect(describeShareError({ kind: "network", message: "fetch failed" })).toMatch(
      /could not reach/i,
    );
    expect(describeShareError({ kind: "gone" })).toMatch(/deleted/);
    expect(describeShareError({ kind: "rate-limited", retryAfterSeconds: 30 })).toMatch(/30s/);
    expect(describeShareError({ kind: "http", status: 500, message: "boom" })).toMatch(/500/);
    expect(
      describeShareError({
        kind: "too-large",
        actualBytes: MAX_PAYLOAD_BYTES + 1,
        maxBytes: MAX_PAYLOAD_BYTES,
      }),
    ).toMatch(/too large.*257 KiB.*256 KiB/i);
    expect(
      describeShareError({
        kind: "rejected",
        findings: [{ severity: "high", rule: "openai-api-key", line: 1, match: "sk-…" }],
      }),
    ).toMatch(/rejected/);
    expect(
      describeShareError({
        kind: "response-too-large",
        actualBytes: MAX_SNAPSHOT_RESPONSE_BYTES + 1,
        maxBytes: MAX_SNAPSHOT_RESPONSE_BYTES,
      }),
    ).toMatch(/portal response.*too large.*513 KiB.*512 KiB/i);
  });
});

describe("bounded error responses", () => {
  it("returns response-too-large for a huge 500 body and stops at the overflow chunk", async () => {
    const stream = streamedResponse(500, [
      new Uint8Array(MAX_ERROR_BODY_BYTES),
      new Uint8Array([1]),
      new Uint8Array([2]),
    ]);

    const result = await publishSnapshot(BASE, payload, { fetchImpl: async () => stream.response });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "response-too-large",
        actualBytes: MAX_ERROR_BODY_BYTES + 1,
        maxBytes: MAX_ERROR_BODY_BYTES,
      },
    });
    expect(stream.reads()).toBe(2);
    expect(stream.cancels()).toBe(1);
  });

  it("keeps displayed generic error text at 200 characters within the byte cap", async () => {
    const result = await fetchSnapshot(BASE, ID, {
      fetchImpl: async () => new Response("x".repeat(MAX_ERROR_BODY_BYTES), { status: 500 }),
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: "http", status: 500, message: "x".repeat(200) },
    });
  });
});

describe("request timeouts", () => {
  const waitsForAbort: typeof fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing abort signal"));
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

  it.each([
    ["publish", () => publishSnapshot(BASE, payload, { fetchImpl: waitsForAbort, timeoutMs: 10 })],
    ["fetch", () => fetchSnapshot(BASE, ID, { fetchImpl: waitsForAbort, timeoutMs: 10 })],
    ["delete", () => deleteSnapshot(BASE, ID, "tok", { fetchImpl: waitsForAbort, timeoutMs: 10 })],
  ])("terminates a stalled %s request", async (_name, request) => {
    const result = await request();
    expect(result).toEqual({
      ok: false,
      error: { kind: "network", message: "Request timed out after 10ms" },
    });
  });

  it("keeps the timeout active while reading a stalled response body", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }), { status: 200 });
    };

    const result = await fetchSnapshot(BASE, ID, { fetchImpl, timeoutMs: 10 });

    expect(result).toEqual({
      ok: false,
      error: { kind: "network", message: "Request timed out after 10ms" },
    });
  });
});
