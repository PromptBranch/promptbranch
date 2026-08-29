/**
 * Prompt execution over the AI SDK. Raw SDK errors never cross this boundary:
 * everything is normalized to { message, code? }.
 */
import { generateText, streamText, type LanguageModel } from "ai";

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface RunPromptRequest {
  model: LanguageModel;
  prompt: string;
  maxOutputTokens?: number;
  /** AI SDK retry attempts on retryable failures (default: SDK default). */
  maxRetries?: number;
  /** Cancellation/timeout signal (e.g. AbortSignal.timeout(120_000)). */
  signal?: AbortSignal;
}

export interface RunPromptResult {
  text: string;
  usage: TokenUsage;
  latencyMs: number;
}

/** Normalized error shape returned to callers instead of raw SDK errors. */
export interface NormalizedError {
  message: string;
  code?: string;
}

/** Error thrown by runPrompt; carries the normalized shape. */
export class PromptRunError extends Error implements NormalizedError {
  readonly code?: string;
  constructor(normalized: NormalizedError) {
    super(normalized.message);
    this.name = "PromptRunError";
    if (normalized.code !== undefined) this.code = normalized.code;
  }
}

/**
 * Deepest useful message on the `.cause` chain (walked up to 3 levels), or
 * null. A message that the top-level error already includes adds nothing.
 */
function rootCauseMessage(error: Error): string | null {
  let cause: unknown = (error as { cause?: unknown }).cause;
  let message: string | null = null;
  for (let depth = 0; depth < 3 && cause instanceof Error; depth++) {
    if (!error.message.includes(cause.message)) message = cause.message;
    cause = (cause as { cause?: unknown }).cause;
  }
  return message;
}

/** Converts any thrown value into a { message, code? } pair. */
export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof PromptRunError) {
    return error.code !== undefined ? { message: error.message, code: error.code } : { message: error.message };
  }
  if (error instanceof Error) {
    const extra = error as Error & { statusCode?: unknown; code?: unknown };
    const status = typeof extra.statusCode === "number" ? extra.statusCode : undefined;
    const cause = rootCauseMessage(error);
    const causeMessage = cause !== null ? `: ${cause}` : "";
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return { message: "Request aborted (timeout or cancellation)", code: "aborted" };
    }
    if (status !== undefined) {
      return {
        message: `Provider request failed (HTTP ${status}): ${error.message}${causeMessage}`,
        code: `http-${status}`,
      };
    }
    if (typeof extra.code === "string") {
      return { message: `${error.message}${causeMessage}`, code: extra.code };
    }
    return { message: `${error.message}${causeMessage}` };
  }
  return { message: String(error) };
}

/** Runs a single prompt; throws PromptRunError on failure. */
export async function runPrompt(request: RunPromptRequest): Promise<RunPromptResult> {
  const startedAt = performance.now();
  try {
    const result = await generateText({
      model: request.model,
      prompt: request.prompt,
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
      ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
    });
    return {
      text: result.text,
      usage: {
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
      },
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    throw new PromptRunError(normalizeError(error));
  }
}

export interface StreamPromptRequest extends RunPromptRequest {
  /**
   * Called with the text accumulated so far (not just the delta) as tokens
   * stream in. Errors thrown here abort the stream.
   */
  onDelta?: (accumulated: string) => void;
}

/**
 * Streaming counterpart of runPrompt: consumes the AI SDK fullStream,
 * reports accumulated text via onDelta, and resolves with the same result
 * shape. Mid-stream error parts and aborts normalize like runPrompt errors.
 */
export async function streamPrompt(request: StreamPromptRequest): Promise<RunPromptResult> {
  const startedAt = performance.now();
  let text = "";
  try {
    const result = streamText({
      model: request.model,
      prompt: request.prompt,
      // fullStream below surfaces the same error to our normalized boundary.
      // Avoid the SDK default handler dumping the raw provider error first.
      onError: () => undefined,
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
      ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
    });
    // fullStream (not textStream) so mid-stream provider errors surface.
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        text += part.text;
        request.onDelta?.(text);
      } else if (part.type === "error") {
        throw part.error;
      }
    }
    // The stream may end quietly on abort — report cancellation explicitly.
    if (request.signal?.aborted) {
      throw new PromptRunError({ message: "Request aborted (timeout or cancellation)", code: "aborted" });
    }
    const usage = await result.totalUsage;
    return {
      text,
      usage: {
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
      },
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    throw new PromptRunError(normalizeError(error));
  }
}

export type SettledRunResult =
  | { status: "fulfilled"; value: RunPromptResult }
  | { status: "rejected"; reason: NormalizedError };
/**
 * Runs several prompts concurrently; results preserve input order and never
 * throw — failures arrive as rejected entries with normalized errors.
 */
export async function runPromptMany(requests: RunPromptRequest[]): Promise<SettledRunResult[]> {
  const settled = await Promise.allSettled(requests.map((request) => runPrompt(request)));
  return settled.map((entry): SettledRunResult => {
    if (entry.status === "fulfilled") return { status: "fulfilled", value: entry.value };
    return { status: "rejected", reason: normalizeError(entry.reason) };
  });
}
