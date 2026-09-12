import {
  extractPromptVariables,
  missingPromptVariables,
  resolvePrompt,
  resolveVersion,
  substitutePromptVariables,
  type PromptLibrary,
} from "@promptbranch/core";
import type {
  QuickPaletteFailureCode,
  QuickPaletteItem,
  QuickPaletteRenderInput,
  QuickPaletteResult,
  QuickPaletteSelection,
} from "../shared/ipc.js";

const MAX_VARIABLES = 100;
const MAX_VARIABLE_VALUE_LENGTH = 100_000;
const MAX_RENDERED_LENGTH = 1_000_000;

export class QuickPaletteError extends Error {
  constructor(
    readonly code: QuickPaletteFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "QuickPaletteError";
  }
}

export function quickPaletteFailure(
  error: unknown,
): Extract<QuickPaletteResult<never>, { ok: false }> {
  if (error instanceof QuickPaletteError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    code: "invalid-input",
    message: "Unable to complete the prompt palette request.",
  };
}

function selectionForPrompt(
  library: PromptLibrary,
  promptId: string,
): QuickPaletteSelection {
  const exactPrompt = library.getPrompt(promptId);
  if (!exactPrompt || exactPrompt.deleted_at) {
    throw new QuickPaletteError("not-found", "This prompt is no longer available.");
  }

  try {
    const prompt = resolvePrompt(library, exactPrompt.id);
    const current = resolveVersion(library, prompt.id);
    const requiredVariables = extractPromptVariables(current.version.content);
    if (requiredVariables.length > MAX_VARIABLES) {
      throw new QuickPaletteError(
        "invalid-input",
        `This prompt has more than ${MAX_VARIABLES} variables and cannot be opened in the palette.`,
      );
    }
    return {
      promptId: prompt.id,
      title: prompt.title,
      versionId: current.version.id,
      versionLabel: current.label,
      templateContent: current.version.content,
      requiredVariables,
    };
  } catch (error) {
    if (error instanceof QuickPaletteError) throw error;
    throw new QuickPaletteError("not-found", "This prompt has no current saved version.");
  }
}

function itemFromSelection(
  library: PromptLibrary,
  selection: QuickPaletteSelection,
  matchedHistory: boolean,
): QuickPaletteItem {
  const prompt = library.getPrompt(selection.promptId)!;
  return {
    promptId: selection.promptId,
    title: selection.title,
    starred: prompt.is_starred === 1,
    currentVersionId: selection.versionId,
    currentVersionLabel: selection.versionLabel,
    matchedHistory,
  };
}

export function searchQuickPalette(library: PromptLibrary, query: string): QuickPaletteItem[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    const prompts = library.listPrompts({ sort: "updated" });
    const starred = prompts.filter((prompt) => prompt.is_starred === 1);
    const unstarred = prompts.filter((prompt) => prompt.is_starred !== 1);
    const results: QuickPaletteItem[] = [];
    for (const prompt of [...starred, ...unstarred]) {
      try {
        results.push(itemFromSelection(library, selectionForPrompt(library, prompt.id), false));
      } catch {
        continue;
      }
      if (results.length === 20) break;
    }
    return results;
  }

  const results: QuickPaletteItem[] = [];
  const resultIndexes = new Map<string, number>();
  for (const hit of library.search(normalizedQuery)) {
    let matchedHistory = false;
    if (hit.versionId !== null) {
      const hitVersion = library.getVersion(hit.versionId);
      if (
        !hitVersion ||
        hitVersion.prompt_id !== hit.promptId ||
        hitVersion.status !== "active"
      ) {
        continue;
      }
    }

    let selection: QuickPaletteSelection;
    try {
      selection = selectionForPrompt(library, hit.promptId);
      matchedHistory = hit.versionId !== null && hit.versionId !== selection.versionId;
    } catch {
      continue;
    }

    const existingIndex = resultIndexes.get(hit.promptId);
    if (existingIndex !== undefined) {
      if (!matchedHistory) results[existingIndex]!.matchedHistory = false;
      continue;
    }
    resultIndexes.set(hit.promptId, results.length);
    results.push(itemFromSelection(library, selection, matchedHistory));
  }
  return results;
}

export function resolveQuickPalette(
  library: PromptLibrary,
  promptId: string,
): QuickPaletteSelection {
  return selectionForPrompt(library, promptId);
}

export function assertQuickPaletteSelectionCurrent(
  library: PromptLibrary,
  input: { promptId: string; versionId: string },
): QuickPaletteSelection {
  const prompt = library.getPrompt(input.promptId);
  if (!prompt || prompt.deleted_at) {
    throw new QuickPaletteError("not-found", "This prompt is no longer available.");
  }
  const selectedVersion = library.getVersion(input.versionId);
  if (
    !selectedVersion ||
    selectedVersion.prompt_id !== input.promptId ||
    selectedVersion.status !== "active"
  ) {
    throw new QuickPaletteError("not-found", "This saved version is no longer available.");
  }

  const current = selectionForPrompt(library, input.promptId);
  if (current.versionId !== input.versionId) {
    throw new QuickPaletteError(
      "revision-changed",
      "The current saved version changed. Refresh it before copying.",
    );
  }
  return current;
}

function validateVariables(
  requiredVariables: string[],
  variables: QuickPaletteRenderInput["variables"],
): void {
  const allowed = new Set(requiredVariables);
  for (const [name, value] of Object.entries(variables)) {
    if (!allowed.has(name)) {
      throw new QuickPaletteError("invalid-input", `Unknown prompt variable: ${name}`);
    }
    if (typeof value === "string" && value.length > MAX_VARIABLE_VALUE_LENGTH) {
      throw new QuickPaletteError(
        "invalid-input",
        `Variable ${name} exceeds ${MAX_VARIABLE_VALUE_LENGTH} characters.`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new QuickPaletteError("invalid-input", `Variable ${name} must be finite.`);
    }
  }
}

function estimateRenderedLength(
  templateContent: string,
  requiredVariables: string[],
  variables: QuickPaletteRenderInput["variables"],
): number {
  const blankValues = Object.create(null) as Record<string, string>;
  for (const name of requiredVariables) blankValues[name] = "";
  const literalLength = substitutePromptVariables(templateContent, blankValues).length;
  let length = literalLength;

  for (const name of requiredVariables) {
    const markerValues = Object.assign(Object.create(null), blankValues) as Record<string, string>;
    markerValues[name] = "x";
    const occurrences =
      substitutePromptVariables(templateContent, markerValues).length - literalLength;
    length += occurrences * String(variables[name]!).length;
    if (length > MAX_RENDERED_LENGTH) return length;
  }
  return length;
}

export function renderQuickPalette(
  library: PromptLibrary,
  input: QuickPaletteRenderInput,
):
  | { status: "needs-input"; missingVariables: string[] }
  | { status: "ready"; content: string } {
  const selection = assertQuickPaletteSelectionCurrent(library, input);
  validateVariables(selection.requiredVariables, input.variables);
  const missingVariables = missingPromptVariables(selection.templateContent, input.variables);
  if (missingVariables.length > 0) return { status: "needs-input", missingVariables };

  if (
    estimateRenderedLength(
      selection.templateContent,
      selection.requiredVariables,
      input.variables,
    ) > MAX_RENDERED_LENGTH
  ) {
    throw new QuickPaletteError(
      "invalid-input",
      `Rendered prompt exceeds ${MAX_RENDERED_LENGTH} characters.`,
    );
  }
  return {
    status: "ready",
    content: substitutePromptVariables(selection.templateContent, input.variables),
  };
}
