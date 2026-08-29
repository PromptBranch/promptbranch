import { describe, expect, it } from "vitest";
import {
  shareDeleteSchema,
  shareImportPreviewSchema,
  sharePortalSetSchema,
  shareScopeSchema,
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
