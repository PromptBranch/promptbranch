import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_ID_PATTERN,
  generateDeleteToken,
  generateSnapshotId,
  hashToken,
  isSnapshotId,
} from "../src/ids.js";

describe("generateSnapshotId", () => {
  it("returns 21-char url-safe ids", () => {
    const id = generateSnapshotId();
    expect(id).toHaveLength(21);
    expect(id).toMatch(SNAPSHOT_ID_PATTERN);
  });

  it("never repeats across 1000 draws", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateSnapshotId()));
    expect(ids.size).toBe(1000);
  });
});

describe("isSnapshotId", () => {
  it("accepts generated ids", () => {
    expect(isSnapshotId(generateSnapshotId())).toBe(true);
  });

  it("rejects wrong lengths, bad alphabet and empty input", () => {
    expect(isSnapshotId("abc")).toBe(false);
    expect(isSnapshotId(`${generateSnapshotId()}x`)).toBe(false);
    expect(isSnapshotId("!!!!!!!!!!!!!!!!!!!!!")).toBe(false);
    expect(isSnapshotId("")).toBe(false);
  });
});

describe("generateDeleteToken", () => {
  it("returns 32 random bytes as unpadded base64url (43 chars)", () => {
    expect(generateDeleteToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats across 1000 draws", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateDeleteToken()));
    expect(tokens.size).toBe(1000);
  });
});

describe("hashToken", () => {
  it("matches the published sha256 vector for 'test'", () => {
    expect(hashToken("test")).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
  });

  it("is deterministic and hex-encoded", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken(generateDeleteToken())).toMatch(/^[0-9a-f]{64}$/);
  });
});
