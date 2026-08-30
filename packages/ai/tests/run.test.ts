import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PromptRunError,
  createProviderModel,
  normalizeError,
  runPrompt,
  runPromptMany,
  streamPrompt,
} from "../src/index.js";

/**
 * Local stub of an OpenAI-compatible /chat/completions endpoint. No real
 * network or API keys involved; the openai-compatible provider is pointed at
 * 127.0.0.1.
 */
let server: http.Server;
let baseUrl: string;
let lastAuthHeader: string | null = null;

function chatCompletion(model: string, text: string) {
  return {
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  };
}

/** One OpenAI chat-completions SSE chunk (streaming responses). */
function sseChunk(model: string, body: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-stub",
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
      sseChunk(model, {
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }),
    );
    res.end("data: [DONE]\n\n");
  }, intervalMs);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      lastAuthHeader = req.headers.authorization ?? null;
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { model: string; messages?: unknown; stream?: boolean };
        if (parsed.stream) {
          if (parsed.model === "stub-stream-http-error") {
            res.statusCode = 429;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: { message: "Synthetic rate limit", type: "rate_limit" } }));
            return;
          }
          if (parsed.model === "stub-stream-slow") {
            // Slow stream for the abort test: many chunks, 40ms apart.
            streamPieces(res, parsed.model, Array.from({ length: 20 }, (_, i) => `chunk-${i} `), 40);
            return;
          }
          if (parsed.model === "stub-stream-fail") {
            // Mid-stream failure: one chunk, then the connection dies.
            res.setHeader("content-type", "text/event-stream");
            res.write(
              sseChunk(parsed.model, {
                choices: [{ index: 0, delta: { role: "assistant", content: "partial " }, finish_reason: null }],
              }),
            );
            setTimeout(() => res.socket?.destroy(), 20);
            return;
          }
          streamPieces(res, parsed.model, ["stub ", "says ", "ok"]);
          return;
        }
        res.setHeader("content-type", "application/json");
        if (parsed.model === "stub-fail") {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { message: "Invalid API key", type: "auth_error" } }));
          return;
        }
        res.end(JSON.stringify(chatCompletion(parsed.model, `stub says ok for ${parsed.model}`)));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("runPrompt against a stub OpenAI-compatible server", () => {
  it("returns text, usage and latency", async () => {
    const model = createProviderModel(
      { driver: "openai-compatible", baseUrl, apiKey: "stub-key" },
      "stub-model",
    );
    const result = await runPrompt({ model, prompt: "Reply with: ok" });
    expect(result.text).toBe("stub says ok for stub-model");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // The configured API key was actually sent.
    expect(lastAuthHeader).toBe("Bearer stub-key");
  });

  it("normalizes provider HTTP errors into PromptRunError", async () => {
    const model = createProviderModel({ driver: "openai-compatible", baseUrl, apiKey: "bad" }, "stub-fail");
    const error = await runPrompt({ model, prompt: "hi" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PromptRunError);
    const normalized = error as PromptRunError;
    expect(normalized.code).toBe("http-401");
    expect(normalized.message).toMatch(/HTTP 401/);
    expect(normalized.message).toMatch(/Invalid API key/);
  });

  it("normalizes connection-refused network errors", async () => {
    const model = createProviderModel(
      { driver: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", apiKey: "x" },
      "stub-model",
    );
    // maxRetries: 0 — the SDK's default retry backoff costs ~6s otherwise.
    const error = await runPrompt({ model, prompt: "hi", maxRetries: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PromptRunError);
    expect((error as PromptRunError).message.length).toBeGreaterThan(0);
  });

  it("honors the abort signal", async () => {
    const model = createProviderModel({ driver: "openai-compatible", baseUrl, apiKey: "x" }, "stub-model");
    const controller = new AbortController();
    controller.abort();
    const error = await runPrompt({ model, prompt: "hi", signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PromptRunError);
    expect((error as PromptRunError).code).toBe("aborted");
  });
});

describe("runPromptMany", () => {
  it("preserves input order and settles every request", async () => {
    const make = (modelId: string) => ({
      model: createProviderModel({ driver: "openai-compatible", baseUrl, apiKey: "k" }, modelId),
      prompt: "hi",
    });
    const results = await runPromptMany([make("a-model"), make("stub-fail"), make("c-model")]);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { text: "stub says ok for a-model" } });
    expect(results[1]!.status).toBe("rejected");
    expect((results[1] as { reason: { code?: string } }).reason.code).toBe("http-401");
    expect(results[2]).toMatchObject({ status: "fulfilled", value: { text: "stub says ok for c-model" } });
  });
});

describe("streamPrompt against a stub streaming server", () => {
  it("streams deltas in order and aggregates full text + usage", async () => {
    const model = createProviderModel(
      { driver: "openai-compatible", baseUrl, apiKey: "stub-key" },
      "stub-model",
    );
    const snapshots: string[] = [];
    const result = await streamPrompt({
      model,
      prompt: "hi",
      onDelta: (accumulated) => snapshots.push(accumulated),
    });
    expect(result.text).toBe("stub says ok");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // Deltas arrive accumulated and in order, ending at the final text.
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    expect(snapshots).toEqual([...snapshots].sort((a, b) => a.length - b.length));
    expect(snapshots.at(-1)).toBe("stub says ok");
    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i]!.startsWith(snapshots[i - 1]!)).toBe(true);
    }
  });

  it("normalizes a mid-stream abort to an aborted PromptRunError", async () => {
    const model = createProviderModel(
      { driver: "openai-compatible", baseUrl, apiKey: "stub-key" },
      "stub-stream-slow",
    );
    const controller = new AbortController();
    const error = await streamPrompt({
      model,
      prompt: "hi",
      signal: controller.signal,
      onDelta: () => controller.abort(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PromptRunError);
    expect((error as PromptRunError).code).toBe("aborted");
  });

  it("normalizes a mid-stream connection failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const model = createProviderModel(
      { driver: "openai-compatible", baseUrl, apiKey: "stub-key" },
      "stub-stream-fail",
    );
    try {
      const error = await streamPrompt({ model, prompt: "hi", maxRetries: 0 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PromptRunError);
      expect((error as PromptRunError).message.length).toBeGreaterThan(0);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("normalizes an HTTP stream failure without dumping the raw SDK error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const model = createProviderModel(
      { driver: "openai-compatible", baseUrl, apiKey: "stub-key" },
      "stub-stream-http-error",
    );
    try {
      const error = await streamPrompt({ model, prompt: "hi", maxRetries: 0 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PromptRunError);
      expect((error as PromptRunError).message).toMatch(/HTTP 429/);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("normalizeError", () => {  it("passes PromptRunError through unchanged", () => {
    const original = new PromptRunError({ message: "boom", code: "x" });
    expect(normalizeError(original)).toEqual({ message: "boom", code: "x" });
  });

  it("handles non-Error values", () => {
    expect(normalizeError("string failure")).toEqual({ message: "string failure" });
    expect(normalizeError(undefined)).toEqual({ message: "undefined" });
  });

  it("walks the .cause chain to the deepest useful message", () => {
    const nested = new Error("Provider request failed", {
      cause: new Error("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1:11434") }),
    });
    expect(normalizeError(nested)).toEqual({
      message: "Provider request failed: ECONNREFUSED 127.0.0.1:11434",
    });
  });

  it("caps the .cause walk at 3 levels", () => {
    let error = new Error("root cause");
    for (const wrapper of ["l3", "l2", "l1", "top"]) {
      error = new Error(wrapper, { cause: error });
    }
    // Depth cap 3 walks top→l1→l2→l3, stopping short of the root cause.
    expect(normalizeError(error)).toEqual({ message: "top: l3" });
  });
});
