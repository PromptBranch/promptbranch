import type { PromptRow, VersionRow } from "./types.js";
import type { PromptLibrary } from "./library.js";

/** Display label for a version: "v3", a custom label, or "concise v2" off-main. */
export function formatVersionLabel(
  version: Pick<VersionRow, "number" | "label">,
  branchName: string,
): string {
  if (version.label) return version.label;
  const base = `v${version.number}`;
  return branchName === "main" ? base : `${branchName} ${base}`;
}

export interface ResolvedVersion {
  version: VersionRow;
  branchName: string;
  /** Display label, e.g. "v3" or "agent-20260101-abcd1234 v1". */
  label: string;
}

/**
 * Picks a concrete active version of a prompt for agent/CLI reads.
 * - No options: the prompt's current version.
 * - `branch` only: the head of that branch.
 * - `version` (number): that numbered version, on `branch` if given, else on
 *   the current version's branch.
 * Pending/rejected suggestions are never returned.
 */
export function resolveVersion(
  library: PromptLibrary,
  promptId: string,
  options: { version?: number; branch?: string } = {},
): ResolvedVersion {
  const versions = library.listVersions(promptId);
  if (versions.length === 0) throw new Error("Prompt has no active versions");

  const toResolved = (v: (typeof versions)[number]): ResolvedVersion => ({
    version: v,
    branchName: v.branch_name,
    label: formatVersionLabel(v, v.branch_name),
  });

  if (options.version === undefined && !options.branch) {
    const prompt = library.getPrompt(promptId);
    const current = versions.find((v) => v.id === prompt?.current_version_id);
    if (!current) throw new Error("Prompt has no current version");
    return toResolved(current);
  }

  let pool = versions;
  if (options.branch) {
    pool = pool.filter((v) => v.branch_name.toLowerCase() === options.branch!.toLowerCase());
    if (pool.length === 0) throw new Error(`No branch "${options.branch}" with active versions on this prompt`);
  }

  if (options.version === undefined) {
    // Branch head: highest per-branch number.
    return toResolved(pool.reduce((a, b) => (b.number > a.number ? b : a)));
  }
  if (!options.branch) {
    // No explicit branch: scope the number lookup to the current version's
    // branch (numbers are per-branch, so unscoped lookup is ambiguous).
    const prompt = library.getPrompt(promptId);
    const current = versions.find((v) => v.id === prompt?.current_version_id);
    if (current) pool = pool.filter((v) => v.branch_name === current.branch_name);
  }
  const match = pool.find((v) => v.number === options.version);
  if (!match) {
    const scope = options.branch ? ` on branch "${options.branch}"` : "";
    throw new Error(`No version v${options.version}${scope} on this prompt`);
  }
  return toResolved(match);
}


/**
 * Resolves a user/agent-supplied prompt reference to a prompt row. Shared by
 * the CLI and the MCP server so name handling is identical everywhere.
 *
 * Resolution order:
 * 1. Exact id match.
 * 2. Exact title match (case-sensitive).
 * 3. Case-insensitive exact title match.
 * 4. Unique case-insensitive substring match.
 *
 * Throws when nothing matches, or when a substring match is ambiguous (the
 * error lists the close matches so the caller can retry with a better name).
 * Soft-deleted prompts are excluded.
 */
export function resolvePrompt(library: PromptLibrary, nameOrId: string): PromptRow {
  const ref = nameOrId.trim();
  if (!ref) throw new Error("Prompt name or id must not be empty");

  const byId = library.getPrompt(ref);
  if (byId && !byId.deleted_at) return byId;

  const prompts = library.listPrompts();

  const exact = prompts.filter((p) => p.title === ref);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw ambiguousError(ref, exact);

  const lower = ref.toLowerCase();
  const caseInsensitive = prompts.filter((p) => p.title.toLowerCase() === lower);
  if (caseInsensitive.length === 1) return caseInsensitive[0]!;
  if (caseInsensitive.length > 1) throw ambiguousError(ref, caseInsensitive);

  const substring = prompts.filter((p) => p.title.toLowerCase().includes(lower));
  if (substring.length === 1) return substring[0]!;
  if (substring.length > 1) throw ambiguousError(ref, substring);

  throw new Error(`No prompt matches "${ref}"`);
}

function ambiguousError(ref: string, matches: PromptRow[]): Error {
  const list = matches
    .slice(0, 10)
    .map((p) => `  - ${p.title} (${p.id})`)
    .join("\n");
  return new Error(`"${ref}" is ambiguous — ${matches.length} prompts match:\n${list}`);
}
