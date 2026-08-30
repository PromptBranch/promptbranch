import { describe, expect, it } from "vitest";
import { deleteSnapshot, describeShareError, fetchSnapshot, publishSnapshot } from "../src/client.js";
import type { SnapshotPayload } from "../src/schema.js";

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

  it("caps http error bodies at 200 chars (error pages can be huge HTML)", async () => {
    const huge: typeof fetch = async () => new Response("x".repeat(5000), { status: 502 });
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

  it("maps a malformed 201 body to invalid-response", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(201, { id: "nope" });
    const result = await publishSnapshot(BASE, payload, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-response");
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
        kind: "rejected",
        findings: [{ severity: "high", rule: "openai-api-key", line: 1, match: "sk-…" }],
      }),
    ).toMatch(/rejected/);
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
});
