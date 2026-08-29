import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
import type { UpdateProgress } from "../shared/ipc.js";
import type { UpdaterFeed } from "./updater.js";

/**
 * The GitHub feed behind DesktopUpdater. Mirrors the `publish` config in
 * apps/desktop/package.json — kept explicit because the repo's dual `origin`
 * push URLs (internal Gitea + GitHub) make electron-builder's git-remote
 * detection unreliable, and because pinning it makes electron-builder embed
 * resources/app-update.yml, which the packaged app reads at runtime.
 */
export const UPDATE_REPO = { owner: "PromptBranch", repo: "promptbranch" } as const;

export function githubReleaseUrl(version: string): string {
  return `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/tag/v${version}`;
}

function toProgress(info: ProgressInfo): UpdateProgress {
  return {
    percent: info.percent,
    transferred: info.transferred,
    total: info.total,
    bytesPerSecond: info.bytesPerSecond,
  };
}

/** Bridges electron-updater's event-emitter API onto the UpdaterFeed shape. */
export function createGithubUpdaterFeed(): UpdaterFeed {
  // Downloads staged by downloadUpdate() install on the next normal quit, so
  // "later" still gets the update. Only releases GitHub marks "latest".
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  // We log outcomes ourselves ([update] …); keep the updater's internal
  // chatter out of stdout.
  autoUpdater.logger = null;
  return {
    async checkForUpdates() {
      const result = await autoUpdater.checkForUpdates();
      if (!result) return null;
      return {
        isUpdateAvailable: result.isUpdateAvailable,
        updateInfo: {
          version: result.updateInfo.version,
          releaseNotes: result.updateInfo.releaseNotes ?? null,
        },
      };
    },
    downloadUpdate: () => autoUpdater.downloadUpdate(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    onProgress(listener) {
      const handler = (progress: ProgressInfo) => listener(toProgress(progress));
      autoUpdater.on("download-progress", handler);
      return () => autoUpdater.removeListener("download-progress", handler);
    },
    onDownloaded(listener) {
      const handler = (info: UpdateInfo) => listener({ version: info.version });
      autoUpdater.on("update-downloaded", handler);
      return () => autoUpdater.removeListener("update-downloaded", handler);
    },
  };
}
