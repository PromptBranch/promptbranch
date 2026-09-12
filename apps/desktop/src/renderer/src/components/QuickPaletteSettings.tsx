import { useCallback, useEffect, useRef, useState } from "react";
import type { QuickPaletteSettings as Settings, QuickPaletteState } from "../../../shared/ipc.js";
import { cx } from "../lib/time";

const FALLBACK_SETTINGS: Settings = {
  enabled: false,
  accelerator: "CommandOrControl+Shift+Space",
};

export function QuickPaletteSettings() {
  const [state, setState] = useState<QuickPaletteState | null>(null);
  const [settings, setSettings] = useState<Settings>(FALLBACK_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const mounted = useRef(true);

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

      <label className="grid gap-1.5">
        <span className="text-[12px] font-medium text-ink-dim">Global shortcut</span>
        <input
          aria-label="Global shortcut"
          value={settings.accelerator}
          onChange={(event) => setSettings((current) => ({ ...current, accelerator: event.target.value }))}
          className="rounded-md border border-line-strong bg-app px-2.5 py-2 font-mono text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <span className="text-[10px] text-ink-faint">
          Electron accelerator format. Default: CommandOrControl+Shift+Space.
        </span>
      </label>

      <div className="flex items-center justify-between rounded-md border border-line bg-app px-3 py-2">
        <span className="text-[11px] text-ink-faint">Registration status</span>
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
