import os from "node:os";
import path from "node:path";

export const DB_FILENAME = "library.db";
export const DB_ENV_VAR = "PROMPTBRANCH_DB";
/** Deprecated alias from the PromptHub era, kept so existing setups keep working. */
export const DB_ENV_VAR_DEPRECATED = "PROMPTHUB_DB";
/** Deprecated alias kept so existing setups (pre-rename) keep working. */
export const DB_ENV_VAR_LEGACY = "PROMPTBUILDER_DB";

/**
 * Resolves the shared library database path used by the desktop app, the CLI
 * and the MCP server. `PROMPTBRANCH_DB` overrides everything (tests, agents
 * pointed at a scratch library, debugging); the PromptHub-era `PROMPTHUB_DB`
 * and the pre-rename `PROMPTBUILDER_DB` are still honored as fallbacks when
 * `PROMPTBRANCH_DB` is unset or blank.
 *
 * Defaults:
 * - macOS:   ~/Library/Application Support/PromptBranch/library.db
 * - Linux:   $XDG_CONFIG_HOME/promptbranch/library.db (or ~/.config)
 * - Windows: %APPDATA%/PromptBranch/library.db
 *
 * `platform` and `home` are injectable purely for tests; callers use the
 * defaults.
 */
export function resolveDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  // First non-blank value wins: a set-but-blank variable must not shadow the
  // remaining fallbacks.
  const override = [env[DB_ENV_VAR], env[DB_ENV_VAR_DEPRECATED], env[DB_ENV_VAR_LEGACY]].find((value) =>
    value?.trim(),
  );
  if (override) return path.resolve(override);

  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "PromptBranch", DB_FILENAME);
    case "win32": {
      const appData = env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
      return path.join(appData, "PromptBranch", DB_FILENAME);
    }
    default: {
      const configHome = env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
      return path.join(configHome, "promptbranch", DB_FILENAME);
    }
  }
}
