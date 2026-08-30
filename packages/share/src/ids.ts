import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";

export const SNAPSHOT_ID_LENGTH = 21;

/** nanoid's default url-safe alphabet at SNAPSHOT_ID_LENGTH — share it so
    schemas and the URL parser validate the exact same shape. */
export const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9_-]{21}$/;

/** Unguessable snapshot id (~128 bits); no sequential enumeration is possible. */
export function generateSnapshotId(): string {
  return nanoid();
}

export function isSnapshotId(value: string): boolean {
  return SNAPSHOT_ID_PATTERN.test(value);
}

/** 256-bit one-time delete token, shown to the publisher exactly once. */
export function generateDeleteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Server stores only this hash; the raw token never touches the database. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
