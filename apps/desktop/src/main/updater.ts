import type {
  UpdateAvailableInfo,
  UpdateCheckResultDto,
  UpdateProgress,
  UpdateStateEvent,
  UpdateStatusDto,
  UpdateUnsupportedReason,
} from "../shared/ipc.js";

/**
 * In-app updates from GitHub Releases (electron-updater underneath — see
 * updater-github.ts). UX follows the OpenUsage pattern: silent background
 * checks, a Settings toggle, a manual "Check for Updates" and a release-notes
 * dialog with download / skip / postpone. This module owns policy (when to
 * check, what to offer, what to persist) and stays free of Electron and
 * electron-updater imports so tests drive it with a fake feed.
 */

/** The settings-table slice the updater reads/writes (device-local, never synced). */
export interface SettingsStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

const AUTO_CHECK_SETTING = "updates.auto_check";
const SKIPPED_SETTING = "updates.skipped_version";
const LAST_CHECK_SETTING = "updates.last_check_at";

/** Background checks start a beat after launch, then repeat while the app runs. */
const STARTUP_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateFeedResult {
  isUpdateAvailable: boolean;
  updateInfo: {
    version: string;
    /** GitHub release body; electron-updater hands macOS an array per locale. */
    releaseNotes?: string | Array<{ note: string | null }> | null;
  };
}

/** The electron-updater surface this service depends on (faked in tests). */
export interface UpdaterFeed {
  checkForUpdates(): Promise<UpdateFeedResult | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  onProgress(listener: (progress: UpdateProgress) => void): () => void;
  onDownloaded(listener: (info: { version: string }) => void): () => void;
}

export interface DesktopUpdaterDeps {
  settings: SettingsStore;
  feed: UpdaterFeed;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** Linux AppImages export $APPIMAGE; other install types cannot self-update. */
  appImageEnv: boolean;
  appVersion: string;
  releaseUrlFor: (version: string) => string;
  sendEvent: (event: UpdateStateEvent) => void;
  log: (message: string) => void;
}

/** electron-updater's per-locale notes array → one markdown string. */
export function normalizeReleaseNotes(
  notes: string | Array<{ note: string | null }> | null | undefined,
): string | null {
  if (!notes) return null;
  if (typeof notes === "string") return notes.trim() === "" ? null : notes;
  const joined = notes
    .map((entry) => entry.note ?? "")
    .filter((note) => note.trim() !== "")
    .join("\n\n");
  return joined === "" ? null : joined;
}

/** Keep updater failures actionable without forwarding response headers. */
export function normalizeUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "")
    ?.replace(/^Error:\s*/, "");
  if (!firstLine) return "Update check failed";
  const httpStatus = /^(?:HttpError:\s*)?(\d{3})(?:\b|\s|$)/.exec(firstLine)?.[1];
  if (httpStatus) return `Update server returned HTTP ${httpStatus}`;
  return firstLine.slice(0, 300);
}

export class DesktopUpdater {
  private inFlight: Promise<UpdateCheckResultDto> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DesktopUpdaterDeps) {
    // Download lifecycle is event-driven; download() rejections carry errors.
    this.deps.feed.onProgress((progress) => this.deps.sendEvent({ phase: "downloading", progress }));
    this.deps.feed.onDownloaded((info) => this.deps.sendEvent({ phase: "downloaded", version: info.version }));
  }

  unsupportedReason(): UpdateUnsupportedReason | null {
    if (!this.deps.isPackaged) return "dev-build";
    if (this.deps.platform === "linux" && !this.deps.appImageEnv) return "linux-package";
    return null;
  }

  supported(): boolean {
    return this.unsupportedReason() === null;
  }

  private autoCheckEnabled(): boolean {
    const raw = this.deps.settings.getSetting(AUTO_CHECK_SETTING);
    return raw === null ? true : raw === "1";
  }

  private skippedVersion(): string | null {
    return this.deps.settings.getSetting(SKIPPED_SETTING) || null;
  }

  getStatus(): UpdateStatusDto {
    const reason = this.unsupportedReason();
    return {
      supported: reason === null,
      unsupportedReason: reason,
      autoCheckEnabled: this.autoCheckEnabled(),
      currentVersion: this.deps.appVersion,
      lastCheckAt: this.deps.settings.getSetting(LAST_CHECK_SETTING) || null,
      skippedVersion: this.skippedVersion(),
    };
  }

  async setAutoCheck(enabled: boolean): Promise<UpdateStatusDto> {
    this.deps.settings.setSetting(AUTO_CHECK_SETTING, enabled ? "1" : "0");
    this.resetSchedule();
    return this.getStatus();
  }

  /** `null` clears the skip so the release is offered again. */
  async skipVersion(version: string | null): Promise<void> {
    this.deps.settings.setSetting(SKIPPED_SETTING, version ?? "");
  }

  /** Schedules the startup + interval background checks (no-op when disabled). */
  ensureStarted(): void {
    this.resetSchedule();
  }

  private resetSchedule(): void {
    this.clearSchedule();
    if (!this.supported() || !this.autoCheckEnabled()) return;
    this.startupTimer = setTimeout(() => void this.backgroundCheck(), STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
    this.intervalTimer = setInterval(() => void this.backgroundCheck(), CHECK_INTERVAL_MS);
    this.intervalTimer.unref?.();
  }

  private clearSchedule(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
  }

  dispose(): void {
    this.clearSchedule();
  }

  private async backgroundCheck(): Promise<void> {
    // Background checks must never disturb the user: swallow everything.
    const result = await this.checkForUpdates("auto");
    if (result.status === "error") this.deps.log(`background check failed: ${result.message}`);
  }

  /**
   * Manual checks bypass the skipped version; background checks honor it and
   * stay silent. Concurrent calls share one in-flight check.
   */
  async checkForUpdates(reason: "auto" | "manual"): Promise<UpdateCheckResultDto> {
    const unsupported = this.unsupportedReason();
    if (unsupported) return { status: "unsupported", reason: unsupported };
    if (this.inFlight) return this.inFlight;
    const task = this.runCheck(reason);
    this.inFlight = task;
    try {
      return await task;
    } finally {
      this.inFlight = null;
    }
  }

  private async runCheck(reason: "auto" | "manual"): Promise<UpdateCheckResultDto> {
    try {
      const result = await this.deps.feed.checkForUpdates();
      this.touchLastCheck();
      if (!result || !result.isUpdateAvailable) {
        return { status: "up-to-date", currentVersion: this.deps.appVersion };
      }
      const info: UpdateAvailableInfo = {
        currentVersion: this.deps.appVersion,
        version: result.updateInfo.version,
        releaseNotes: normalizeReleaseNotes(result.updateInfo.releaseNotes),
        releaseUrl: this.deps.releaseUrlFor(result.updateInfo.version),
      };
      if (reason === "auto" && info.version === this.skippedVersion()) {
        // The user opted out of exactly this release — keep quiet about it.
        return { status: "up-to-date", currentVersion: info.currentVersion };
      }
      if (reason === "auto") {
        this.deps.sendEvent({ phase: "available", ...info });
      }
      return { status: "available", ...info };
    } catch (err) {
      // A failed check (offline, GitHub down) still counts as "checked".
      this.touchLastCheck();
      return { status: "error", message: normalizeUpdateError(err) };
    }
  }

  private touchLastCheck(): void {
    this.deps.settings.setSetting(LAST_CHECK_SETTING, new Date().toISOString());
  }

  /** Downloads to staging; progress/downloaded arrive as state events. */
  async downloadUpdate(): Promise<void> {
    if (!this.supported()) throw new Error("Updates are unavailable in this build");
    try {
      await this.deps.feed.downloadUpdate();
    } catch (error) {
      throw new Error(normalizeUpdateError(error));
    }
  }

  /** Restarts into the downloaded update (autoInstallOnAppQuit covers "later"). */
  installUpdate(): void {
    this.deps.feed.quitAndInstall();
  }
}
