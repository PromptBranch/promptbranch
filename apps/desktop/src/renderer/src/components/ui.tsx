import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Star, X } from "lucide-react";
import { cx } from "../lib/time";

export const TAG_PALETTE = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#14b8a6",
  "#6366f1",
];

/** Deterministic palette color for a name (used for tags/collections). */
export function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[hash % TAG_PALETTE.length]!;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
      {children}
    </div>
  );
}

/** Initial-tile icon for a provider (first letters, accent-tinted — no external logos). */
export function ProviderTile({ label, size = 7 }: { label: string; size?: number }) {
  const initials = label
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className={cx(
        "flex shrink-0 items-center justify-center rounded-md border border-line bg-accent-soft font-semibold tracking-wide text-accent",
        size === 7 ? "h-7 w-7 text-[10px]" : "h-8 w-8 text-[11px]",
      )}
    >
      {initials || "?"}
    </span>
  );
}

/** On/off switch (provider master toggles, per-model visibility). */
export function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
      className={cx(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "bg-accent" : "bg-line-strong",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]",
          checked ? "left-4.5" : "left-0.5",
        )}
      />
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function IconButton({ active, className, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        "flex h-7 w-7 items-center justify-center rounded-md text-ink-dim transition-colors",
        "hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active && "bg-accent-soft text-accent",
        className,
      )}
      {...props}
    />
  );
}

export function TagChip({
  name,
  color,
  onRemove,
}: {
  name: string;
  color: string | null;
  onRemove?: () => void;
}) {
  return (
    <span className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-raised px-2 py-0.5 text-[11px] text-ink-dim">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color ?? "#6b7280" }} />
      <span className="max-w-40 truncate">{name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="ml-0.5 rounded-full text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
          aria-label={`Remove tag ${name}`}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-panel text-ink-faint">
        {icon}
      </div>
      <p className="text-sm font-medium text-ink-dim">{title}</p>
      {hint && <p className="max-w-64 text-xs leading-relaxed text-ink-faint">{hint}</p>}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex h-full min-h-32 items-center justify-center">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
    </div>
  );
}

/** Read-only 1–5 star display. Renders nothing when value is null. */
export function Stars({ value, size = 12 }: { value: number | null; size?: number }) {
  if (value === null) return null;
  return (
    <span className="inline-flex items-center gap-px text-star" aria-label={`${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={size} fill={i <= value ? "currentColor" : "none"} className={i <= value ? "" : "text-ink-faint"} />
      ))}
    </span>
  );
}

/** Interactive 1–5 star selector. Clicking the current value clears it. */
export function StarRatingInput({
  value,
  onChange,
  size = 20,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  size?: number;
}) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          onClick={() => onChange(value === i ? null : i)}
          aria-label={`${i} star${i > 1 ? "s" : ""}`}
          className={cx(
            "rounded p-0.5 transition-colors",
            value !== null && i <= value ? "text-star" : "text-ink-faint hover:text-star",
          )}
        >
          <Star size={size} fill={value !== null && i <= value ? "currentColor" : "none"} />
        </button>
      ))}
    </span>
  );
}
