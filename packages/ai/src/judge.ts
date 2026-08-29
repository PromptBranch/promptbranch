/**
 * LLM-as-judge: a model scores a run's output against the prompt that
 * produced it. The verdict is strict JSON validated against judgeVerdictSchema
 * — structured output via the AI SDK's generateObject, with one
 * parse-and-validate retry when the model answers with malformed JSON.
 */
import { generateObject, NoObjectGeneratedError, type LanguageModel } from "ai";
import { z } from "zod";
import { stripWrappingFences } from "./assist.js";
import { normalizeError, PromptRunError, runPrompt } from "./run.js";

/** The four scoring dimensions plus a one-sentence rationale, each 1–5. */
export const judgeVerdictSchema = z.object({
  effectiveness: z.number().min(1).max(5),
  clarity: z.number().min(1).max(5),
  completeness: z.number().min(1).max(5),
  actionability: z.number().min(1).max(5),
  rationale: z.string().trim().min(1).max(2_000),
});
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

// The average lives in ./judge-average.js (SDK-free leaf the renderer can import).
export { judgeAverage } from "./judge-average.js";

export interface JudgeRequest {
  model: LanguageModel;
  /** The prompt content the judged run executed. */
  promptContent: string;
  /** The run's output text. */
  output: string;
  /** Optional user criteria ("What makes a good response?"). */
  criteria?: string;
  /** Cancellation/timeout signal (e.g. AbortSignal.timeout(60_000)). */
  signal?: AbortSignal;
}

/**
 * Builds the judge meta-prompt. Output shape is spelled out explicitly so the
 * parse-and-validate fallback works even when the provider cannot do
 * structured output natively.
 */
export function buildJudgePrompt(input: Omit<JudgeRequest, "model" | "signal">): string {
  const criteria = input.criteria?.trim();
  return `You are a strict evaluator judging how well a model's response answers the given prompt.

Score the response on four dimensions, each an integer from 1 (poor) to 5 (excellent):
- effectiveness: does the response accomplish what the prompt asks for?
- clarity: is the response clear, well-organized, and easy to follow?
- completeness: does the response cover all parts of the prompt without gaps?
- actionability: can the user act on the response directly, without rework?
${criteria ? `\nAdditionally weigh these user criteria: ${criteria}\n` : ""}
Prompt:
"""
${input.promptContent.trim()}
"""

Response to judge:
"""
${input.output.trim()}
"""

Respond with ONLY a JSON object of this exact shape — no explanations, no markdown fences:
{"effectiveness":1-5,"clarity":1-5,"completeness":1-5,"actionability":1-5,"rationale":"one sentence"}`;
}

/** Extracts and validates the verdict JSON from a free-form judge reply. */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const stripped = stripWrappingFences(text.trim());
  // Models sometimes pad the object with prose — take the outermost braces.
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Judge response contained no JSON object");
  return judgeVerdictSchema.parse(JSON.parse(stripped.slice(start, end + 1)));
}

/**
 * Judges one run output. Primary path: generateObject (the SDK validates the
 * parsed object against the zod schema). When the model's reply cannot be
 * parsed/validated (NoObjectGeneratedError), retry once with a plain text
 * generation and manual extraction. Everything else (HTTP, auth, abort)
 * throws immediately, normalized like runPrompt errors.
 */
export async function runJudge(request: JudgeRequest): Promise<JudgeVerdict> {
  const prompt = buildJudgePrompt(request);
  try {
    const result = await generateObject({
      model: request.model,
      schema: judgeVerdictSchema,
      prompt,
      ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
    });
    return result.object;
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) {
      throw new PromptRunError(normalizeError(error));
    }
  }
  try {
    const { text } = await runPrompt({
      model: request.model,
      prompt,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    return parseJudgeVerdict(text);
  } catch (error) {
    if (error instanceof PromptRunError) throw error;
    throw new PromptRunError({ message: "Judge returned malformed JSON" });
  }
}
