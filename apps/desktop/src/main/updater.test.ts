import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateProgress, UpdateStateEvent } from "../shared/ipc.js";
import {
  DesktopUpdater,
  normalizeReleaseNotes,
  normalizeUpdateError,
  type DesktopUpdaterDeps,
  type SettingsStore,
  type UpdateFeedResult,
  type UpdaterFeed,
} from "./updater.js";

function createSettings(initial?: Record<string, string>): SettingsStore {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getSetting: (key) => map.get(key) ?? null,
    setSetting: (key, value) => {
      map.set(key, value);
    },
  };
}

interface FakeFeed extends UpdaterFeed {
  emitProgress(progress: UpdateProgress): void;
  emitDownloaded(version: string): void;
}

function createFakeFeed(result?: UpdateFeedResult | null | Error): FakeFeed {
  const progressListeners = new Set<(progress: UpdateProgress) => void>();
  const downloadedListeners = new Set<(info: { version: string }) => void>();
  return {
    checkForUpdates: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result ?? { isUpdateAvailable: false, updateInfo: { version: "9.9.9", releaseNotes: null } };
    }),
    downloadUpdate: vi.fn(async () => "/tmp/pending"),
    quitAndInstall: vi.fn(),
    onProgress: (listener) => {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    onDownloaded: (listener) => {
      downloadedListeners.add(listener);
      return () => downloadedListeners.delete(listener);
    },
    emitProgress: (progress) => {
      for (const listener of [...progressListeners]) listener(progress);
    },
    emitDownloaded: (version) => {
      for (const listener of [...downloadedListeners]) listener({ version });
    },
  };
}

function makeUpdater(options?: {
  feed?: FakeFeed;
  settings?: SettingsStore;
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  appImageEnv?: boolean;
}) {
  const events: UpdateStateEvent[] = [];
  const logs: string[] = [];
  const feed = options?.feed ?? createFakeFeed();
  const settings = options?.settings ?? createSettings();
  const deps: DesktopUpdaterDeps = {
    settings,
    feed,
    isPackaged: options?.isPackaged ?? true,
    platform: options?.platform ?? "darwin",
    appImageEnv: options?.appImageEnv ?? true,
    appVersion: "1.0.0",
    releaseUrlFor: (version) => `https://example.com/releases/v${version}`,
    sendEvent: (event) => events.push(event),
    log: (message) => logs.push(message),
  };
  return { updater: new DesktopUpdater(deps), feed, settings, events, logs };
}

const available: UpdateFeedResult = {
  isUpdateAvailable: true,
  updateInfo: { version: "1.1.0", releaseNotes: "## What's new\n- faster" },
};

describe("DesktopUpdater status and support", () => {
  it("defaults to supported with automatic checks on", () => {
    const { updater } = makeUpdater();
    expect(updater.getStatus()).toEqual({
      supported: true,
      unsupportedReason: null,
      autoCheckEnabled: true,
      currentVersion: "1.0.0",
      lastCheckAt: null,
      skippedVersion: null,
    });
  });

  it("reports dev builds as unsupported and never touches the feed", async () => {
    const { updater, feed } = makeUpdater({ isPackaged: false });
    expect(updater.getStatus().unsupportedReason).toBe("dev-build");
    await expect(updater.checkForUpdates("manual")).resolves.toEqual({
      status: "unsupported",
      reason: "dev-build",
    });
    expect(feed.checkForUpdates).not.toHaveBeenCalled();
  });

  it("reports non-AppImage Linux installs as unsupported", () => {
    const { updater } = makeUpdater({ platform: "linux", appImageEnv: false });
    expect(updater.getStatus().unsupportedReason).toBe("linux-package");
  });

  it("supports Linux AppImage installs", () => {
    const { updater } = makeUpdater({ platform: "linux", appImageEnv: true });
    expect(updater.getStatus().supported).toBe(true);
  });
});

describe("DesktopUpdater checks", () => {
  it("reports up-to-date and records the check time", async () => {
    const { updater, settings } = makeUpdater();
    await expect(updater.checkForUpdates("manual")).resolves.toEqual({
      status: "up-to-date",
      currentVersion: "1.0.0",
    });
    expect(settings.getSetting("updates.last_check_at")).toBeTruthy();
  });

  it("returns an available release to manual checks without pushing an event", async () => {
    const { updater, events } = makeUpdater({ feed: createFakeFeed(available) });
    const result = await updater.checkForUpdates("manual");
    expect(result).toEqual({
      status: "available",
      currentVersion: "1.0.0",
      version: "1.1.0",
      releaseNotes: "## What's new\n- faster",
      releaseUrl: "https://example.com/releases/v1.1.0",
    });
    expect(events).toEqual([]);
  });

  it("pushes an available event for background checks", async () => {
    const { updater, events } = makeUpdater({ feed: createFakeFeed(available) });
    await updater.checkForUpdates("auto");
    expect(events).toHaveLength(1);
    expect(events[0]?.phase).toBe("available");
  });

  it("stays silent about a skipped version on background checks", async () => {
    const { updater, events } = makeUpdater({
      feed: createFakeFeed(available),
      settings: createSettings({ "updates.skipped_version": "1.1.0" }),
    });
    await expect(updater.checkForUpdates("auto")).resolves.toMatchObject({ status: "up-to-date" });
    expect(events).toEqual([]);
  });

  it("offers a skipped version to manual checks", async () => {
    const { updater } = makeUpdater({
      feed: createFakeFeed(available),
      settings: createSettings({ "updates.skipped_version": "1.1.0" }),
    });
    await expect(updater.checkForUpdates("manual")).resolves.toMatchObject({ status: "available" });
  });

  it("returns an error result (never throws) when the feed fails", async () => {
    const { updater } = makeUpdater({ feed: createFakeFeed(new Error("network down")) });
    await expect(updater.checkForUpdates("manual")).resolves.toEqual({
      status: "error",
      message: "network down",
    });
  });

  it("shares one in-flight check between concurrent callers", async () => {
    const { updater, feed } = makeUpdater({ feed: createFakeFeed(available) });
    const [a, b] = await Promise.all([updater.checkForUpdates("manual"), updater.checkForUpdates("auto")]);
    expect(feed.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ status: "available" });
    expect(b).toMatchObject({ status: "available" });
  });
});

describe("DesktopUpdater settings and downloads", () => {
  it("persists the auto-check preference", async () => {
    const { updater, settings } = makeUpdater();
    const status = await updater.setAutoCheck(false);
    expect(status.autoCheckEnabled).toBe(false);
    expect(settings.getSetting("updates.auto_check")).toBe("0");
  });

  it("sets and clears the skipped version", async () => {
    const { updater, settings } = makeUpdater();
    await updater.skipVersion("1.1.0");
    expect(settings.getSetting("updates.skipped_version")).toBe("1.1.0");
    await updater.skipVersion(null);
    expect(updater.getStatus().skippedVersion).toBeNull();
  });

  it("forwards download lifecycle as state events and installs on demand", async () => {
    const { updater, feed, events } = makeUpdater();
    await updater.downloadUpdate();
    expect(feed.downloadUpdate).toHaveBeenCalledTimes(1);

    feed.emitProgress({ percent: 42, transferred: 10, total: 24, bytesPerSecond: 5 });
    feed.emitDownloaded("1.1.0");
    expect(events).toEqual([
      { phase: "downloading", progress: { percent: 42, transferred: 10, total: 24, bytesPerSecond: 5 } },
      { phase: "downloaded", version: "1.1.0" },
    ]);

    updater.installUpdate();
    expect(feed.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("refuses to download in unsupported builds", async () => {
    const { updater, feed } = makeUpdater({ isPackaged: false });
    await expect(updater.downloadUpdate()).rejects.toThrow("unavailable");
    expect(feed.downloadUpdate).not.toHaveBeenCalled();
  });

  it("does not expose response headers when a download fails", async () => {
    const feed = createFakeFeed();
    vi.mocked(feed.downloadUpdate).mockRejectedValue(
      new Error('503\nHeaders: { "set-cookie": ["secret"] }'),
    );
    const { updater } = makeUpdater({ feed });
    await expect(updater.downloadUpdate()).rejects.toThrow("Update server returned HTTP 503");
  });
});

describe("DesktopUpdater scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks shortly after launch, then every 6 hours, only while enabled", async () => {
    const { updater, feed } = makeUpdater({ feed: createFakeFeed(available) });
    updater.ensureStarted();

    expect(feed.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(feed.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(feed.checkForUpdates).toHaveBeenCalledTimes(2);

    await updater.setAutoCheck(false);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(feed.checkForUpdates).toHaveBeenCalledTimes(2);

    await updater.setAutoCheck(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(feed.checkForUpdates).toHaveBeenCalledTimes(3);
    updater.dispose();
  });

  it("never schedules in unsupported builds", async () => {
    const { updater, feed } = makeUpdater({ isPackaged: false });
    updater.ensureStarted();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(feed.checkForUpdates).not.toHaveBeenCalled();
  });

  it("swallows background failures with a log line", async () => {
    const { updater, feed, logs } = makeUpdater({ feed: createFakeFeed(new Error("offline")) });
    updater.ensureStarted();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(feed.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(["background check failed: offline"]);
  });
});

describe("normalizeReleaseNotes", () => {
  it("passes markdown strings through and drops empties", () => {
    expect(normalizeReleaseNotes("## Fixed")).toBe("## Fixed");
    expect(normalizeReleaseNotes("  ")).toBeNull();
    expect(normalizeReleaseNotes(null)).toBeNull();
    expect(normalizeReleaseNotes(undefined)).toBeNull();
  });

  it("joins the per-locale array form (macOS) and skips null notes", () => {
    expect(normalizeReleaseNotes([{ note: "A" }, { note: null }, { note: "B" }])).toBe("A\n\nB");
    expect(normalizeReleaseNotes([{ note: null }])).toBeNull();
  });
});

describe("normalizeUpdateError", () => {
  it("drops electron-updater response headers and cookies from HTTP failures", () => {
    const failure = new Error(
      '404\n"method: GET url: https://github.com/example/releases.atom"\nHeaders: {\n  "set-cookie": ["secret"]\n}',
    );
    expect(normalizeUpdateError(failure)).toBe("Update server returned HTTP 404");
  });

  it("keeps concise network errors actionable", () => {
    expect(normalizeUpdateError(new Error("getaddrinfo ENOTFOUND github.com"))).toBe(
      "getaddrinfo ENOTFOUND github.com",
    );
  });
});
