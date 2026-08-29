import { isSnapshotId } from "./ids.js";

/**
 * Accepts a raw snapshot id or a full URL on any host (self-hosted portals
 * all share the /p/<id> and /api/snapshots/<id> shapes). Returns null for
 * anything unrecognized — callers surface "not a snapshot link" themselves.
 */
export function parseSnapshotUrl(input: string): { id: string } | null {
  const trimmed = input.trim();
  if (isSnapshotId(trimmed)) return { id: trimmed };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last || !isSnapshotId(last)) return null;
  const path = segments.slice(0, -1).join("/");
  if (path !== "p" && path !== "api/snapshots") return null;
  return { id: last };
}

/**
 * Which portal to talk to for an import target: a full snapshot URL names its
 * own portal (a friend's self-hosted instance), so its origin wins; a raw id
 * can only resolve against the configured fallback portal.
 */
export function resolvePortalBaseUrl(input: string, fallback: string): string {
  try {
    return new URL(input.trim()).origin;
  } catch {
    return fallback;
  }
}
