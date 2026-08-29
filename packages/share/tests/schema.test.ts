import { describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  publishRequestSchema,
  publishResponseSchema,
  snapshotResponseSchema,
  snapshotSchema,
  type SnapshotPayload,
} from "../src/schema.js";

const validPayload: SnapshotPayload = {
  formatVersion: 1,
  title: "security-audit",
  description: "Review code for security issues",
  content: "You are a security auditor. Review the following code.",
  tags: ["security", "review"],
  history: [{ version: 1, content: "Initial draft.", changeNote: "first" }],
  parentId: "V1StGXR8_Z5jdHi6B-myT",
  publishedAt: "2026-08-25T12:00:00.000Z",
  appVersion: "0.1.0",
};

describe("snapshotSchema", () => {
  it("accepts a full valid payload", () => {
    expect(snapshotSchema.parse(validPayload)).toEqual(validPayload);
  });

  it("accepts the minimal payload (no description/history/parent/appVersion)", () => {
    const minimal = {
      formatVersion: 1,
      title: "t",
      content: "c",
      tags: [],
      publishedAt: "2026-08-25T12:00:00.000Z",
    };
    expect(snapshotSchema.parse(minimal)).toEqual(minimal);
  });

  it("rejects a wrong formatVersion", () => {
    expect(snapshotSchema.safeParse({ ...validPayload, formatVersion: 2 }).success).toBe(false);
  });

  it("rejects empty title and empty content", () => {
    expect(snapshotSchema.safeParse({ ...validPayload, title: "" }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...validPayload, content: "" }).success).toBe(false);
  });

  it("rejects more than 20 tags", () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    expect(snapshotSchema.safeParse({ ...validPayload, tags }).success).toBe(false);
  });

  it("rejects history entries without a changeNote", () => {
    const history = [{ version: 1, content: "x" }];
    expect(snapshotSchema.safeParse({ ...validPayload, history }).success).toBe(false);
  });

  it("rejects malformed parentId and non-ISO publishedAt", () => {
    expect(snapshotSchema.safeParse({ ...validPayload, parentId: "short" }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...validPayload, publishedAt: "yesterday" }).success).toBe(
      false,
    );
  });

  it("exports a 256 KB payload cap", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(256 * 1024);
  });
});

describe("publishRequestSchema", () => {
  it("accepts a snapshot-only request body", () => {
    expect(publishRequestSchema.safeParse({ snapshot: validPayload }).success).toBe(true);
  });
});

describe("response schemas", () => {
  it("publishResponseSchema validates the publish response", () => {
    const response = {
      id: "V1StGXR8_Z5jdHi6B-myT",
      url: "https://prompts.example.com/p/V1StGXR8_Z5jdHi6B-myT",
      deleteToken: "dGVzdC10b2tlbi",
    };
    expect(publishResponseSchema.parse(response)).toEqual(response);
    expect(publishResponseSchema.safeParse({ ...response, id: "nope" }).success).toBe(false);
  });

  it("snapshotResponseSchema validates the fetch response", () => {
    const response = {
      id: "V1StGXR8_Z5jdHi6B-myT",
      url: "https://prompts.example.com/p/V1StGXR8_Z5jdHi6B-myT",
      publishedAt: "2026-08-25T12:00:00.000Z",
      snapshot: validPayload,
    };
    expect(snapshotResponseSchema.parse(response)).toEqual(response);
  });
});
