import type { EmbedTheme } from "../lib/embed-snippet.js";

export function EmbedThemeSelect({
  value,
  onChange,
}: {
  value: EmbedTheme;
  onChange: (value: EmbedTheme) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-[11px] text-ink-faint">
      <span>Embed theme</span>
      <select
        aria-label="Embed theme"
        value={value}
        onChange={(event) => onChange(event.target.value as EmbedTheme)}
        className="rounded-md border border-line bg-app px-2 py-1.5 text-[12px] text-ink transition-colors hover:border-line-strong"
      >
        <option value="auto">Auto</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
