/**
 * Theme mode (dark | light | system) persisted in localStorage under
 * `promptbuilder:theme` (pre-rename key kept on purpose — renaming it would
 * reset existing users' theme preference). The resolved theme is applied as
 * `data-theme` on <html>; index.html runs an inline script before first paint
 * that reads the same key so there is no dark flash on load — keep the key
 * and resolution logic in sync with that script.
 */

import { useSyncExternalStore } from "react";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "promptbuilder:theme";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") return stored;
  } catch {
    // localStorage unavailable — fall through to the default
  }
  return "system";
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? (media.matches ? "dark" : "light") : mode;
}

export function currentTheme(): ResolvedTheme {
  return resolveTheme(getThemeMode());
}

/** Apply a mode now; "system" additionally tracks prefers-color-scheme. */
export function applyThemeMode(mode: ThemeMode): void {
  const apply = () => {
    document.documentElement.dataset.theme = resolveTheme(mode);
    emit();
  };
  apply();
  media.removeEventListener("change", apply);
  if (mode === "system") media.addEventListener("change", apply);
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // persistence is best-effort
  }
  applyThemeMode(mode);
}

/** App boot: honor the stored preference (defaults to system). */
export function initTheme(): void {
  applyThemeMode(getThemeMode());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Resolved theme, re-rendering when it changes (mode switch or OS change). */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, currentTheme);
}

/** Current mode + setter for the settings UI. Subscribes on the mode itself
   (not the resolved theme), so the highlight updates even when the resolved
   theme stays the same (e.g. picking Dark while the OS is already dark). */
export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const mode = useSyncExternalStore(subscribe, getThemeMode);
  return [mode, setThemeMode];
}
