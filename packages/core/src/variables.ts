export type PromptVariableValue = string | number | boolean;

const PROMPT_VARIABLE_PATTERN = /\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}/gu;

/** Variable names in first-appearance order, with repeated placeholders collapsed. */
export function extractPromptVariables(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(PROMPT_VARIABLE_PATTERN)) {
    const name = match[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
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
  return content.replace(PROMPT_VARIABLE_PATTERN, (raw, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]!) : raw,
  );
}
