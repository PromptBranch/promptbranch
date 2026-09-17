import { describe, expect, it } from "vitest";
import * as ipcContract from "./ipc.js";
import {
  promptCreateSchema,
  promptDuplicateSchema,
  draftSetSchema,
  shareDeleteSchema,
  shareImportPreviewSchema,
  sharePortalSetSchema,
  shareScopeSchema,
  syncPairRequestClosedEventSchema,
  syncPairRequestEventSchema,
  syncRespondPairingSchema,
  updateOpenDownloadSchema,
  updateSetAutomaticChecksSchema,
  updateStateDtoSchema,
  versionDeleteSchema,
  versionCreateSchema,
  versionUpdateContentSchema,
  versionUpdateLabelSchema,
} from "./ipc.js";
import { IPC_CHANNELS } from "./channels.js";

interface TestSchema {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}

describe("AI run request correlation", () => {
  const requestId = "550e8400-e29b-41d4-a716-446655440001";
  const invocation = {
    promptId: "prompt-1", content: "Hi", variables: {},
    modelRefs: [{ providerId: "provider-1", modelId: "model-1" }],
  };

  it("requires and preserves a UUID on invocations", () => {
    for (const invalid of [undefined, "", "request-1"]) {
      expect(ipcContract.aiRunSchema.safeParse({ ...invocation, requestId: invalid }).success).toBe(false);
    }
    expect(ipcContract.aiRunSchema.parse({ ...invocation, requestId })).toMatchObject({ requestId });
  });

  it.each(["queued", "started", "delta", "completed", "error"])(
    "requires and preserves a UUID on %s progress", (phase) => {
      const event = { runGroupId: "group-1", providerId: "provider-1", modelId: "model-1", phase };
      for (const invalid of [undefined, "", "request-1"]) {
        expect(ipcContract.aiRunProgressEventSchema.safeParse({ ...event, requestId: invalid }).success).toBe(false);
      }
      expect(ipcContract.aiRunProgressEventSchema.parse({ ...event, requestId })).toEqual({ ...event, requestId });
    },
  );
});

function paletteSchema(name: string): TestSchema {
  const schema = (ipcContract as unknown as Record<string, TestSchema | undefined>)[name];
  expect(schema, `${name} must be exported`).toBeDefined();
  return schema!;
}

describe("quick palette IPC contract", () => {
  it("publishes the exact zod-free channel names", () => {
    expect(IPC_CHANNELS).toMatchObject({
      quickPaletteGetState: "quick-palette:get-state",
      quickPaletteUpdateSettings: "quick-palette:update-settings",
      quickPaletteSearch: "quick-palette:search",
      quickPaletteResolve: "quick-palette:resolve",
      quickPaletteRender: "quick-palette:render",
      quickPaletteCopy: "quick-palette:copy",
      quickPaletteDismiss: "quick-palette:dismiss",
      quickPaletteOpened: "quick-palette:opened",
      quickPaletteClosed: "quick-palette:closed",
    });
  });

  it("requires strict settings with a bounded non-empty accelerator", () => {
    const schema = paletteSchema("quickPaletteSettingsSchema");

    expect(schema.parse({ enabled: true, accelerator: "  CommandOrControl+Shift+Space  " })).toEqual({
      enabled: true,
      accelerator: "CommandOrControl+Shift+Space",
    });
    expect(schema.safeParse({ enabled: true, accelerator: "" }).success).toBe(false);
    expect(schema.safeParse({ enabled: true, accelerator: "x".repeat(101) }).success).toBe(false);
    expect(schema.safeParse({ enabled: true, accelerator: "Ctrl+K", extra: true }).success).toBe(false);
  });

  it("bounds palette ids and search queries", () => {
    const search = paletteSchema("quickPaletteSearchSchema");
    const resolve = paletteSchema("quickPaletteResolveSchema");
    const copy = paletteSchema("quickPaletteCopySchema");
    const dismiss = paletteSchema("quickPaletteDismissSchema");

    expect(search.parse({ sessionId: "session-1", query: "שלום 🌙" })).toEqual({
      sessionId: "session-1",
      query: "שלום 🌙",
    });
    expect(search.safeParse({ sessionId: "", query: "x" }).success).toBe(false);
    expect(search.safeParse({ sessionId: "session-1", query: "x".repeat(501) }).success).toBe(false);
    expect(resolve.safeParse({ sessionId: "session-1", promptId: "" }).success).toBe(false);
    expect(copy.safeParse({ sessionId: "session-1", previewId: "" }).success).toBe(false);
    expect(dismiss.safeParse({ sessionId: "", extra: true }).success).toBe(false);
  });

  it("preserves Unicode, multiline, booleans, numbers, and an own __proto__ variable", () => {
    const schema = paletteSchema("quickPaletteRenderSchema");
    const variables = Object.create(null) as Record<string, string | number | boolean>;
    variables["שם"] = "שורה א\nשורה ב 🌙";
    variables.count = 2;
    variables.enabled = false;
    variables.__proto__ = "literal";
    const expectedVariables = { "שם": "שורה א\nשורה ב 🌙", count: 2, enabled: false } as Record<
      string,
      string | number | boolean
    >;
    Object.defineProperty(expectedVariables, "__proto__", {
      value: "literal",
      enumerable: true,
      writable: true,
      configurable: true,
    });

    expect(
      schema.parse({
        sessionId: "session-1",
        promptId: "prompt-1",
        versionId: "version-1",
        variables,
      }),
    ).toEqual({
      sessionId: "session-1",
      promptId: "prompt-1",
      versionId: "version-1",
      variables: expectedVariables,
    });
  });

  it("rejects malformed, oversized, and non-finite render variables", () => {
    const schema = paletteSchema("quickPaletteRenderSchema");
    const base = {
      sessionId: "session-1",
      promptId: "prompt-1",
      versionId: "version-1",
    };

    expect(schema.safeParse({ ...base, variables: null }).success).toBe(false);
    expect(schema.safeParse({ ...base, variables: [] }).success).toBe(false);
    expect(schema.safeParse({ ...base, variables: new Date() }).success).toBe(false);
    expect(schema.safeParse({ ...base, variables: { count: Number.POSITIVE_INFINITY } }).success).toBe(false);
    expect(schema.safeParse({ ...base, variables: { note: "x".repeat(100_001) } }).success).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        variables: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`v${index}`, "x"])),
      }).success,
    ).toBe(false);
  });
});

describe("version-bound editor IPC contract", () => {
  it("publishes and validates the exact version amendment payload", () => {
    expect(IPC_CHANNELS.versionUpdateContent).toBe("version:update-content");
    expect(
      versionUpdateContentSchema.parse({ versionId: "version-1", content: "revised text" }),
    ).toEqual({ versionId: "version-1", content: "revised text" });
    expect(versionUpdateContentSchema.safeParse({ versionId: "", content: "text" }).success).toBe(
      false,
    );
  });

  it("requires the exact base version for desktop version creation", () => {
    expect(
      versionCreateSchema.parse({
        promptId: "prompt-1",
        branchId: "branch-1",
        baseVersionId: "version-1",
        content: "next",
      }),
    ).toEqual({
      promptId: "prompt-1",
      branchId: "branch-1",
      baseVersionId: "version-1",
      content: "next",
    });
    expect(
      versionCreateSchema.safeParse({ promptId: "prompt-1", branchId: "branch-1", content: "next" })
        .success,
    ).toBe(false);
  });

  it("requires a base version for non-null drafts and permits an atomic clear", () => {
    expect(
      draftSetSchema.parse({
        promptId: "prompt-1",
        content: "working",
        baseVersionId: "version-1",
      }),
    ).toEqual({ promptId: "prompt-1", content: "working", baseVersionId: "version-1" });
    expect(draftSetSchema.safeParse({ promptId: "prompt-1", content: "working" }).success).toBe(false);
    expect(draftSetSchema.parse({ promptId: "prompt-1", content: null })).toEqual({
      promptId: "prompt-1",
      content: null,
    });
  });
});

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

describe("promptCreateSchema", () => {
  it("accepts a collection target and rejects an empty one", () => {
    expect(
      promptCreateSchema.parse({
        title: "Collected",
        content: "",
        collectionId: "collection-1",
      }),
    ).toEqual({ title: "Collected", content: "", collectionId: "collection-1" });
    expect(
      promptCreateSchema.safeParse({ title: "Collected", content: "", collectionId: "" })
        .success,
    ).toBe(false);
  });
});

describe("promptDuplicateSchema / versionUpdateLabelSchema / versionDeleteSchema", () => {
  it("requires a source prompt, source version and non-empty duplicate title", () => {
    expect(
      promptDuplicateSchema.parse({
        promptId: "prompt-1",
        versionId: "version-2",
        title: "Prompt copy",
      }),
    ).toEqual({ promptId: "prompt-1", versionId: "version-2", title: "Prompt copy" });
    expect(
      promptDuplicateSchema.safeParse({
        promptId: "prompt-1",
        versionId: "version-2",
        title: "  ",
      }).success,
    ).toBe(false);
  });

  it("accepts a trimmed custom version label or null to clear it", () => {
    expect(
      versionUpdateLabelSchema.parse({ versionId: "version-2", label: "  Production  " }),
    ).toEqual({ versionId: "version-2", label: "Production" });
    expect(versionUpdateLabelSchema.parse({ versionId: "version-2", label: null })).toEqual({
      versionId: "version-2",
      label: null,
    });
  });

  it("requires a non-empty version id for deletion", () => {
    expect(versionDeleteSchema.parse({ versionId: "version-2" })).toEqual({
      versionId: "version-2",
    });
    expect(versionDeleteSchema.safeParse({ versionId: "  " }).success).toBe(false);
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
    expect(syncPairRequestClosedEventSchema.parse({ requestId })).toEqual({ requestId });
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
    expect(syncPairRequestClosedEventSchema.safeParse({ fingerprint }).success).toBe(false);
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
