import { z } from "zod";
import { SNAPSHOT_ID_PATTERN } from "./ids.js";

/** Hard request cap enforced by the portal before parsing (spec: 256 KB). */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

export const snapshotIdSchema = z.string().regex(SNAPSHOT_ID_PATTERN);

export const historyEntrySchema = z.object({
  version: z.number().int().positive(),
  content: z.string(),
  changeNote: z.string(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/**
 * The only data that ever crosses the trust boundary. Notes, runs, ratings
 * and collections intentionally have no fields here (highest leak risk).
 */
export const snapshotSchema = z.object({
  formatVersion: z.literal(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  content: z.string().min(1),
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
  history: z.array(historyEntrySchema).max(500).optional(),
  parentId: snapshotIdSchema.optional(),
  publishedAt: z.iso.datetime(),
  appVersion: z.string().max(50).optional(),
});
export type SnapshotPayload = z.infer<typeof snapshotSchema>;

export const publishRequestSchema = z.object({
  snapshot: snapshotSchema,
});
export type PublishRequest = z.infer<typeof publishRequestSchema>;

/** POST /api/snapshots success body; deleteToken is shown exactly once. */
export const publishResponseSchema = z.object({
  id: snapshotIdSchema,
  url: z.url(),
  deleteToken: z.string().min(1),
});
export type PublishResponse = z.infer<typeof publishResponseSchema>;

/** GET /api/snapshots/:id success body. */
export const snapshotResponseSchema = z.object({
  id: snapshotIdSchema,
  url: z.url(),
  publishedAt: z.iso.datetime(),
  snapshot: snapshotSchema,
});
export type SnapshotResponse = z.infer<typeof snapshotResponseSchema>;
