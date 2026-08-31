import { clean, compare, prerelease } from "semver";
import { z } from "zod";
import type {
  UpdateAssetDto,
  UpdateCheckSource,
  UpdateCheckStatus,
  UpdateStateDto,
} from "../shared/ipc.js";

export const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/PromptBranch/promptbranch/releases/latest";

const AUTOMATIC_CHECK_SETTING = "updates.automatic_checks";
const LAST_CHECK_SETTING = "updates.last_checked_at";
const RELEASE_CACHE_SETTING = "updates.release_cache";

const githubAssetSchema = z.object({
  name: z.string().min(1).max(300),
  browser_download_url: z.string().url().max(2_000),
  content_type: z.string().max(200),
  size: z.number().int().nonnegative(),
  state: z.string().max(50),
});

const githubReleaseSchema = z.object({
  tag_name: z.string().min(1).max(100),
  name: z.string().max(300).nullable(),
  html_url: z.string().url().max(2_000),
  body: z.string().max(200_000).nullable(),
  published_at: z.string().datetime(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(githubAssetSchema).max(100),
});

type GithubRelease = z.infer<typeof githubReleaseSchema>;

const cachedReleaseSchema = z.object({
  etag: z.string().max(500).nullable(),
  release: githubReleaseSchema,
});

type CachedRelease = z.infer<typeof cachedReleaseSchema>;

export interface UpdateServiceDeps {
  currentVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  runningUnderArm64Translation: boolean;
  launchedFromAppImage: boolean;
  isDevelopment: boolean;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  fetchImpl(input: string, init: RequestInit): Promise<Response>;
  openExternal(url: string): Promise<void>;
  now(): Date;
  emitState(state: UpdateStateDto): void;
}

interface ArtifactSpec {
  name: string;
  label: string;
  kind: UpdateAssetDto["kind"];
  recommended: boolean;
}

interface SelectedAsset extends UpdateAssetDto {
  url: string;
}

class UpdateCheckError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
  }
}

function canonicalReleaseUrl(tag: string): string {
  return `https://github.com/PromptBranch/promptbranch/releases/tag/${encodeURIComponent(tag)}`;
}

function canonicalAssetUrl(tag: string, name: string): string {
  return `https://github.com/PromptBranch/promptbranch/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function stableVersion(release: GithubRelease): string {
  if (release.draft || release.prerelease) {
    throw new UpdateCheckError("GitHub returned an invalid stable release. Try again later.");
  }
  const version = clean(release.tag_name);
  if (
    !version ||
    prerelease(version) !== null ||
    release.tag_name !== `v${version}`
  ) {
    throw new UpdateCheckError("GitHub returned an invalid release version. Try again later.");
  }
  if (release.html_url !== canonicalReleaseUrl(release.tag_name)) {
    throw new UpdateCheckError("GitHub returned an invalid release URL. Try again later.");
  }
  return version;
}

function platformLabel(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

function artifactSpecs(
  version: string,
  platform: NodeJS.Platform,
  architecture: string,
  launchedFromAppImage: boolean,
): ArtifactSpec[] {
  if (architecture !== "arm64" && architecture !== "x64") return [];
  if (platform === "darwin") {
    return [
      {
        name: `promptbranch_${version}_macos_${architecture}.dmg`,
        label: "macOS disk image",
        kind: "dmg",
        recommended: true,
      },
    ];
  }
  if (platform === "win32") {
    return [
      {
        name: `promptbranch_${version}_windows_${architecture}.exe`,
        label: "Windows installer",
        kind: "exe",
        recommended: true,
      },
    ];
  }
  if (platform === "linux") {
    return [
      {
        name: `promptbranch_${version}_linux_${architecture}.AppImage`,
        label: "Linux AppImage",
        kind: "appimage",
        recommended: launchedFromAppImage,
      },
      {
        name: `promptbranch_${version}_linux_${architecture}.deb`,
        label: "Debian package",
        kind: "deb",
        recommended: false,
      },
    ];
  }
  return [];
}

function selectedAssets(
  release: GithubRelease,
  version: string,
  platform: NodeJS.Platform,
  architecture: string,
  launchedFromAppImage: boolean,
): SelectedAsset[] {
  const byName = new Map(release.assets.map((asset) => [asset.name, asset]));
  const selected: SelectedAsset[] = [];
  for (const spec of artifactSpecs(version, platform, architecture, launchedFromAppImage)) {
    const asset = byName.get(spec.name);
    if (
      !asset ||
      asset.state !== "uploaded" ||
      asset.browser_download_url !== canonicalAssetUrl(release.tag_name, asset.name)
    ) {
      continue;
    }
    selected.push({
      ...spec,
      sizeBytes: asset.size,
      url: asset.browser_download_url,
    });
  }
  return selected;
}

function releaseNotes(body: string | null): string | null {
  const value = body?.trim();
  if (!value) return null;
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "• "),
    )
    .join("\n")
    .slice(0, 4_000);
}

function validIsoDate(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function readCachedRelease(raw: string | null): CachedRelease | null {
  if (!raw) return null;
  try {
    return cachedReleaseSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function readTrustedCachedRelease(raw: string | null): CachedRelease | null {
  const cached = readCachedRelease(raw);
  if (!cached) return null;
  try {
    stableVersion(cached.release);
    return cached;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof UpdateCheckError) return error.userMessage;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "The update check timed out. Check your connection and try again.";
  }
  return "Could not check for updates. Check your connection and try again.";
}

export class UpdateService {
  private readonly architecture: string;
  private automaticChecksEnabled: boolean;
  private cachedRelease: CachedRelease | null;
  private state: UpdateStateDto;
  private inFlight: Promise<UpdateStateDto> | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.architecture =
      deps.runningUnderArm64Translation && deps.architecture === "x64"
        ? "arm64"
        : deps.architecture;
    this.automaticChecksEnabled = deps.getSetting(AUTOMATIC_CHECK_SETTING) !== "false";
    this.cachedRelease = readTrustedCachedRelease(deps.getSetting(RELEASE_CACHE_SETTING));
    const lastCheckedAt = validIsoDate(deps.getSetting(LAST_CHECK_SETTING));
    this.state = this.cachedRelease
      ? this.evaluateRelease(this.cachedRelease.release, lastCheckedAt, null)
      : this.emptyState(lastCheckedAt);
  }

  getState(): UpdateStateDto {
    return { ...this.state, assets: this.state.assets.map((asset) => ({ ...asset })) };
  }

  check(source: UpdateCheckSource = "manual"): Promise<UpdateStateDto> {
    if (this.inFlight) return this.inFlight;
    this.state = {
      ...this.state,
      status: "checking",
      checkSource: source,
      errorMessage: null,
    };
    this.emit();
    this.inFlight = this.performCheck(source).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async checkAutomaticallyAtStartup(): Promise<UpdateStateDto | null> {
    if (this.deps.isDevelopment || !this.automaticChecksEnabled) {
      return null;
    }
    return this.check("automatic");
  }

  setAutomaticChecksEnabled(enabled: boolean): UpdateStateDto {
    this.automaticChecksEnabled = enabled;
    this.deps.setSetting(AUTOMATIC_CHECK_SETTING, String(enabled));
    this.state = { ...this.state, automaticChecksEnabled: enabled };
    this.emit();
    return this.getState();
  }

  async openDownload(assetName: string): Promise<void> {
    const release = this.cachedRelease?.release;
    if (!release) throw new Error("No update download is available");
    const version = stableVersion(release);
    const asset = selectedAssets(
      release,
      version,
      this.deps.platform,
      this.architecture,
      this.deps.launchedFromAppImage,
    ).find((candidate) => candidate.name === assetName);
    if (!asset || compare(version, this.currentVersion()) <= 0) {
      throw new Error("That update download is not available");
    }
    await this.deps.openExternal(asset.url);
  }

  async openReleaseNotes(): Promise<void> {
    const release = this.cachedRelease?.release;
    if (!release) throw new Error("No release notes are available");
    stableVersion(release);
    await this.deps.openExternal(release.html_url);
  }

  private async performCheck(source: UpdateCheckSource): Promise<UpdateStateDto> {
    const checkedAt = this.deps.now().toISOString();
    try {
      this.deps.setSetting(LAST_CHECK_SETTING, checkedAt);
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `PromptBranch/${this.deps.currentVersion}`,
      };
      if (this.cachedRelease?.etag) headers["If-None-Match"] = this.cachedRelease.etag;
      const response = await this.deps.fetchImpl(GITHUB_LATEST_RELEASE_URL, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      let release: GithubRelease;
      if (response.status === 304) {
        if (!this.cachedRelease) {
          throw new UpdateCheckError("GitHub returned an invalid cached release. Try again later.");
        }
        release = this.cachedRelease.release;
      } else {
        if (!response.ok) {
          if (response.status === 403 || response.status === 429) {
            throw new UpdateCheckError(
              "GitHub temporarily limited update checks. Try again later.",
            );
          }
          throw new UpdateCheckError(
            `Could not reach the update service (HTTP ${response.status}).`,
          );
        }
        release = githubReleaseSchema.parse(await response.json());
        stableVersion(release);
        this.cachedRelease = {
          etag: response.headers.get("etag"),
          release,
        };
        this.deps.setSetting(RELEASE_CACHE_SETTING, JSON.stringify(this.cachedRelease));
      }

      this.state = this.evaluateRelease(release, checkedAt, source);
    } catch (error) {
      const cached = this.cachedRelease?.release;
      this.state = {
        ...this.emptyState(checkedAt),
        ...(cached
          ? {
              latestVersion: (() => {
                try {
                  return stableVersion(cached);
                } catch {
                  return null;
                }
              })(),
            }
          : {}),
        status: "error",
        checkSource: source,
        errorMessage:
          error instanceof z.ZodError
            ? "GitHub returned an invalid release. Try again later."
            : errorMessage(error),
      };
    }
    this.emit();
    return this.getState();
  }

  private evaluateRelease(
    release: GithubRelease,
    lastCheckedAt: string | null,
    checkSource: UpdateCheckSource | null,
  ): UpdateStateDto {
    const latestVersion = stableVersion(release);
    const currentVersion = this.currentVersion();
    const versionComparison = compare(latestVersion, currentVersion);
    const assets =
      versionComparison > 0
        ? selectedAssets(
            release,
            latestVersion,
            this.deps.platform,
            this.architecture,
            this.deps.launchedFromAppImage,
          )
        : [];
    const status: UpdateCheckStatus =
      versionComparison < 0
        ? "newer-build"
        : versionComparison === 0
          ? "up-to-date"
          : assets.length > 0
            ? "update-available"
            : "no-compatible-download";
    return {
      status,
      currentVersion,
      latestVersion,
      platform: platformLabel(this.deps.platform),
      architecture: this.architecture,
      automaticChecksEnabled: this.automaticChecksEnabled,
      lastCheckedAt,
      checkSource,
      releaseName: release.name?.trim() || `PromptBranch ${latestVersion}`,
      releaseNotes: releaseNotes(release.body),
      publishedAt: release.published_at,
      assets: assets.map(({ url: _url, ...asset }) => asset),
      errorMessage: null,
    };
  }

  private currentVersion(): string {
    const version = clean(this.deps.currentVersion);
    if (!version) {
      throw new UpdateCheckError("PromptBranch could not read the installed version.");
    }
    return version;
  }

  private emptyState(lastCheckedAt: string | null): UpdateStateDto {
    return {
      status: "not-checked",
      currentVersion: this.deps.currentVersion,
      latestVersion: null,
      platform: platformLabel(this.deps.platform),
      architecture: this.architecture,
      automaticChecksEnabled: this.automaticChecksEnabled,
      lastCheckedAt,
      checkSource: null,
      releaseName: null,
      releaseNotes: null,
      publishedAt: null,
      assets: [],
      errorMessage: null,
    };
  }

  private emit(): void {
    this.deps.emitState(this.getState());
  }
}
