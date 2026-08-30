import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_LATEST_RELEASE_URL,
  UpdateService,
  type UpdateServiceDeps,
} from "./updates.js";

const NOW = new Date("2026-08-31T12:00:00.000Z");

function artifactName(
  version: string,
  platform: "macos" | "windows" | "linux",
  architecture: "arm64" | "x64",
  extension: "dmg" | "exe" | "AppImage" | "deb",
): string {
  return `promptbranch_${version}_${platform}_${architecture}.${extension}`;
}

function githubAsset(tag: string, name: string, url?: string) {
  return {
    name,
    browser_download_url:
      url ?? `https://github.com/PromptBranch/promptbranch/releases/download/${tag}/${name}`,
    content_type: "application/octet-stream",
    size: 12_345,
    state: "uploaded",
  };
}

function githubRelease(version: string, assetNames: string[], overrides: Record<string, unknown> = {}) {
  const tag = `v${version}`;
  return {
    tag_name: tag,
    name: `PromptBranch ${version}`,
    html_url: `https://github.com/PromptBranch/promptbranch/releases/tag/${tag}`,
    body: "## Highlights\n\n- Faster prompt search\n- Improved sync status",
    published_at: "2026-08-31T10:00:00.000Z",
    draft: false,
    prerelease: false,
    assets: assetNames.map((name) => githubAsset(tag, name)),
    ...overrides,
  };
}

function jsonResponse(body: unknown, etag = '"release-etag"'): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", etag },
  });
}

function makeService(
  overrides: Partial<UpdateServiceDeps> = {},
  settings = new Map<string, string>(),
) {
  const fetchImpl = vi.fn(async () =>
    jsonResponse(
      githubRelease("0.2.0", [artifactName("0.2.0", "macos", "arm64", "dmg")]),
    ),
  );
  const openExternal = vi.fn(async () => {});
  const emitted: ReturnType<UpdateService["getState"]>[] = [];
  const deps: UpdateServiceDeps = {
    currentVersion: "0.1.0",
    platform: "darwin",
    architecture: "arm64",
    runningUnderArm64Translation: false,
    launchedFromAppImage: false,
    isDevelopment: false,
    getSetting: (key) => settings.get(key) ?? null,
    setSetting: (key, value) => settings.set(key, value),
    fetchImpl,
    openExternal,
    now: () => NOW,
    emitState: (state) => emitted.push(state),
    ...overrides,
  };
  return {
    service: new UpdateService(deps),
    settings,
    fetchImpl: deps.fetchImpl as ReturnType<typeof vi.fn>,
    openExternal: deps.openExternal as ReturnType<typeof vi.fn>,
    emitted,
  };
}

describe("UpdateService release decisions", () => {
  it("reports a newer stable release and selects only the exact macOS ARM64 installer", async () => {
    const x64 = artifactName("0.2.0", "macos", "x64", "dmg");
    const arm64 = artifactName("0.2.0", "macos", "arm64", "dmg");
    const fetchImpl = vi.fn(async () =>
      jsonResponse(githubRelease("0.2.0", [x64, arm64])),
    );
    const { service } = makeService({ fetchImpl });

    const result = await service.check("manual");

    expect(result).toMatchObject({
      status: "update-available",
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      platform: "macOS",
      architecture: "arm64",
      releaseName: "PromptBranch 0.2.0",
      releaseNotes: expect.stringContaining("Faster prompt search"),
      lastCheckedAt: NOW.toISOString(),
      checkSource: "manual",
      errorMessage: null,
    });
    expect(result.releaseNotes).toBe(
      "Highlights\n\n• Faster prompt search\n• Improved sync status",
    );
    expect(result.assets).toEqual([
      {
        name: arm64,
        label: "macOS disk image",
        kind: "dmg",
        sizeBytes: 12_345,
        recommended: true,
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      GITHUB_LATEST_RELEASE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/vnd.github+json" }),
      }),
    );
  });

  it("prefers the native ARM64 installer when Electron runs x64 under translation", async () => {
    const arm64 = artifactName("0.2.0", "macos", "arm64", "dmg");
    const { service } = makeService({
      architecture: "x64",
      runningUnderArm64Translation: true,
    });

    const result = await service.check("manual");

    expect(result.architecture).toBe("arm64");
    expect(result.assets.map((asset) => asset.name)).toEqual([arm64]);
  });

  it.each([
    ["0.2.0", "up-to-date"],
    ["0.3.0", "newer-build"],
  ] as const)("classifies installed %s against latest 0.2.0 as %s", async (currentVersion, status) => {
    const { service } = makeService({ currentVersion });

    const result = await service.check("manual");

    expect(result.status).toBe(status);
    expect(result.latestVersion).toBe("0.2.0");
    expect(result.assets).toEqual([]);
  });

  it("does not fall back to another platform or architecture", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        githubRelease("0.2.0", [
          artifactName("0.2.0", "macos", "x64", "dmg"),
          artifactName("0.2.0", "windows", "arm64", "exe"),
        ]),
      ),
    );
    const { service } = makeService({ fetchImpl });

    const result = await service.check("manual");

    expect(result.status).toBe("no-compatible-download");
    expect(result.assets).toEqual([]);
  });

  it("offers both matching Linux package types and prefers AppImage when launched from one", async () => {
    const appImage = artifactName("0.2.0", "linux", "x64", "AppImage");
    const deb = artifactName("0.2.0", "linux", "x64", "deb");
    const fetchImpl = vi.fn(async () =>
      jsonResponse(githubRelease("0.2.0", [appImage, deb])),
    );
    const { service } = makeService({
      platform: "linux",
      architecture: "x64",
      launchedFromAppImage: true,
      fetchImpl,
    });

    const result = await service.check("manual");

    expect(result.platform).toBe("Linux");
    expect(result.assets).toEqual([
      expect.objectContaining({ name: appImage, kind: "appimage", recommended: true }),
      expect.objectContaining({ name: deb, kind: "deb", recommended: false }),
    ]);
  });
});

describe("UpdateService validation and caching", () => {
  it("requires the repository's canonical v-prefixed release tags", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        githubRelease("0.2.0", [], {
          tag_name: "0.2.0",
          html_url: "https://github.com/PromptBranch/promptbranch/releases/tag/0.2.0",
        }),
      ),
    );
    const { service } = makeService({ fetchImpl });

    const result = await service.check("manual");

    expect(result.status).toBe("error");
    expect(result.errorMessage).toMatch(/valid release version/i);
  });

  it("rejects a non-canonical release URL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        githubRelease("0.2.0", [], {
          html_url: "https://example.com/PromptBranch/promptbranch/releases/tag/v0.2.0",
        }),
      ),
    );
    const { service } = makeService({ fetchImpl });

    const result = await service.check("manual");

    expect(result.status).toBe("error");
    expect(result.errorMessage).toMatch(/valid release/i);
  });

  it("ignores an otherwise matching asset with a non-canonical download URL", async () => {
    const name = artifactName("0.2.0", "macos", "arm64", "dmg");
    const release = githubRelease("0.2.0", []);
    release.assets = [githubAsset("v0.2.0", name, "https://example.com/update.dmg")];
    const fetchImpl = vi.fn(async () => jsonResponse(release));
    const { service } = makeService({ fetchImpl });

    const result = await service.check("manual");

    expect(result.status).toBe("no-compatible-download");
    expect(result.assets).toEqual([]);
  });

  it("turns invalid versions and HTTP failures into a retryable error state", async () => {
    const invalidFetch = vi.fn(async () => jsonResponse(githubRelease("not-semver", [])));
    const httpFetch = vi.fn(async () => new Response("server error", { status: 500 }));

    const invalid = await makeService({ fetchImpl: invalidFetch }).service.check("manual");
    const failed = await makeService({ fetchImpl: httpFetch }).service.check("manual");

    expect(invalid).toMatchObject({ status: "error", lastCheckedAt: NOW.toISOString() });
    expect(failed).toMatchObject({
      status: "error",
      errorMessage: expect.stringMatching(/HTTP 500/i),
      lastCheckedAt: NOW.toISOString(),
    });
  });

  it("reuses a validated cached release after GitHub returns 304", async () => {
    const settings = new Map<string, string>();
    const first = makeService({}, settings);
    const firstResult = await first.service.check("manual");
    expect(firstResult.status).toBe("update-available");

    const notModified = vi.fn(async () => new Response(null, { status: 304 }));
    const second = makeService({ fetchImpl: notModified }, settings);
    const secondResult = await second.service.check("manual");

    expect(secondResult.status).toBe("update-available");
    expect(secondResult.latestVersion).toBe("0.2.0");
    expect(notModified).toHaveBeenCalledWith(
      GITHUB_LATEST_RELEASE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ "If-None-Match": '"release-etag"' }),
      }),
    );
  });

  it("restores the last validated result for a new service instance", async () => {
    const settings = new Map<string, string>();
    await makeService({}, settings).service.check("manual");

    const restored = makeService({}, settings).service.getState();

    expect(restored).toMatchObject({
      status: "update-available",
      latestVersion: "0.2.0",
      lastCheckedAt: NOW.toISOString(),
      checkSource: null,
    });
  });

  it("ignores a schema-valid cached release that fails the trust checks", () => {
    const settings = new Map<string, string>();
    settings.set(
      "updates.release_cache",
      JSON.stringify({
        etag: '"release-etag"',
        release: githubRelease("0.2.0", [], {
          html_url: "https://example.com/releases/tag/v0.2.0",
        }),
      }),
    );

    expect(() => makeService({}, settings)).not.toThrow();
    expect(makeService({}, settings).service.getState()).toMatchObject({
      status: "not-checked",
      latestVersion: null,
    });
  });

  it("turns a settings persistence failure into a contained error state", async () => {
    const { service } = makeService({
      setSetting: () => {
        throw new Error("database is read-only");
      },
    });

    await expect(service.check("manual")).resolves.toMatchObject({
      status: "error",
      errorMessage: expect.stringMatching(/could not check/i),
    });
  });
});

describe("UpdateService preferences and guarded navigation", () => {
  it("checks automatically at most once per day and never in development", async () => {
    const automatic = makeService();
    expect(automatic.service.getState().automaticChecksEnabled).toBe(true);

    expect(await automatic.service.checkAutomaticallyIfDue()).not.toBeNull();
    expect(await automatic.service.checkAutomaticallyIfDue()).toBeNull();
    expect(automatic.fetchImpl).toHaveBeenCalledTimes(1);

    const development = makeService({ isDevelopment: true });
    expect(await development.service.checkAutomaticallyIfDue()).toBeNull();
    expect(development.fetchImpl).not.toHaveBeenCalled();
  });

  it("persists the automatic-check preference", () => {
    const settings = new Map<string, string>();
    const first = makeService({}, settings);

    const disabled = first.service.setAutomaticChecksEnabled(false);
    const restored = makeService({}, settings).service.getState();

    expect(disabled.automaticChecksEnabled).toBe(false);
    expect(restored.automaticChecksEnabled).toBe(false);
  });

  it("opens only a validated cached installer or release-notes URL", async () => {
    const { service, openExternal } = makeService();
    const result = await service.check("manual");
    const asset = result.assets[0]!;

    await service.openDownload(asset.name);
    await service.openReleaseNotes();

    expect(openExternal).toHaveBeenNthCalledWith(
      1,
      `https://github.com/PromptBranch/promptbranch/releases/download/v0.2.0/${asset.name}`,
    );
    expect(openExternal).toHaveBeenNthCalledWith(
      2,
      "https://github.com/PromptBranch/promptbranch/releases/tag/v0.2.0",
    );
    await expect(service.openDownload("promptbranch_0.2.0_macos_x64.dmg")).rejects.toThrow(
      /not available/i,
    );
  });
});
