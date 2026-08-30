import { describe, expect, it } from "vitest";
import { buildSnapshotPayload, uniqueImportTitle } from "../src/payload.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");

describe("buildSnapshotPayload", () => {
  it("builds a minimal current-version payload", () => {
    const payload = buildSnapshotPayload({
      title: "security-audit",
      promptDescription: null,
      content: "You are a security auditor.",
      tags: [],
      now: () => NOW,
    });
    expect(payload).toEqual({
      formatVersion: 1,
      title: "security-audit",
      content: "You are a security auditor.",
      tags: [],
      publishedAt: "2026-08-26T12:00:00.000Z",
    });
    // The trust boundary: no extra keys ever sneak into the payload.
    expect(Object.keys(payload).sort()).toEqual(
      ["content", "formatVersion", "publishedAt", "tags", "title"].sort(),
    );
  });

  it("prefers the publisher description, falls back to the prompt description, omits empty", () => {
    const base = { title: "t", content: "c", tags: [], now: () => NOW };
    expect(
      buildSnapshotPayload({ ...base, description: "override", promptDescription: "prompt desc" })
        .description,
    ).toBe("override");
    expect(buildSnapshotPayload({ ...base, promptDescription: "prompt desc" }).description).toBe(
      "prompt desc",
    );
    expect(
      buildSnapshotPayload({ ...base, promptDescription: null }),
    ).not.toHaveProperty("description");
  });

  it("passes history, parentId and appVersion through", () => {
    const payload = buildSnapshotPayload({
      title: "t",
      promptDescription: null,
      content: "c",
      tags: ["a"],
      history: [
        { version: 1, content: "v1", changeNote: "first" },
        { version: 2, content: "c", changeNote: "" },
      ],
      parentId: "V1StGXR8_Z5jdHi6B-myT",
      appVersion: "0.1.0",
      now: () => NOW,
    });
    expect(payload.history).toHaveLength(2);
    expect(payload.parentId).toBe("V1StGXR8_Z5jdHi6B-myT");
    expect(payload.appVersion).toBe("0.1.0");
  });

  it("rejects over-long descriptions with a clear error", () => {
    expect(() =>
      buildSnapshotPayload({
        title: "t",
        promptDescription: "x".repeat(2001),
        content: "c",
        tags: [],
      }),
    ).toThrow(/too long for sharing/);
  });

  it("rejects payloads the portal would reject (schema-validated)", () => {
    expect(() =>
      buildSnapshotPayload({ title: "", promptDescription: null, content: "c", tags: [] }),
    ).toThrow();
  });
});

describe("uniqueImportTitle", () => {
  it("keeps the title when free, suffixes on conflict (case-insensitive)", () => {
    expect(uniqueImportTitle([], "security-audit")).toBe("security-audit");
    expect(uniqueImportTitle(["Security-Audit"], "security-audit")).toBe(
      "security-audit (imported)",
    );
    expect(
      uniqueImportTitle(["security-audit", "security-audit (imported)"], "security-audit"),
    ).toBe("security-audit (imported 2)");
  });
});
