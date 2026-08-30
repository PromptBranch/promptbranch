/**
 * Per-prompt AI run preferences (last model selection, last variable values),
 * stored in localStorage alongside the global prefs in lib/prefs.ts. These
 * keys are dynamic (scoped by prompt id), so they live outside PrefsSchema;
 * components keep them in local state and persist on change — no store
 * subscription is needed.
 */

export interface ModelRef {
  providerId: string;
  modelId: string;
}

const PREFIX = "promptbuilder:pref:";

function read<T>(key: string, validate: (value: unknown) => T | null): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    return validate(JSON.parse(raw));
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // persistence is best-effort
  }
}

function asModelRefs(value: unknown): ModelRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs = value.filter(
    (v): v is ModelRef =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as ModelRef).providerId === "string" &&
      typeof (v as ModelRef).modelId === "string",
  );
  return refs.length === value.length ? refs : null;
}

function asVariables(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.values(value).every((v) => typeof v === "string")
    ? (value as Record<string, string>)
    : null;
}

/** Last model selection used to run this prompt; null when never run. */
export function getRunModelSelection(promptId: string): ModelRef[] | null {
  return read(`run-models:${promptId}`, asModelRefs);
}

export function setRunModelSelection(promptId: string, refs: ModelRef[]): void {
  write(`run-models:${promptId}`, refs);
}

/** Last variable values used to run this prompt (prefill for the next run). */
export function getRunVariables(promptId: string): Record<string, string> {
  return read(`run-variables:${promptId}`, asVariables) ?? {};
}

export function setRunVariables(promptId: string, variables: Record<string, string>): void {
  write(`run-variables:${promptId}`, variables);
}

/** {{variable}} names in a prompt's content, in order of first appearance. */
export function extractVariableNames(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(/\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}/gu)) {
    if (!names.includes(match[1]!)) names.push(match[1]!);
  }
  return names;
}
