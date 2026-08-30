/**
 * Prompt templates for AI-assisted authoring. These are meta-prompts sent to a
 * model on the user's behalf — keep them short, explicit about output shape,
 * and free of anything that would invite preamble or fences.
 */

/** Builds the meta-prompt that drafts a new prompt from a goal description. */
export function buildGeneratePrompt(description: string): string {
  return `You are an expert prompt engineer. Write a single high-quality prompt that accomplishes the goal described below.

The prompt you write must:
- Be ready to use as-is, with clear instructions, context, constraints, and expected output format.
- Use {{variable}} placeholders for any inputs the user must supply each time.
- Be concise but complete; no commentary about the prompt itself.

Goal:
${description.trim()}

Respond with ONLY the prompt text — no explanations, no titles, no markdown fences.`;
}

/** Builds the meta-prompt that rewrites an existing prompt per an instruction. */
export function buildImprovePrompt(currentContent: string, instruction: string): string {
  return `You are an expert prompt engineer. Improve the prompt below according to the instruction.

Rules:
- Keep any {{variable}} placeholders intact unless the instruction says otherwise.
- Apply the instruction precisely; do not change anything else unnecessarily.
- Preserve the prompt's intent and language.

Instruction:
${instruction.trim()}

Current prompt:
"""
${currentContent.trim()}
"""

Respond with ONLY the improved prompt text — no explanations, no titles, no markdown fences.`;
}

/**
 * Post-processing for improve/generate results: trims whitespace and strips a
 * single wrapping markdown code fence if the model added one anyway.
 */
export function stripWrappingFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z0-9-]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}
