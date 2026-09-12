import path from "node:path";

const QA_USER_DATA_ENV = "PROMPTBRANCH_QA_USER_DATA";

export interface QaProfileApp {
  setPath(name: "userData", value: string): void;
}

/**
 * Keeps built-app QA away from the user's real Electron profile. This hook is
 * intentionally opt-in and absolute-only so a typo cannot redirect userData
 * into the repository or another relative working directory.
 */
export function applyQaUserDataOverride(
  app: QaProfileApp,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env[QA_USER_DATA_ENV]?.trim();
  if (!configured) return null;
  if (!path.isAbsolute(configured)) {
    throw new Error(`${QA_USER_DATA_ENV} must be an absolute path`);
  }

  const normalized = path.normalize(configured);
  app.setPath("userData", normalized);
  return normalized;
}
