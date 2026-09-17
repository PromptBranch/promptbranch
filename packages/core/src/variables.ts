export type PromptVariableValue = string | number | boolean;

export const MAX_PROMPT_VARIABLES = 100;
export const MAX_PROMPT_VARIABLE_VALUE_LENGTH = 100_000;
export const MAX_PROMPT_VARIABLE_INPUT_LENGTH = 1_000_000;
export const MAX_RENDERED_PROMPT_LENGTH = 1_000_000;

export interface PromptVariableLimits {
  maxVariables?: number;
  maxValueLength?: number;
  maxInputLength?: number;
  maxRenderedLength?: number;
}

export type PromptVariableErrorCode =
  | "too-many-variables"
  | "variable-input-too-large"
  | "rendered-content-too-large";

export class PromptVariableError extends Error {
  constructor(readonly code: PromptVariableErrorCode, message: string) {
    super(message);
    this.name = "PromptVariableError";
  }
}

const PROMPT_VARIABLE_PATTERN = /\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}/gu;

/** Variable names in first-appearance order, with repeated placeholders collapsed. */
export function extractPromptVariables(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(PROMPT_VARIABLE_PATTERN)) {
    const name = match[1]!;
    names.add(name);
    if (names.size > MAX_PROMPT_VARIABLES) {
      throw new PromptVariableError("too-many-variables", `Prompt exceeds ${MAX_PROMPT_VARIABLES} variables.`);
    }
  }
  return [...names];
}

/** Required names that have no supplied value; an empty string remains unresolved. */
export function missingPromptVariables(
  content: string,
  values: Readonly<Record<string, PromptVariableValue>>,
): string[] {
  return extractPromptVariables(content).filter((name) => {
    if (!Object.hasOwn(values, name)) return true;
    return String(values[name]!).length === 0;
  });
}

/** Plain-text, single-pass substitution. Unknown placeholders remain unchanged. */
export function substitutePromptVariables(
  content: string,
  values: Readonly<Record<string, PromptVariableValue>>,
): string {
  return renderPromptVariablesBounded(content, values);
}

/** Checks UTF-16 lengths before retaining any replacement; values are never parsed as templates. */
export function renderPromptVariablesBounded(
  content: string,
  values: Readonly<Record<string, PromptVariableValue>>,
  limits: PromptVariableLimits = {},
): string {
  const maxVariables = limits.maxVariables ?? MAX_PROMPT_VARIABLES;
  const maxValueLength = limits.maxValueLength ?? MAX_PROMPT_VARIABLE_VALUE_LENGTH;
  const maxInputLength = limits.maxInputLength ?? MAX_PROMPT_VARIABLE_INPUT_LENGTH;
  const maxRenderedLength = limits.maxRenderedLength ?? MAX_RENDERED_PROMPT_LENGTH;
  const supplied = new Map<string, string>();
  let inputLength = 0;
  for (const name in values) {
    if (!Object.hasOwn(values, name)) continue;
    if (supplied.size >= maxVariables) {
      throw new PromptVariableError("too-many-variables", `Prompt exceeds ${maxVariables} supplied variables.`);
    }
    const value = String(values[name]!);
    inputLength += name.length + value.length;
    if (value.length > maxValueLength || inputLength > maxInputLength) {
      throw new PromptVariableError("variable-input-too-large", "Prompt variable input exceeds the character limit.");
    }
    supplied.set(name, value);
  }

  const names = new Set<string>();
  const segments: string[] = [];
  let end = 0;
  let renderedLength = 0;
  for (const match of content.matchAll(PROMPT_VARIABLE_PATTERN)) {
    const name = match[1]!;
    names.add(name);
    if (names.size > maxVariables) {
      throw new PromptVariableError("too-many-variables", `Prompt exceeds ${maxVariables} variables.`);
    }
    const replacement = supplied.get(name) ?? match[0];
    renderedLength += match.index - end + replacement.length;
    if (renderedLength > maxRenderedLength) {
      throw new PromptVariableError("rendered-content-too-large", `Rendered prompt exceeds ${maxRenderedLength} characters.`);
    }
    segments.push(content.slice(end, match.index), replacement);
    end = match.index + match[0].length;
  }
  if (renderedLength + content.length - end > maxRenderedLength) {
    throw new PromptVariableError("rendered-content-too-large", `Rendered prompt exceeds ${maxRenderedLength} characters.`);
  }
  segments.push(content.slice(end));
  return segments.join("");
}
