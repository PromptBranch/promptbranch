import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { QuickPaletteSettings as Settings, QuickPaletteState } from "../../../shared/ipc.js";
import { cx } from "../lib/time";

const DEFAULT_ACCELERATOR = "CommandOrControl+Shift+Space";

const FALLBACK_SETTINGS: Settings = {
  enabled: false,
  accelerator: DEFAULT_ACCELERATOR,
};

type ShortcutPlatform = "mac" | "windows" | "linux";

const DISPLAY_TOKENS: Record<string, Record<ShortcutPlatform, string>> = {
  CommandOrControl: { mac: "⌘", windows: "Ctrl", linux: "Ctrl" },
  CmdOrCtrl: { mac: "⌘", windows: "Ctrl", linux: "Ctrl" },
  Command: { mac: "⌘", windows: "Command", linux: "Command" },
  Cmd: { mac: "⌘", windows: "Command", linux: "Command" },
  Control: { mac: "⌃", windows: "Ctrl", linux: "Ctrl" },
  Ctrl: { mac: "⌃", windows: "Ctrl", linux: "Ctrl" },
  Alt: { mac: "⌥", windows: "Alt", linux: "Alt" },
  Option: { mac: "⌥", windows: "Alt", linux: "Alt" },
  Shift: { mac: "⇧", windows: "Shift", linux: "Shift" },
  Meta: { mac: "⌘", windows: "Win", linux: "Super" },
  Super: { mac: "⌘", windows: "Win", linux: "Super" },
};

const RECORDED_KEYS: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  "+": "Plus",
  "-": "-",
  ",": ",",
  ".": ".",
  "/": "/",
  ";": ";",
  "'": "'",
  "[": "[",
  "]": "]",
  "\\": "\\",
  "`": "`",
};

function shortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === "undefined") return "linux";
  if (/Mac|iPhone|iPad|iPod/i.test(navigator.platform)) return "mac";
  if (/Win/i.test(navigator.platform)) return "windows";
  return "linux";
}

export function formatShortcut(
  accelerator: string,
  platform = shortcutPlatform(),
): string {
  const tokens = accelerator.split("+").map((token) => {
    const display = DISPLAY_TOKENS[token];
    return display?.[platform] ?? token;
  });
  return tokens.join(platform === "mac" ? " " : " + ");
}

function recordedAccelerator(
  event: KeyboardEvent<HTMLButtonElement>,
  platform = shortcutPlatform(),
): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;

  const mapped = RECORDED_KEYS[event.key];
  const key = mapped
    ?? (/^[a-z0-9]$/i.test(event.key) ? event.key.toUpperCase() : null)
    ?? (/^F(?:[1-9]|1\d|2[0-4])$/i.test(event.key) ? event.key.toUpperCase() : null);
  if (!key) return null;

  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push(platform === "mac" ? "Command" : "Super");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (modifiers.length === 0 && !key.startsWith("F")) return null;
  return [...modifiers, key].join("+");
}

export function QuickPaletteSettings() {
  const [state, setState] = useState<QuickPaletteState | null>(null);
  const [settings, setSettings] = useState<Settings>(FALLBACK_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [recording, setRecording] = useState(false);
  const mounted = useRef(true);
  const recorder = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const next = await window.promptBuilder.quickPalette.getState();
      if (!mounted.current) return;
      setState(next);
      setSettings(next.settings);
    } catch {
      if (mounted.current) setLoadError(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(false);
    try {
      const next = await window.promptBuilder.quickPalette.updateSettings(settings);
      if (!mounted.current) return;
      setState(next);
      setSettings(next.settings);
    } catch {
      if (mounted.current) setSaveError(true);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [settings]);

  const startRecording = useCallback(() => {
    setRecording(true);
    recorder.current?.focus();
  }, []);

  const record = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      return;
    }
    const accelerator = recordedAccelerator(event);
    if (!accelerator) return;
    setSettings((current) => ({ ...current, accelerator }));
    setRecording(false);
  }, []);

  if (loading && !state) {
    return <p className="text-xs text-ink-faint">Loading quick access settings…</p>;
  }

  if (loadError && !state) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-xs text-danger">Quick access settings could not be loaded.</p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-hover"
        >
          Try loading again
        </button>
      </div>
    );
  }

  const registration = state?.registration ?? "disabled";
  const registrationLabel =
    registration === "registered" ? "Registered" : registration === "unavailable" ? "Unavailable" : "Disabled";
  const message = saveError
    ? "Quick access settings could not be saved. Your edits are still here."
    : state?.registrationError ?? null;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[12px] font-medium text-ink-dim">Enable global shortcut</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
            Opens the prompt palette while PromptBranch is already running.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          aria-label="Enable global shortcut"
          onClick={() => setSettings((current) => ({ ...current, enabled: !current.enabled }))}
          className={cx(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors",
            settings.enabled ? "bg-accent" : "bg-line-strong",
          )}
        >
          <span
            className={cx(
              "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]",
              settings.enabled ? "left-4.5" : "left-0.5",
            )}
          />
        </button>
      </div>

      <div className="grid gap-1.5">
        <span className="text-[12px] font-medium text-ink-dim">Keyboard shortcut</span>
        <button
          ref={recorder}
          type="button"
          aria-label="Keyboard shortcut"
          onClick={startRecording}
          onKeyDown={record}
          onBlur={() => setRecording(false)}
          className={cx(
            "rounded-md border bg-app px-2.5 py-2 text-left font-mono text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent",
            recording ? "border-accent" : "border-line-strong",
          )}
        >
          {recording ? "Press shortcut…" : formatShortcut(settings.accelerator)}
        </button>
        <div className="flex gap-3 text-[11px]">
          <button
            type="button"
            onClick={startRecording}
            className="text-accent hover:text-accent-strong focus:outline-none focus:ring-1 focus:ring-accent"
          >
            Record new shortcut
          </button>
          <button
            type="button"
            onClick={() => {
              setRecording(false);
              setSettings((current) => ({ ...current, accelerator: DEFAULT_ACCELERATOR }));
            }}
            className="text-ink-faint hover:text-ink-dim focus:outline-none focus:ring-1 focus:ring-accent"
          >
            Reset to default
          </button>
        </div>
        <span className="text-[10px] text-ink-faint">
          Choose Record new shortcut, then press your preferred key combination.
        </span>
      </div>

      <div className="flex items-center justify-between rounded-md border border-line bg-app px-3 py-2">
        <span className="text-[11px] text-ink-faint">Shortcut status</span>
        <span
          className={cx(
            "text-[11px] font-medium",
            registration === "registered"
              ? "text-success"
              : registration === "unavailable"
                ? "text-danger"
                : "text-ink-dim",
          )}
        >
          {registrationLabel}
        </span>
      </div>

      {message && <p role="alert" className="text-[11px] leading-relaxed text-danger">{message}</p>}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving || !settings.accelerator.trim()}
        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? "Saving…" : saveError ? "Try saving again" : "Save quick access"}
      </button>

      <div className="space-y-2 border-t border-line pt-4 text-[11px] leading-relaxed text-ink-faint">
        <p>
          You can always choose <strong className="font-medium text-ink-dim">Open prompt palette</strong> from the app menu, even when the shortcut is disabled.
        </p>
        <p>
          The palette copies only when you explicitly choose Copy or press Command/Ctrl+Enter. Closing it clears the search, variable values, and preview.
        </p>
        <p>
          On macOS, Quick access remains available after the library window closes while PromptBranch is running. On Windows and Linux, closing the library exits the app.
        </p>
      </div>
    </div>
  );
}
