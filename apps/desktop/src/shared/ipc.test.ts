import { describe, expect, it } from "vitest";
import {
  shareDeleteSchema,
  shareImportPreviewSchema,
  sharePortalSetSchema,
  shareScopeSchema,
  syncPairRequestEventSchema,
  syncRespondPairingSchema,
  updateOpenDownloadSchema,
  updateSetAutomaticChecksSchema,
  updateStateDtoSchema,
} from "./ipc.js";

describe("shareScopeSchema", () => {
  it("accepts a minimal scope and one with a description", () => {
    expect(shareScopeSchema.parse({ promptId: "p1", includeHistory: false })).toEqual({
      promptId: "p1",
      includeHistory: false,
    });
    expect(
      shareScopeSchema.parse({ promptId: "p1", includeHistory: true, description: "hi" }),
    ).toEqual({ promptId: "p1", includeHistory: true, description: "hi" });
  });

  it("requires includeHistory and a non-empty promptId", () => {
    expect(shareScopeSchema.safeParse({ promptId: "p1" }).success).toBe(false);
    expect(shareScopeSchema.safeParse({ promptId: "", includeHistory: false }).success).toBe(false);
  });

  it("caps the description at 2000 chars (the snapshot schema limit)", () => {
    expect(
      shareScopeSchema.safeParse({
        promptId: "p1",
        includeHistory: false,
        description: "x".repeat(2001),
      }).success,
    ).toBe(false);
  });
});

describe("sharePortalSetSchema", () => {
  it("allows an empty string (reset to the official instance)", () => {
    expect(sharePortalSetSchema.parse({ baseUrl: "" })).toEqual({ baseUrl: "" });
  });

  it("rejects over-long values", () => {
    expect(sharePortalSetSchema.safeParse({ baseUrl: "x".repeat(501) }).success).toBe(false);
  });
});

describe("shareDeleteSchema / shareImportPreviewSchema", () => {
  it("require non-empty ids and urls", () => {
    expect(shareDeleteSchema.safeParse({ snapshotId: "" }).success).toBe(false);
    expect(shareImportPreviewSchema.safeParse({ url: "" }).success).toBe(false);
    expect(shareImportPreviewSchema.safeParse({ url: "https://x/p/abc" }).success).toBe(true);
  });
});

describe("sync pairing IPC schemas", () => {
  const requestId = "550e8400-e29b-41d4-a716-446655440000";
  const fingerprint = "a".repeat(64);

  it("binds each pairing event and response to a validated request id", () => {
    expect(
      syncPairRequestEventSchema.parse({
        requestId,
        fingerprint,
        fingerprintShort: "aaaaaaaaaa",
        name: "MacBook Pro",
      }),
    ).toEqual({
      requestId,
      fingerprint,
      fingerprintShort: "aaaaaaaaaa",
      name: "MacBook Pro",
    });
    expect(syncRespondPairingSchema.parse({ requestId, accept: true })).toEqual({
      requestId,
      accept: true,
    });
  });

  it("rejects legacy fingerprint-only events and responses", () => {
    expect(
      syncPairRequestEventSchema.safeParse({
        fingerprint,
        fingerprintShort: "aaaaaaaaaa",
        name: "MacBook Pro",
      }).success,
    ).toBe(false);
    expect(syncRespondPairingSchema.safeParse({ fingerprint, accept: true }).success).toBe(false);
  });
});

describe("update IPC schemas", () => {
  const baseState = {
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    platform: "macOS",
    architecture: "arm64",
    automaticChecksEnabled: true,
    lastCheckedAt: "2026-08-31T12:00:00.000Z",
    checkSource: "manual" as const,
    releaseName: "PromptBranch 0.2.0",
    releaseNotes: "A safer update flow",
    publishedAt: "2026-08-31T10:00:00.000Z",
    assets: [
      {
        name: "promptbranch_0.2.0_macos_arm64.dmg",
        label: "macOS disk image",
        kind: "dmg" as const,
        sizeBytes: 12_345,
        recommended: true,
      },
    ],
    errorMessage: null,
  };

  it.each([
    "not-checked",
    "checking",
    "up-to-date",
    "update-available",
    "no-compatible-download",
    "newer-build",
    "error",
  ] as const)("accepts the %s update state", (status) => {
    expect(updateStateDtoSchema.parse({ ...baseState, status }).status).toBe(status);
  });

  it("bounds installer names and requires a boolean automatic-check preference", () => {
    expect(
      updateOpenDownloadSchema.parse({ assetName: "promptbranch_0.2.0_linux_x64.AppImage" }),
    ).toEqual({ assetName: "promptbranch_0.2.0_linux_x64.AppImage" });
    expect(updateOpenDownloadSchema.safeParse({ assetName: "" }).success).toBe(false);
    expect(updateOpenDownloadSchema.safeParse({ assetName: "x".repeat(301) }).success).toBe(false);
    expect(updateSetAutomaticChecksSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(updateSetAutomaticChecksSchema.safeParse({ enabled: "false" }).success).toBe(false);
  });
});
