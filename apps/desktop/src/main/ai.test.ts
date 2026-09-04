import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PromptLibrary, openMemoryDatabase } from "@promptbranch/core";
import { parseCatalog } from "@promptbranch/ai";
import { aiRunSchema, type AiRunProgressEvent } from "../shared/ipc.js";
import {
  cancelRunGroup,
  connectEnvProvider,
  createProvider,
  detectEnvKeys,
  getCatalog,
  judgeRunGroup,
  refreshCatalog,
  runAssist,
  runFailureMessage,
  runModelGroup,
  setModelHidden,
  substituteVariables,
  testProvider,
  updateProvider,
  type AiServiceDeps,
  type KeyCipher,
} from "./ai.js";

/** Trivial stand-in for safeStorage: reversibly "encrypts" via base64. */
const stubCipher: KeyCipher = {
  encrypt: (plain) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
  decrypt: (blob) => {
    if (!blob.startsWith("enc:")) throw new Error("corrupt blob");
    return Buffer.from(blob.slice(4), "base64").toString("utf8");
  },
};

// --- stub OpenAI-compatible server -------------------------------------------

let server: http.Server;
let baseUrl: string;
/** Request counter for the malformed-then-valid judge retry stub. */
let flakyJudgeCalls = 0;
/** Concurrency trackers for the delayed judge stub (pool-bounds test). */
let judgeInFlight = 0;
let judgeMaxInFlight = 0;
/** Request-URL log so tests can assert which model id actually went out. */
const seenUrls: string[] = [];
/** Judge request prompts captured at the fake provider boundary. */
const judgeRequestPrompts: string[] = [];

/** One OpenAI chat-completions SSE chunk (streaming responses). */
function sseChunk(model: string, body: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: "cmpl-stub",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    ...body,
  })}\n\n`;
}

/** Streams `pieces` as chat-completion chunks, then finish + usage + [DONE]. */
function streamPieces(res: http.ServerResponse, model: string, pieces: string[], intervalMs = 0): void {
  res.setHeader("content-type", "text/event-stream");
  res.write(sseChunk(model, { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
  let index = 0;
  const timer = setInterval(() => {
    // Client may have aborted/closed mid-stream; stop writing quietly.
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    if (index < pieces.length) {
      res.write(sseChunk(model, { choices: [{ index: 0, delta: { content: pieces[index] }, finish_reason: null }] }));
      index += 1;
      return;
    }
    clearInterval(timer);
    res.write(sseChunk(model, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    res.write(
      sseChunk(model, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    );
    res.end("data: [DONE]\n\n");
  }, intervalMs);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seenUrls.push(req.url ?? "");
    // Google-driver stub: generateContent calls answer with a model-level
    // error keyed by the model in the URL — retired-model 404, or the
    // Lyria-style zero-quota 429 — so tests can prove which model the
    // connection test picked.
    if (req.method === "POST" && (req.url ?? "").startsWith("/v1/models/")) {
      const stubModel = (req.url ?? "").slice("/v1/models/".length).split(":")[0] ?? "";
      // Lyria-style specialty model: free but quota-capped at zero requests.
      const quotaCapped = stubModel.includes("lyria");
      res.statusCode = quotaCapped ? 429 : 404;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            code: quotaCapped ? 429 : 404,
            // The SDK only surfaces the body message when the Google error
            // shape parses — `status` is part of that shape.
            status: quotaCapped ? "RESOURCE_EXHAUSTED" : "NOT_FOUND",
            message: quotaCapped
              ? "You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0."
              : `This model models/${stubModel} is no longer available to new users. Please update your code to use models/gemini-3.5-flash-lite for the latest features and improvements.`,
          },
        }),
      );
      return;
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body) as {
          model: string;
          messages: Array<{ content: string }>;
          stream?: boolean;
        };
        if (parsed.model === "model-b") {
          res.setHeader("content-type", "application/json");
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { message: "bad key" } }));
          return;
        }
        if (parsed.model === "model-stream-only" && !parsed.stream) {
          res.setHeader("content-type", "application/json");
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: "This model requires streaming" } }));
          return;
        }
        // Judge stubs: structured verdict JSON, a flaky one that answers with
        // malformed JSON on its first call (retry path), and one always broken.
        if (parsed.model.startsWith("model-judge")) {
          judgeRequestPrompts.push(parsed.messages[0]?.content ?? "");
          flakyJudgeCalls += parsed.model === "model-judge-flaky" ? 1 : 0;
          // Flaky stub: malformed on the FIRST call after a reset, valid after
          // — deterministic under the judge pool's concurrent interleaving.
          const malformed =
            parsed.model === "model-judge-bad" ||
            (parsed.model === "model-judge-flaky" && flakyJudgeCalls === 1);
          const content = malformed
            ? "I cannot score this."
            : JSON.stringify({
                effectiveness: 5,
                clarity: 4,
                completeness: 4,
                actionability: 3,
                rationale: "Direct and usable answer.",
              });
          const sendVerdict = () => {
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                id: "cmpl-stub",
                object: "chat.completion",
                created: 1_700_000_000,
                model: parsed.model,
                choices: [
                  { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              }),
            );
          };
          if (parsed.model === "model-judge-delayed") {
            // Held open briefly so the judge pool's concurrency is observable.
            judgeInFlight += 1;
            judgeMaxInFlight = Math.max(judgeMaxInFlight, judgeInFlight);
            setTimeout(() => {
              judgeInFlight -= 1;
              sendVerdict();
            }, 75);
            return;
          }
          sendVerdict();
          return;
        }
        const text = `ok:${parsed.messages[0]?.content.slice(0, 60)}`;
        if (parsed.stream) {
          if (parsed.model === "model-slow") {
            // Slow stream for the cancel test: many chunks, 40ms apart.
            streamPieces(res, parsed.model, Array.from({ length: 30 }, (_, i) => `chunk-${i} `), 40);
            return;
          }
          // Split the full text so delta events accumulate visibly.
          streamPieces(res, parsed.model, [text.slice(0, 3), text.slice(3, 8), text.slice(8)]);
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "cmpl-stub",
            object: "chat.completion",
            created: 1_700_000_000,
            model: parsed.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      });
      return;
    }
    // The openai provider type uses the Responses API (/v1/responses).
    if (req.url === "/v1/responses" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { model: string; input: string; stream?: boolean };
        const responseBody = {
          id: "resp-stub",
          object: "response",
          created_at: 1_700_000_000,
          status: "completed",
          model: parsed.model,
          output: [
            {
              type: "message",
              id: "msg-stub",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: `ok:${parsed.input.slice(0, 60)}`, annotations: [] }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        };
        if (parsed.stream) {
          // Responses-API SSE: item/part announcements, output_text deltas,
          // then the completed response (the SDK requires the announcements).
          const text = `ok:${parsed.input.slice(0, 60)}`;
          const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          res.setHeader("content-type", "text/event-stream");
          send({
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "msg-stub", status: "in_progress", role: "assistant", content: [] },
          });
          send({
            type: "response.content_part.added",
            item_id: "msg-stub",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
          const pieces = [text.slice(0, 3), text.slice(3, 8), text.slice(8)].filter((p) => p.length > 0);
          for (const piece of pieces) {
            send({
              type: "response.output_text.delta",
              item_id: "msg-stub",
              output_index: 0,
              content_index: 0,
              delta: piece,
            });
          }
          res.end(`data: ${JSON.stringify({ type: "response.completed", response: responseBody })}\n\n`);
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(responseBody));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeDeps(): AiServiceDeps & { lib: PromptLibrary } {
  const lib = new PromptLibrary(openMemoryDatabase());
  return { lib, cipher: stubCipher };
}

function addStubProvider(deps: AiServiceDeps, models: string[] = ["model-a"]): string {
  const provider = createProvider(deps, {
    type: "openai-compatible",
    name: "Local stub",
    apiKey: "secret-key",
    baseUrl,
  });
  deps.lib.setProviderModels(provider.id, models.map((modelId) => ({ modelId })));
  return provider.id;
}

describe("key handling", () => {
  it("encrypts on write, stores only the blob, decrypts at execution time", () => {
    const deps = makeDeps();
    const provider = createProvider(deps, {
      type: "openai-compatible",
      name: "s",
      apiKey: "sk-plaintext",
      baseUrl,
    });
    expect(provider.hasApiKey).toBe(true);
    const row = deps.lib.getProvider(provider.id)!;
    expect(row.api_key_enc).not.toContain("sk-plaintext");
    expect(stubCipher.decrypt(row.api_key_enc!)).toBe("sk-plaintext");

    // DTOs never carry key material.
    expect(JSON.stringify(provider)).not.toContain("sk-plaintext");
    expect(JSON.stringify(provider)).not.toContain(row.api_key_enc!);
  });

  it("surfaces encryption failures instead of storing plaintext", () => {
    const deps = makeDeps();
    const broken: KeyCipher = {
      encrypt: () => {
        throw new Error("OS keychain encryption is unavailable");
      },
      decrypt: () => "",
    };
    expect(() =>
      createProvider({ ...deps, cipher: broken }, { type: "openai", name: "x", apiKey: "k" }),
    ).toThrow(/encrypt/);
  });
});

describe("baseUrl policy", () => {
  it("allows https and loopback http, rejects remote http on create and update", () => {
    const deps = makeDeps();
    // Loopback http (local servers) and any https URL are accepted.
    for (const url of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:11434/v1",
      "http://[::1]:11434/v1",
      "https://api.example.com/v1",
    ]) {
      expect(createProvider(deps, { type: "openai-compatible", name: url, baseUrl: url }).baseUrl).toBe(url);
    }
    // Remote plaintext http is rejected — keys would travel unencrypted.
    for (const url of ["http://api.example.com/v1", "http://192.168.1.10:11434/v1", "ftp://localhost/v1"]) {
      expect(() => createProvider(deps, { type: "openai-compatible", name: "x", baseUrl: url })).toThrow(/https/);
    }
    // The optional baseUrl of native-driver providers is constrained too.
    expect(() =>
      createProvider(deps, { type: "openai", name: "o", apiKey: "k", baseUrl: "http://api.example.com/v1" }),
    ).toThrow(/https/);
    const provider = createProvider(deps, { type: "openai-compatible", name: "s", baseUrl });
    expect(() =>
      updateProvider(deps, { id: provider.id, patch: { baseUrl: "http://api.example.com/v1" } }),
    ).toThrow(/https/);
  });

  it("clears the stored key when the base URL changes", () => {
    const deps = makeDeps();
    const provider = createProvider(deps, { type: "openai-compatible", name: "s", apiKey: "sk-one", baseUrl });
    // Unrelated updates keep the key.
    expect(updateProvider(deps, { id: provider.id, patch: { name: "renamed" } }).hasApiKey).toBe(true);
    // A URL change clears it — the old key is never re-pointed silently.
    const moved = updateProvider(deps, { id: provider.id, patch: { baseUrl: `${baseUrl}2` } });
    expect(moved.hasApiKey).toBe(false);
    expect(deps.lib.getProvider(provider.id)!.api_key_enc).toBeNull();
    // A replacement key in the same patch is stored instead.
    const rekeyed = updateProvider(deps, { id: provider.id, patch: { baseUrl, apiKey: "sk-two" } });
    expect(rekeyed.hasApiKey).toBe(true);
    expect(stubCipher.decrypt(deps.lib.getProvider(provider.id)!.api_key_enc!)).toBe("sk-two");
    // Re-setting the same URL is not a change — the key survives.
    expect(updateProvider(deps, { id: provider.id, patch: { baseUrl } }).hasApiKey).toBe(true);
  });

  it("refuses to null the base URL of an openai-compatible provider", () => {
    const deps = makeDeps();
    const provider = createProvider(deps, { type: "openai-compatible", name: "s", baseUrl });
    expect(() => updateProvider(deps, { id: provider.id, patch: { baseUrl: null } })).toThrow(
      /requires a base URL/,
    );
    // Native drivers may drop their optional base-URL override.
    const native = createProvider(deps, { type: "openai", name: "o", apiKey: "k", baseUrl });
    expect(updateProvider(deps, { id: native.id, patch: { baseUrl: null } }).baseUrl).toBeNull();
  });
});

describe("runFailureMessage", () => {
  it("never returns an empty message (recordModelRun contract)", () => {
    expect(runFailureMessage({ message: "" })).toBe("Unknown provider error");
    expect(runFailureMessage({ message: "  " })).toBe("Unknown provider error");
    expect(runFailureMessage({ message: "boom" })).toBe("boom");
  });
});

describe("aiRunSchema", () => {
  const base = { promptId: "p", content: "hi" };
  const ref = (modelId: string) => ({ providerId: "prov", modelId });

  it("rejects duplicate provider/model pairs", () => {
    expect(aiRunSchema.safeParse({ ...base, modelRefs: [ref("a"), ref("a")] }).success).toBe(false);
    expect(aiRunSchema.safeParse({ ...base, modelRefs: [ref("a"), ref("b")] }).success).toBe(true);
  });

  it("enforces the 1–6 model cap", () => {
    expect(aiRunSchema.safeParse({ ...base, modelRefs: [] }).success).toBe(false);
    expect(aiRunSchema.safeParse({ ...base, modelRefs: ["1", "2", "3", "4", "5", "6"].map(ref) }).success).toBe(true);
    expect(aiRunSchema.safeParse({ ...base, modelRefs: ["1", "2", "3", "4", "5", "6", "7"].map(ref) }).success).toBe(
      false,
    );
  });
});

describe("catalog get/refresh", () => {
  // Parsed ModelCatalog shape (as produced by packages/ai's fetchCatalog).
  const catalogFixture = parseCatalog({
    openai: {
      id: "openai",
      env: ["OPENAI_API_KEY"],
      models: {
        "gpt-4o-mini": {
          id: "gpt-4o-mini",
          name: "GPT-4o mini",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 128000, output: 16384 },
          cost: { input: 0.15, output: 0.6 },
        },
      },
    },
  });

  it("returns null before any refresh, then serves the cache", async () => {
    const deps = makeDeps();
    expect(getCatalog(deps.lib)).toBeNull();
    const result = await refreshCatalog({ ...deps, fetchCatalogImpl: async () => catalogFixture });
    expect(result.ok).toBe(true);
    expect(result.catalog?.models.openai![0]).toMatchObject({ id: "gpt-4o-mini", costInput: 0.15 });
    expect(getCatalog(deps.lib)?.models.openai!).toHaveLength(1);
  });

  it("keeps serving the stale cache when refresh fails (offline-safe)", async () => {
    const deps = makeDeps();
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => catalogFixture });
    const failed = await refreshCatalog({
      ...deps,
      fetchCatalogImpl: async () => {
        throw new Error("ENOTFOUND models.dev");
      },
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/ENOTFOUND/);
    expect(failed.catalog?.models.openai!).toHaveLength(1);
  });

  it("keeps an unprovenanced legacy cache usable for offline model execution", async () => {
    const deps = makeDeps();
    deps.lib.setCatalogCache(JSON.stringify(catalogFixture));
    expect(getCatalog(deps.lib)?.models.openai).toHaveLength(1);
    const provider = createProvider(deps, {
      type: "openai",
      name: "OpenAI through local stub",
      apiKey: "explicitly-stored-key",
      baseUrl,
    });
    const prompt = deps.lib.createPrompt({ title: "Offline catalog", content: "Hello" });

    const group = await runModelGroup(deps, {
      promptId: prompt.id,
      content: "Hello",
      variables: {},
      modelRefs: [{ providerId: provider.id, modelId: "gpt-4o-mini" }],
    });

    expect(group.runs[0]?.status).toBe("completed");
  });
});

describe("testProvider", () => {
  it("uses the same streaming request path as model runs", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-stream-only"]);

    expect(await testProvider(deps, providerId, "model-stream-only")).toEqual({ ok: true });
  });

  it("verifies connectivity with a tiny generation", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps);
    expect(await testProvider(deps, providerId, "model-a")).toEqual({ ok: true });
  });

  it("returns a normalized error instead of throwing", async () => {
    const deps = makeDeps();
    expect(await testProvider(deps, "nope")).toEqual({ ok: false, error: "Unknown provider: nope" });
    const providerId = addStubProvider(deps, ["model-a", "model-b"]);
    const result = await testProvider(deps, providerId, "model-b");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 401/);
    expect(result.hint).toMatch(/API key.*access/i);
  });

  it("applies the same provider and model availability gates as execution", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps);
    const requestsBefore = seenUrls.length;

    setModelHidden(deps, { providerId, modelId: "model-a", hidden: true });
    expect(await testProvider(deps, providerId, "model-a")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/hidden/),
    });
    expect(seenUrls).toHaveLength(requestsBefore);

    setModelHidden(deps, { providerId, modelId: "model-a", hidden: false });
    updateProvider(deps, { id: providerId, patch: { enabled: false } });
    expect(await testProvider(deps, providerId, "model-a")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/disabled/),
    });
    expect(seenUrls).toHaveLength(requestsBefore);
  });
});

describe("test model selection", () => {
  // Google retired gemini-2.5-flash-lite for new keys — the exact failure
  // this resolution order exists to survive. The stub key stays in a
  // variable (env-overridable) so secret scanners see no inline credential.
  const googleStubKey = process.env.GOOGLE_STUB_KEY ?? "google-stub-key";
  const googleCatalog = parseCatalog({
    google: {
      id: "google",
      env: ["GOOGLE_GENERATIVE_AI_API_KEY"],
      models: {
        "gemini-2.5-flash-lite": {
          id: "gemini-2.5-flash-lite",
          name: "Gemini 2.5 Flash-Lite",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1_048_576, output: 65_536 },
          cost: { input: 0.1, output: 0.4 },
        },
        "gemini-3.5-flash-lite": {
          id: "gemini-3.5-flash-lite",
          name: "Gemini 3.5 Flash-Lite",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1_048_576, output: 65_536 },
          cost: { input: 0.05, output: 0.2 },
        },
        "lyria-audio-only": {
          id: "lyria-audio-only",
          name: "Lyria audio-only",
          modalities: { input: ["text"], output: ["audio"] },
          limit: { context: 8_192, output: 8_192 },
          cost: { input: 0.1, output: 0.2 },
        },
      },
    },
  });

  function connectGoogle(deps: AiServiceDeps): string {
    return createProvider(deps, {
      type: "google",
      name: "Google",
      apiKey: googleStubKey,
      baseUrl,
    }).id;
  }

  it("keeps an explicit model id — the connect dialog's choice", async () => {
    const deps = makeDeps();
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => googleCatalog });
    const providerId = connectGoogle(deps);
    await testProvider(deps, providerId, "gemini-3.5-flash-lite");
    expect(seenUrls.at(-1)).toContain("gemini-3.5-flash-lite");
  });

  it("remembers the explicit choice: later tests without an id reuse it", async () => {
    const deps = makeDeps();
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => googleCatalog });
    const providerId = connectGoogle(deps);
    // The choice is remembered even when the test itself fails (retired
    // model etc.) — it stays the user's pick until changed.
    await testProvider(deps, providerId, "gemini-3.5-flash-lite");
    expect(seenUrls.at(-1)).toContain("gemini-3.5-flash-lite");

    await testProvider(deps, providerId);
    expect(seenUrls.at(-1)).toContain("gemini-3.5-flash-lite");

    // A new explicit choice replaces the remembered one.
    await testProvider(deps, providerId, "gemini-2.5-flash-lite");
    await testProvider(deps, providerId);
    expect(seenUrls.at(-1)).toContain("gemini-2.5-flash-lite");
  });

  it("uses the provider's declared models when no explicit id is given", async () => {
    const deps = makeDeps();
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => googleCatalog });
    const providerId = connectGoogle(deps);
    deps.lib.setProviderModels(providerId, [{ modelId: "gemini-3.5-flash-lite" }]);
    const result = await testProvider(deps, providerId);
    expect(result.ok).toBe(false);
    expect(result.modelUnavailable).toBe(true);
    expect(seenUrls.at(-1)).toContain("gemini-3.5-flash-lite");
  });

  it("surfaces the provider-named replacement for one-click retry", async () => {
    const deps = makeDeps();
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => googleCatalog });
    const providerId = connectGoogle(deps);
    // The stub's retirement notice names models/gemini-3.5-flash-lite as
    // the replacement for whatever was tested.
    await testProvider(deps, providerId, "gemini-2.5-flash-lite");
    const result = await testProvider(deps, providerId, "gemini-2.5-flash-lite");
    expect(result.modelUnavailable).toBe(true);
    expect(result.suggestedModel).toBe("gemini-3.5-flash-lite");
  });

  it("never guesses a model from the catalog — explicit guidance instead", async () => {
    const deps = makeDeps();
    // Catalog cached, but no declared models and no explicit id: with real
    // models.dev data the cheapest "chat-looking" pick was Lyria (text+audio
    // output, $0) — a music model with zero chat quota. No request may go
    // out; the user gets told to pick a model.
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => googleCatalog });
    const providerId = connectGoogle(deps);
    const urlsBefore = seenUrls.length;
    const result = await testProvider(deps, providerId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No test model chosen/);
    expect(result.modelUnavailable).toBeUndefined();
    expect(seenUrls.length).toBe(urlsBefore);
  });

  it("rejects catalog models that cannot produce text before making a request", async () => {
    const deps = makeDeps();
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => googleCatalog });
    const providerId = connectGoogle(deps);
    const urlsBefore = seenUrls.length;

    const result = await testProvider(deps, providerId, "lyria-audio-only");

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not a text generation model/) });
    expect(seenUrls).toHaveLength(urlsBefore);
  });

  it("does not flag non-model failures (bad key 401) as unavailable", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-a", "model-b"]);
    const result = await testProvider(deps, providerId, "model-b");
    expect(result.ok).toBe(false);
    expect(result.modelUnavailable).toBeUndefined();
  });

  // The SDK retries 429s with backoff ("retry in ~2.5s"), so this one needs
  // room beyond the 5s default.
  it("flags quota-capped picks (free-tier-zero models) as unavailable", { timeout: 15_000 }, async () => {
    const deps = makeDeps();
    const providerId = connectGoogle(deps);
    // Declared models outrank the catalog pick — simulates the Lyria case:
    // a zero-quota specialty model winning the auto-pick.
    deps.lib.setProviderModels(providerId, [{ modelId: "lyria-3-clip" }]);
    const result = await testProvider(deps, providerId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/quota/i);
    expect(result.modelUnavailable).toBe(true);
    expect(seenUrls.at(-1)).toContain("lyria-3-clip");
  });
});

describe("runModelGroup", () => {
  it("runs two models concurrently and writes a two-row run group", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-a", "model-b"]);
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Hi {{name}}" });
    const group = await runModelGroup(deps, {
      promptId: prompt.id,
      content: prompt.current_version_id
        ? "Say hello to {{name}}"
        : "unreachable",
      variables: { name: "Ada" },
      modelRefs: [
        { providerId, modelId: "model-a" },
        { providerId, modelId: "model-b" },
      ],
    });

    expect(group.runGroupId).toBeTruthy();
    expect(group.versionId).toBe(prompt.current_version_id);
    expect(group.runs).toHaveLength(2);
    const [a, b] = group.runs;
    expect(a!.status).toBe("completed");
    expect(a!.output).toBe("ok:Say hello to Ada");
    expect(a!.latencyMs).not.toBeNull();
    expect(b!.status).toBe("error");
    expect(b!.error).toMatch(/HTTP 401/);

    // Both rows persisted under the group, with provider/model/latency set.
    const rows = deps.lib.listRuns(prompt.id, { runGroupId: group.runGroupId });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.prompt_content === "Say hello to Ada")).toBe(true);
    const okRow = rows.find((r) => r.status === "completed")!;
    expect(okRow.provider).toBe(providerId);
    expect(okRow.model).toBe("model-a");
    expect(okRow.tool).toBe("prompthub-run");
    expect(JSON.parse(okRow.metrics_json!)).toEqual({
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: null, // no catalog cached in this test
      promptContentCaptured: true,
    });
    expect(deps.lib.listRunGroups(prompt.id)).toHaveLength(1);
  });

  it("rejects unknown/disabled providers and models, and empty content", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps);
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Hi" });
    const base = { promptId: prompt.id, content: "Hi", variables: {} };

    await expect(
      runModelGroup(deps, { ...base, modelRefs: [{ providerId: "nope", modelId: "model-a" }] }),
    ).rejects.toThrow(/Unknown provider/);
    await expect(
      runModelGroup(deps, { ...base, modelRefs: [{ providerId, modelId: "unconfigured" }] }),
    ).rejects.toThrow(/not declared/);

    updateProvider(deps, { id: providerId, patch: { enabled: false } });
    await expect(
      runModelGroup(deps, { ...base, modelRefs: [{ providerId, modelId: "model-a" }] }),
    ).rejects.toThrow(/disabled/);
    updateProvider(deps, { id: providerId, patch: { enabled: true } });

    // A variable substituting to an empty string can empty the whole content.
    await expect(
      runModelGroup(deps, { ...base, content: "{{name}}", variables: { name: "" }, modelRefs: [{ providerId, modelId: "model-a" }] }),
    ).rejects.toThrow(/empty after variable substitution/);
    await expect(
      runModelGroup(deps, { ...base, promptId: "nope", modelRefs: [{ providerId, modelId: "model-a" }] }),
    ).rejects.toThrow(/Prompt not found/);
  });
});

describe("judgeRunGroup", () => {
  /** Two completed runs + one error run under a shared run group. */
  function seedRunGroup(deps: AiServiceDeps & { lib: PromptLibrary }, providerId: string) {
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Say hi politely" });
    const versionId = prompt.current_version_id!;
    const runGroupId = "rg-judge";
    const completedA = deps.lib.recordModelRun({
      promptId: prompt.id, versionId, provider: providerId, model: "model-a",
      status: "completed", output: "Hello there!", runGroupId,
    });
    const completedB = deps.lib.recordModelRun({
      promptId: prompt.id, versionId, provider: providerId, model: "model-c",
      status: "completed", output: "Hi.", runGroupId,
    });
    const failed = deps.lib.recordModelRun({
      promptId: prompt.id, versionId, provider: providerId, model: "model-b",
      status: "error", error: "Rate limited", runGroupId,
    });
    return { prompt, runGroupId, completedA, completedB, failed };
  }

  it("scores completed runs, skips error runs and writes nothing to the DB", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-a", "model-c", "model-judge"]);
    const { prompt, runGroupId, completedA, failed } = seedRunGroup(deps, providerId);

    const result = await judgeRunGroup(deps, {
      runGroupId,
      judge: { providerId, modelId: "model-judge" },
      criteria: "Prefer warm greetings.",
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      runId: completedA.id,
      modelId: "model-a",
      scores: { effectiveness: 5, clarity: 4, completeness: 4, actionability: 3 },
      rationale: "Direct and usable answer.",
    });
    expect(result.skipped).toEqual([{ runId: failed.id, modelId: "model-b", reason: "Rate limited" }]);
    expect(result.failures).toEqual([]);

    // Read-only: no outcome ratings, no metrics written by judging.
    const rows = deps.lib.listRuns(prompt.id, { runGroupId });
    expect(rows.every((r) => r.outcome_rating === null)).toBe(true);
    expect(rows.find((r) => r.id === completedA.id)!.metrics_json).toBeNull();
  });

  it("judges the substituted draft that produced the run instead of the saved template", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-a", "model-judge"]);
    const prompt = deps.lib.createPrompt({
      title: "Launch",
      content: "Saved template for {{name}}",
    });
    const group = await runModelGroup(deps, {
      promptId: prompt.id,
      content: "Executed draft for {{name}}",
      variables: { name: "Ada" },
      modelRefs: [{ providerId, modelId: "model-a" }],
    });
    judgeRequestPrompts.length = 0;

    await judgeRunGroup(deps, {
      runGroupId: group.runGroupId,
      judge: { providerId, modelId: "model-judge" },
    });

    expect(judgeRequestPrompts).toHaveLength(1);
    expect(judgeRequestPrompts[0]).toContain('Prompt:\n"""\nExecuted draft for Ada\n"""');
    expect(judgeRequestPrompts[0]).not.toContain("Saved template for {{name}}");
  });

  it("falls back to saved version content for legacy runs without an execution snapshot", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-a", "model-c", "model-judge"]);
    const { runGroupId } = seedRunGroup(deps, providerId);
    judgeRequestPrompts.length = 0;

    await judgeRunGroup(deps, {
      runGroupId,
      judge: { providerId, modelId: "model-judge" },
    });

    expect(judgeRequestPrompts).toHaveLength(2);
    expect(
      judgeRequestPrompts.every((request) =>
        request.includes('Prompt:\n"""\nSay hi politely\n"""'),
      ),
    ).toBe(true);
  });

  it("fails closed when a synced run says its exact prompt snapshot stayed on another device", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-a", "model-judge"]);
    const prompt = deps.lib.createPrompt({ title: "Remote", content: "Saved fallback" });
    const run = deps.lib.addRun({
      promptId: prompt.id,
      versionId: prompt.current_version_id!,
      tool: "prompthub-run",
      provider: providerId,
      model: "model-a",
      status: "completed",
      output: "Remote output",
      runGroupId: "remote-group",
      metrics: { promptContentCaptured: true },
    });
    judgeRequestPrompts.length = 0;

    const result = await judgeRunGroup(deps, {
      runGroupId: "remote-group",
      judge: { providerId, modelId: "model-judge" },
    });

    expect(result.results).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        runId: run.id,
        error: expect.stringMatching(/exact prompt snapshot is unavailable.*device that executed/i),
      }),
    ]);
    expect(judgeRequestPrompts).toEqual([]);
  });

  it("retries once on malformed judge JSON (parse-and-validate fallback)", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-a", "model-judge-flaky"]);
    const { runGroupId } = seedRunGroup(deps, providerId);
    flakyJudgeCalls = 0;

    const result = await judgeRunGroup(deps, {
      runGroupId,
      judge: { providerId, modelId: "model-judge-flaky" },
    });
    expect(result.failures).toEqual([]);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.scores.effectiveness).toBe(5);
    // One malformed reply total, retried by whichever run hit it: 2 + 1 calls.
    expect(flakyJudgeCalls).toBe(3);
  });

  it("reports per-run judge failures without failing the whole group", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-a", "model-c", "model-judge-bad"]);
    const { runGroupId, completedA } = seedRunGroup(deps, providerId);

    const result = await judgeRunGroup(deps, {
      runGroupId,
      judge: { providerId, modelId: "model-judge-bad" },
    });
    expect(result.results).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({ runId: completedA.id, modelId: "model-a" });
    expect(result.failures[0]!.error).toMatch(/malformed JSON/i);
  });

  it("judges through a bounded concurrency pool, preserving run order", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-judge-delayed"]);
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Say hi politely" });
    const versionId = prompt.current_version_id!;
    const runGroupId = "rg-pool";
    const runIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      runIds.push(
        deps.lib.recordModelRun({
          promptId: prompt.id,
          versionId,
          provider: providerId,
          model: `model-${i}`,
          status: "completed",
          output: `answer ${i}`,
          runGroupId,
        }).id,
      );
    }
    judgeInFlight = 0;
    judgeMaxInFlight = 0;

    const result = await judgeRunGroup(deps, {
      runGroupId,
      judge: { providerId, modelId: "model-judge-delayed" },
    });

    // All four judged, in run order, with at most JUDGE_CONCURRENCY in flight.
    expect(result.results.map((r) => r.runId)).toEqual(runIds);
    expect(judgeMaxInFlight).toBeGreaterThan(1);
    expect(judgeMaxInFlight).toBeLessThanOrEqual(3);
  });

  it("rejects an unrunnable judge model and unknown run groups", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-a", "model-c"]);
    const { runGroupId } = seedRunGroup(deps, providerId);

    await expect(
      judgeRunGroup(deps, { runGroupId, judge: { providerId, modelId: "model-missing" } }),
    ).rejects.toThrow(/not declared/);
    await expect(
      judgeRunGroup(deps, { runGroupId: "rg-nope", judge: { providerId, modelId: "model-a" } }),
    ).rejects.toThrow(/Run group not found/);
    await expect(
      judgeRunGroup(deps, { runGroupId, judge: { providerId: "nope", modelId: "model-a" } }),
    ).rejects.toThrow(/Unknown provider/);
  });
});

describe("runModelGroup progress + cancel", () => {
  it("emits queued → started → delta* → completed/error per model and writes rows as models settle", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-a", "model-b"]);
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Hi" });
    const events: AiRunProgressEvent[] = [];
    const statusesAtCompleted: string[] = [];
    const group = await runModelGroup(
      deps,
      {
        promptId: prompt.id,
        content: "Hi",
        variables: {},
        modelRefs: [
          { providerId, modelId: "model-a" },
          { providerId, modelId: "model-b" },
        ],
      },
      (event) => {
        events.push(event);
        if (event.phase === "completed") {
          // Per-model rows are written before the completed event fires.
          statusesAtCompleted.push(
            ...deps.lib
              .listRuns(prompt.id, { runGroupId: event.runGroupId })
              .filter((r) => r.model === event.modelId)
              .map((r) => r.status),
          );
        }
      },
    );

    // Per model: queued first (request time), started on the first token,
    // terminal event last.
    const forA = events.filter((e) => e.modelId === "model-a");
    expect(forA[0]!.phase).toBe("queued");
    // The queued event carries the runGroupId immediately — the renderer can
    // offer Cancel before the first token arrives.
    expect(forA[0]!.runGroupId).toBe(group.runGroupId);
    expect(forA[1]!.phase).toBe("started");
    expect(forA.at(-1)!.phase).toBe("completed");
    // Deltas carry the accumulated text (monotonically growing prefixes).
    const deltas = forA.filter((e) => e.phase === "delta").map((e) => e.text!);
    expect(deltas.length).toBeGreaterThan(0);
    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i]!.startsWith(deltas[i - 1]!)).toBe(true);
    }
    const completed = forA.find((e) => e.phase === "completed")!;
    expect(completed.text).toBe("ok:Hi");
    expect(completed.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(completed.latencyMs).toBeGreaterThanOrEqual(0);
    // The completed row already existed when the event fired.
    expect(statusesAtCompleted).toEqual(["completed"]);

    const forB = events.filter((e) => e.modelId === "model-b").map((e) => e.phase);
    // model-b fails before any token — queued, then the error (no started/delta).
    expect(forB).toEqual(["queued", "error"]);
    expect(events.find((e) => e.modelId === "model-b" && e.phase === "error")!.error).toMatch(/HTTP 401/);

    // The final DTO keeps its shape and input order.
    expect(group.runs.map((r) => r.status)).toEqual(["completed", "error"]);
    expect(group.runs[0]!.output).toBe("ok:Hi");
    expect(deps.lib.listRuns(prompt.id, { runGroupId: group.runGroupId })).toHaveLength(2);
  });

  it("cancel aborts in-flight streams and records 'Cancelled by user' rows", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-slow"]);
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Hi" });
    const events: AiRunProgressEvent[] = [];
    let cancelResult = false;
    const group = await runModelGroup(
      deps,
      {
        promptId: prompt.id,
        content: "Hi",
        variables: {},
        modelRefs: [{ providerId, modelId: "model-slow" }],
      },
      (event) => {
        events.push(event);
        if (event.phase === "delta") cancelResult = cancelRunGroup(event.runGroupId);
      },
    );

    expect(cancelResult).toBe(true);
    expect(group.runs[0]!.status).toBe("error");
    expect(group.runs[0]!.error).toBe("Cancelled by user");
    // The cancellation is persisted as an error row on the group.
    const rows = deps.lib.listRuns(prompt.id, { runGroupId: group.runGroupId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.error).toBe("Cancelled by user");
    // Terminal event is an error carrying the message.
    expect(events[0]!.phase).toBe("queued");
    const last = events.at(-1)!;
    expect(last.phase).toBe("error");
    expect(last.error).toBe("Cancelled by user");
    // After settling, the group is no longer cancellable.
    expect(cancelRunGroup(group.runGroupId)).toBe(false);
  });

  it("cancel works in the queued window, before the first token", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-slow"]);
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Hi" });
    let cancelResult = false;
    const group = await runModelGroup(
      deps,
      {
        promptId: prompt.id,
        content: "Hi",
        variables: {},
        modelRefs: [{ providerId, modelId: "model-slow" }],
      },
      (event) => {
        // The queued event arrives at request time — before any token.
        if (event.phase === "queued") cancelResult = cancelRunGroup(event.runGroupId);
      },
    );

    expect(cancelResult).toBe(true);
    expect(group.runs[0]!.status).toBe("error");
    expect(group.runs[0]!.error).toBe("Cancelled by user");
    const rows = deps.lib.listRuns(prompt.id, { runGroupId: group.runGroupId });
    expect(rows[0]!.error).toBe("Cancelled by user");
  });

  it("discards a late result when its version is deleted during the run", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-slow"]);
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "v1" });
    const historicalVersionId = prompt.current_version_id!;
    const mainBranch = deps.lib.listBranches(prompt.id)[0]!;
    deps.lib.createVersion({ promptId: prompt.id, branchId: mainBranch.id, content: "v2" });
    const events: AiRunProgressEvent[] = [];
    let deleted = false;

    const run = runModelGroup(
      deps,
      {
        promptId: prompt.id,
        versionId: historicalVersionId,
        content: "v1",
        variables: {},
        modelRefs: [{ providerId, modelId: "model-slow" }],
      },
      (event) => {
        events.push(event);
        if (!deleted && event.phase === "delta") {
          deleted = true;
          deps.lib.deleteVersion(historicalVersionId);
        }
      },
    );

    await expect(run).rejects.toThrow(/version was deleted/i);
    expect(deleted).toBe(true);
    expect(events.at(-1)).toMatchObject({
      phase: "error",
      error: expect.stringMatching(/version was deleted/i),
    });
    expect(deps.lib.listRuns(prompt.id)).toEqual([]);
  });

  it("does not return results that completed before the running version was deleted", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps, ["model-a", "model-slow"]);
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "v1" });
    const historicalVersionId = prompt.current_version_id!;
    const mainBranch = deps.lib.listBranches(prompt.id)[0]!;
    deps.lib.createVersion({ promptId: prompt.id, branchId: mainBranch.id, content: "v2" });
    let deleted = false;

    const run = runModelGroup(
      deps,
      {
        promptId: prompt.id,
        versionId: historicalVersionId,
        content: "v1",
        variables: {},
        modelRefs: [
          { providerId, modelId: "model-a" },
          { providerId, modelId: "model-slow" },
        ],
      },
      (event) => {
        if (!deleted && event.modelId === "model-a" && event.phase === "completed") {
          deleted = true;
          deps.lib.deleteVersion(historicalVersionId);
        }
      },
    );

    await expect(run).rejects.toThrow(/version was deleted/i);
    expect(deleted).toBe(true);
    expect(deps.lib.listRuns(prompt.id)).toEqual([]);
  });

  it("cancelRunGroup returns false for unknown groups", () => {
    expect(cancelRunGroup("no-such-group")).toBe(false);
  });
});

describe("runAssist", () => {
  it("generate mode returns text without DB writes", async () => {
    const deps = makeDeps();
    const providerId = addStubProvider(deps);
    const result = await runAssist(deps, {
      mode: "generate",
      description: "a prompt that summarizes tickets",
      providerId,
      modelId: "model-a",
    });
    expect(result.text).toMatch(/^ok:/);
    // No runs recorded for assist.
    expect(deps.lib.listProviders()[0]!.id).toBe(providerId);
    expect(deps.lib.listRunGroups("anything")).toEqual([]);
  });
});

describe("substituteVariables", () => {
  it("substitutes known variables and leaves unknown placeholders intact", () => {
    expect(substituteVariables("Hi {{name}}, you are {{ role }}", { name: "Ada", role: "admin" })).toBe(
      "Hi Ada, you are admin",
    );
    expect(substituteVariables("Hi {{name}} from {{place}}", { name: "Ada" })).toBe("Hi Ada from {{place}}");
  });
});

describe("catalog-backed model availability", () => {
  const catalogFixture = parseCatalog({
    openai: {
      id: "openai",
      env: ["OPENAI_API_KEY"],
      models: {
        "gpt-4o-mini": {
          id: "gpt-4o-mini",
          name: "GPT-4o mini",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 128000, output: 16384 },
          cost: { input: 0.15, output: 0.6 },
        },
      },
    },
  });

  /** An openai-typed provider pointed at the local stub server. */
  async function addCatalogProvider(deps: AiServiceDeps): Promise<string> {
    const provider = createProvider(deps, {
      type: "openai",
      name: "OpenAI stub",
      apiKey: "sk-test",
      baseUrl,
    });
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => catalogFixture });
    return provider.id;
  }

  it("runs catalog models without any provider_models rows", async () => {
    const deps = makeDeps();
    const providerId = await addCatalogProvider(deps);
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Hi" });
    const group = await runModelGroup(deps, {
      promptId: prompt.id,
      content: "Hi",
      variables: {},
      modelRefs: [{ providerId, modelId: "gpt-4o-mini" }],
    });
    expect(group.runs[0]!.status).toBe("completed");
    expect(group.runs[0]!.costUsd).not.toBeNull();
  });

  it("rejects unknown catalog models and models hidden via provider_models", async () => {
    const deps = makeDeps();
    const providerId = await addCatalogProvider(deps);
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Hi" });
    const base = { promptId: prompt.id, content: "Hi", variables: {} };

    await expect(
      runModelGroup(deps, { ...base, modelRefs: [{ providerId, modelId: "gpt-9000" }] }),
    ).rejects.toThrow(/not in the model catalog/);

    setModelHidden(deps, { providerId, modelId: "gpt-4o-mini", hidden: true });
    await expect(
      runModelGroup(deps, { ...base, modelRefs: [{ providerId, modelId: "gpt-4o-mini" }] }),
    ).rejects.toThrow(/hidden/);
    await expect(
      runAssist(deps, { mode: "generate", description: "x", providerId, modelId: "gpt-4o-mini" }),
    ).rejects.toThrow(/hidden/);

    // Unhiding makes the catalog model runnable again.
    setModelHidden(deps, { providerId, modelId: "gpt-4o-mini", hidden: false });
    const group = await runModelGroup(deps, {
      ...base,
      modelRefs: [{ providerId, modelId: "gpt-4o-mini" }],
    });
    expect(group.runs[0]!.status).toBe("completed");
  });

  it("rejects undeclared models when no catalog is cached yet", async () => {
    const deps = makeDeps();
    const provider = createProvider(deps, { type: "openai", name: "OpenAI stub", apiKey: "sk-test", baseUrl });
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Hi" });
    await expect(
      runModelGroup(deps, {
        promptId: prompt.id,
        content: "Hi",
        variables: {},
        modelRefs: [{ providerId: provider.id, modelId: "gpt-4o-mini" }],
      }),
    ).rejects.toThrow(/no model catalog is cached yet/);
  });
});

describe("environment key detection", () => {
  it("reports booleans only, driven by the registry env var hints without a catalog", () => {
    const deps = makeDeps();
    const result = detectEnvKeys(deps.lib, { OPENAI_API_KEY: "sk-secret", ANTHROPIC_API_KEY: "  " });
    expect(result).toEqual({ openai: true, anthropic: false, google: false, "openai-compatible": false });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("detects env keys across the whole cached catalog, not just native types", async () => {
    const deps = makeDeps();
    const fixture = parseCatalog({
      groq: {
        id: "groq",
        name: "Groq",
        env: ["GROQ_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.groq.com/openai/v1",
        models: { "llama-3.1-8b-instant": { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant" } },
      },
      openrouter: {
        id: "openrouter",
        name: "OpenRouter",
        env: ["OPENROUTER_API_KEY"],
        api: "https://openrouter.ai/api/v1",
        models: { "openai/gpt-4o": { id: "openai/gpt-4o", name: "GPT-4o" } },
      },
    });
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => fixture });
    const result = detectEnvKeys(deps.lib, { GROQ_API_KEY: "gsk_secret" });
    expect(result).toEqual({ groq: true, openrouter: false });
    expect(JSON.stringify(result)).not.toContain("gsk_secret");
  });
});

describe("connectEnvProvider", () => {
  it("does not trust environment names or endpoints supplied by a library import", async () => {
    const deps = makeDeps();
    const crafted = deps.lib.exportLibrary();
    const poisonedCatalog = parseCatalog({
      imported: {
        id: "imported",
        name: "Imported provider",
        env: ["AWS_SECRET_ACCESS_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: baseUrl,
        models: { "model-a": { id: "model-a", name: "Model A" } },
      },
    });
    crafted.tables.settings.push({
      key: "model_catalog",
      value: JSON.stringify({
        fetchedAt: "2026-09-03T00:00:00.000Z",
        json: JSON.stringify(poisonedCatalog),
      }),
    });
    deps.lib.importLibrary(crafted);
    const requestCount = seenUrls.length;

    await expect(
      connectEnvProvider(
        { ...deps, env: { AWS_SECRET_ACCESS_KEY: "high-value-secret" } },
        { catalogId: "imported", modelId: "model-a" },
      ),
    ).rejects.toThrow(/no environment variable convention/);

    expect(deps.lib.listProviders()).toEqual([]);
    expect(seenUrls).toHaveLength(requestCount);
  });

  it("does not give a legacy unprovenanced catalog authority over environment keys", async () => {
    const deps = makeDeps();
    const poisonedCatalog = parseCatalog({
      imported: {
        id: "imported",
        name: "Imported provider",
        env: ["AWS_SECRET_ACCESS_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: baseUrl,
        models: { "model-a": { id: "model-a", name: "Model A" } },
      },
    });
    deps.lib.setCatalogCache(JSON.stringify(poisonedCatalog));
    const requestCount = seenUrls.length;

    await expect(
      connectEnvProvider(
        { ...deps, env: { AWS_SECRET_ACCESS_KEY: "high-value-secret" } },
        { catalogId: "imported", modelId: "model-a" },
      ),
    ).rejects.toThrow(/no environment variable convention/);

    expect(deps.lib.listProviders()).toEqual([]);
    expect(seenUrls).toHaveLength(requestCount);
  });

  it("does not let imported native drivers fall back to process environment keys", async () => {
    vi.stubEnv("OPENAI_API_KEY", "process-fallback-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "process-fallback-secret");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "process-fallback-secret");
    const deps = makeDeps();
    const crafted = deps.lib.exportLibrary();
    const nativeDrivers = ["openai", "anthropic", "google"] as const;
    crafted.tables.providers = nativeDrivers.map((driver) => ({
      id: `imported-${driver}`,
      type: "openai-compatible",
      driver,
      name: `Imported ${driver} route`,
      api_key_enc: null,
      base_url: baseUrl,
      enabled: 1,
      created_at: "2026-09-03T00:00:00.000Z",
    }));
    crafted.tables.provider_models = nativeDrivers.map((driver) => ({
      provider_id: `imported-${driver}`,
      model_id: "model-a",
      display_name: "Model A",
      enabled: 1,
    }));
    deps.lib.importLibrary(crafted);
    const requestCount = seenUrls.length;

    for (const driver of nativeDrivers) {
      expect(await testProvider(deps, `imported-${driver}`, "model-a")).toMatchObject({
        ok: false,
        error: expect.stringMatching(/stored API key/),
      });
    }
    expect(seenUrls).toHaveLength(requestCount);
  });

  it("creates a provider from the env key and auto-tests it", async () => {
    const deps = makeDeps();
    const testImpl = vi.fn(async () => ({ ok: true }));
    const result = await connectEnvProvider(
      { ...deps, env: { OPENAI_API_KEY: "sk-env" }, testImpl },
      { catalogId: "openai" },
    );
    expect(result.provider.name).toBe("OpenAI");
    expect(result.provider.driver).toBe("openai");
    expect(result.provider.hasApiKey).toBe(true);
    expect(result.test).toEqual({ ok: true });
    expect(testImpl).toHaveBeenCalledWith(result.provider.id);
    const row = deps.lib.getProvider(result.provider.id)!;
    expect(stubCipher.decrypt(row.api_key_enc!)).toBe("sk-env");
    // No key material crosses the DTO boundary.
    expect(JSON.stringify(result)).not.toContain("sk-env");
  });

  it("auto-tests an environment key with the user's chosen model", async () => {
    const deps = makeDeps();
    const testImpl = vi.fn(async () => ({ ok: true }));
    const result = await connectEnvProvider(
      { ...deps, env: { OPENAI_API_KEY: "sk-env" }, testImpl },
      { catalogId: "openai", modelId: "gpt-5-mini" },
    );

    expect(testImpl).toHaveBeenCalledWith(result.provider.id, "gpt-5-mini");
  });

  it("connects a long-tail catalog provider from the env key, with catalog base URL", async () => {
    const deps = makeDeps();
    const fixture = parseCatalog({
      groq: {
        id: "groq",
        name: "Groq",
        env: ["GROQ_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.groq.com/openai/v1",
        models: { "llama-3.1-8b-instant": { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant" } },
      },
    });
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => fixture });
    const result = await connectEnvProvider(
      { ...deps, env: { GROQ_API_KEY: "gsk_env" }, testImpl: async () => ({ ok: true }) },
      { catalogId: "groq" },
    );
    expect(result.provider.name).toBe("Groq");
    expect(result.provider.type).toBe("groq");
    expect(result.provider.driver).toBe("openai-compatible");
    expect(result.provider.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(JSON.stringify(result)).not.toContain("gsk_env");
  });

  it("falls back to the built-in base URL when the catalog entry has none", async () => {
    const deps = makeDeps();
    const fixture = parseCatalog({
      xai: {
        id: "xai",
        name: "xAI",
        env: ["XAI_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        models: { "grok-4": { id: "grok-4", name: "Grok 4" } },
      },
    });
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => fixture });
    const result = await connectEnvProvider(
      { ...deps, env: { XAI_API_KEY: "xai_env" }, testImpl: async () => ({ ok: true }) },
      { catalogId: "xai" },
    );
    expect(result.provider.driver).toBe("openai-compatible");
    expect(result.provider.baseUrl).toBe("https://api.x.ai/v1");
    expect(JSON.stringify(result)).not.toContain("xai_env");
  });

  it("keeps the provider saved when the auto-test fails", async () => {
    const deps = makeDeps();
    const result = await connectEnvProvider(
      { ...deps, env: { ANTHROPIC_API_KEY: "bad-key" }, testImpl: async () => ({ ok: false, error: "HTTP 401" }) },
      { catalogId: "anthropic" },
    );
    expect(result.test).toEqual({ ok: false, error: "HTTP 401" });
    expect(deps.lib.getProvider(result.provider.id)).not.toBeNull();
  });

  it("refuses missing keys, keyless types and duplicate types", async () => {
    const deps = makeDeps();
    const testImpl = async () => ({ ok: true });
    await expect(connectEnvProvider({ ...deps, env: {} }, { catalogId: "openai" })).rejects.toThrow(
      /OPENAI_API_KEY is not set/,
    );
    await expect(connectEnvProvider({ ...deps, env: {} }, { catalogId: "openai-compatible" })).rejects.toThrow(
      /no environment variable convention/,
    );
    await connectEnvProvider({ ...deps, env: { OPENAI_API_KEY: "k" }, testImpl }, { catalogId: "openai" });
    await expect(
      connectEnvProvider({ ...deps, env: { OPENAI_API_KEY: "k" }, testImpl }, { catalogId: "openai" }),
    ).rejects.toThrow(/already connected/);
  });

  it("joins near-simultaneous calls for the same catalog id (single-flight)", async () => {
    const deps = makeDeps();
    let releaseTest!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTest = resolve;
    });
    const testImpl = vi.fn(async () => {
      await gate;
      return { ok: true };
    });
    const env = { OPENAI_API_KEY: "sk-env" };
    const first = connectEnvProvider({ ...deps, env, testImpl }, { catalogId: "openai" });
    const second = connectEnvProvider({ ...deps, env, testImpl }, { catalogId: "openai" });
    releaseTest();
    const [a, b] = await Promise.all([first, second]);
    // The second call awaited the first instead of racing the duplicate check.
    expect(a.provider.id).toBe(b.provider.id);
    expect(deps.lib.listProviders()).toHaveLength(1);
    expect(testImpl).toHaveBeenCalledTimes(1);
  });

  it("cleans the in-flight entry when the attempt rejects, so a retry proceeds", async () => {
    const deps = makeDeps();
    await expect(connectEnvProvider({ ...deps, env: {} }, { catalogId: "openai" })).rejects.toThrow(
      /OPENAI_API_KEY is not set/,
    );
    // A leftover in-flight entry would replay the rejected promise here.
    const retry = await connectEnvProvider(
      { ...deps, env: { OPENAI_API_KEY: "sk-retry" }, testImpl: async () => ({ ok: true }) },
      { catalogId: "openai" },
    );
    expect(retry.provider.hasApiKey).toBe(true);
    expect(deps.lib.listProviders()).toHaveLength(1);
  });
});

describe("generic catalog providers (long tail via openai-compatible driver)", () => {
  const groqFixture = parseCatalog({
    groq: {
      id: "groq",
      name: "Groq",
      env: ["GROQ_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.groq.com/openai/v1",
      models: {
        "model-a": {
          id: "model-a",
          name: "Model A",
          limit: { context: 128000, output: 8192 },
          cost: { input: 0.5, output: 1 },
        },
      },
    },
    v0: {
      id: "v0",
      name: "v0",
      env: ["V0_API_KEY"],
      npm: "@ai-sdk/vercel",
      models: { "v0-md": { id: "v0-md", name: "v0-md" } },
    },
  });

  async function depsWithCatalog(): Promise<AiServiceDeps & { lib: PromptLibrary }> {
    const deps = makeDeps();
    await refreshCatalog({ ...deps, fetchCatalogImpl: async () => groqFixture });
    return deps;
  }

  it("creates a long-tail provider with the openai-compatible driver and runs its catalog models", async () => {
    const deps = await depsWithCatalog();
    const provider = createProvider(deps, { type: "groq", name: "Groq", apiKey: "gsk", baseUrl });
    expect(provider.type).toBe("groq");
    expect(provider.driver).toBe("openai-compatible");

    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Hi" });
    const group = await runModelGroup(deps, {
      promptId: prompt.id,
      content: "Hi",
      variables: {},
      modelRefs: [{ providerId: provider.id, modelId: "model-a" }],
    });
    expect(group.runs[0]!.status).toBe("completed");
    expect(group.runs[0]!.output).toBe("ok:Hi");
    expect(group.runs[0]!.costUsd).not.toBeNull();

    // The provider name keeps resolving in run groups after a rename.
    updateProvider(deps, { id: provider.id, patch: { name: "Groq renamed" } });
    expect(deps.lib.listRunGroups(prompt.id)[0]!.runs[0]!.providerName).toBe("Groq renamed");
  });

  it("serves connectable catalog providers and filters ones without an api URL", async () => {
    const deps = await depsWithCatalog();
    const dto = getCatalog(deps.lib)!;
    expect(dto.providers.map((p) => p.id)).toEqual(["groq"]); // v0 has no api → filtered
    expect(dto.providers[0]).toMatchObject({
      name: "Groq",
      env: ["GROQ_API_KEY"],
      api: "https://api.groq.com/openai/v1",
      modelCount: 1,
      popular: false,
      driver: "openai-compatible",
    });
    expect(dto.models["groq"]).toHaveLength(1);
  });

  it("rejects unknown catalog ids and missing base URLs", async () => {
    const deps = await depsWithCatalog();
    expect(() => createProvider(deps, { type: "grq", name: "typo", apiKey: "k", baseUrl })).toThrow(
      /Unknown catalog provider/,
    );
    expect(() => createProvider(deps, { type: "v0", name: "v0", apiKey: "k" })).toThrow(/requires a base URL/);
    expect(() => createProvider(deps, { type: "openai-compatible", name: "custom", apiKey: "k" })).toThrow(
      /require a base URL/,
    );
  });

  it("gates runs on hidden models and on the provider master toggle", async () => {
    const deps = await depsWithCatalog();
    const provider = createProvider(deps, { type: "groq", name: "Groq", apiKey: "gsk", baseUrl });
    const prompt = deps.lib.createPrompt({ title: "Greet", content: "Hi" });
    const base = { promptId: prompt.id, content: "Hi", variables: {} };

    setModelHidden(deps, { providerId: provider.id, modelId: "model-a", hidden: true });
    await expect(
      runModelGroup(deps, { ...base, modelRefs: [{ providerId: provider.id, modelId: "model-a" }] }),
    ).rejects.toThrow(/hidden/);
    setModelHidden(deps, { providerId: provider.id, modelId: "model-a", hidden: false });

    updateProvider(deps, { id: provider.id, patch: { enabled: false } });
    await expect(
      runModelGroup(deps, { ...base, modelRefs: [{ providerId: provider.id, modelId: "model-a" }] }),
    ).rejects.toThrow(/disabled/);
  });

  it("auto-tests a generic provider against its declared model", async () => {
    const deps = await depsWithCatalog();
    const provider = createProvider(deps, { type: "groq", name: "Groq", apiKey: "gsk", baseUrl });
    deps.lib.setProviderModels(provider.id, [{ modelId: "model-a" }]);
    expect(await testProvider(deps, provider.id)).toEqual({ ok: true });
  });
});
