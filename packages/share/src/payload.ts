import { snapshotSchema, type HistoryEntry, type SnapshotPayload } from "./schema.js";

export interface SnapshotDraft {
  title: string;
  /** Publisher-supplied description override (e.g. CLI --description). */
  description?: string;
  /** The prompt's own description, used when no override is given. */
  promptDescription: string | null;
  /** Current-version content. */
  content: string;
  tags: string[];
  /** Oldest-first default-branch history; present only when the publisher opted in. */
  history?: HistoryEntry[];
  parentId?: string;
  appVersion?: string;
  /** Injectable clock for tests; defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * Assembles the exact payload that crosses the trust boundary and validates
 * it against snapshotSchema, so callers can never publish a shape the portal
 * would reject. Notes, runs and ratings have no input fields here by design.
 */
export function buildSnapshotPayload(draft: SnapshotDraft): SnapshotPayload {
  const description = draft.description ?? draft.promptDescription ?? undefined;
  if (description !== undefined && description.length > 2000) {
    throw new Error(
      "Description is too long for sharing (max 2000 characters) — shorten the prompt description or pass a shorter override",
    );
  }
  return snapshotSchema.parse({
    formatVersion: 1,
    title: draft.title,
    ...(description ? { description } : {}),
    content: draft.content,
    tags: draft.tags,
    ...(draft.history ? { history: draft.history } : {}),
    ...(draft.parentId ? { parentId: draft.parentId } : {}),
    publishedAt: (draft.now?.() ?? new Date()).toISOString(),
    ...(draft.appVersion ? { appVersion: draft.appVersion } : {}),
  });
}

/**
 * Title for an imported prompt: the snapshot's title, suffixed when the
 * target library already uses it ("… (imported)", then "… (imported N)").
 */
export function uniqueImportTitle(existingTitles: readonly string[], title: string): string {
  const taken = new Set(existingTitles.map((t) => t.toLowerCase()));
  if (!taken.has(title.toLowerCase())) return title;
  const first = `${title} (imported)`;
  if (!taken.has(first.toLowerCase())) return first;
  for (let n = 2; ; n++) {
    const candidate = `${title} (imported ${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
