/**
 * Small typed localStorage preference store. `usePref` re-renders on change
 * (via useSyncExternalStore), so settings apply live. Theme has its own
 * module (lib/theme.ts) because it must also run pre-paint in index.html.
 */
import { useSyncExternalStore } from "react";

export type EditorModePref = "edit" | "preview" | "split";

interface PrefsSchema {
  /** CodeMirror font size in px; applied via the --cm-font-size CSS var. */
  "editor-font-size": number;
  /** Default editor mode when opening the current version of a prompt. */
  "editor-mode": EditorModePref;
  /** CodeMirror line wrapping. */
  "word-wrap": boolean;
  /** Persist in-progress edits as drafts. Off = edits live only in memory until saved as a version. */
  "autosave-drafts": boolean;
}

export type PrefKey = keyof PrefsSchema;

const DEFAULTS: PrefsSchema = {
  "editor-font-size": 13,
  "editor-mode": "edit",
  "word-wrap": true,
  "autosave-drafts": true,
};

// Intentionally keeps the pre-rename "promptbuilder:" prefix: renaming the
// keys would silently reset existing users' stored preferences.
const PREFIX = "promptbuilder:pref:";

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getPref<K extends PrefKey>(key: K): PrefsSchema[K] {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === typeof DEFAULTS[key]) return parsed as PrefsSchema[K];
    }
  } catch {
    // fall through to the default
  }
  return DEFAULTS[key];
}

export function setPref<K extends PrefKey>(key: K, value: PrefsSchema[K]): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // persistence is best-effort
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePref<K extends PrefKey>(key: K): [PrefsSchema[K], (value: PrefsSchema[K]) => void] {
  const value = useSyncExternalStore(subscribe, () => JSON.stringify(getPref(key)));
  return [JSON.parse(value) as PrefsSchema[K], (next) => setPref(key, next)];
}
