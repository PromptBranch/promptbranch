import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle, Info } from "lucide-react";

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  persistent: boolean;
  action?: ToastAction;
  dismissLabel?: string;
}

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  action?: ToastAction;
  durationMs?: number | null;
  dismissLabel?: string;
}

interface ToastContextValue {
  toast: (message: string, kind?: ToastKind, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, kind: ToastKind = "success", options?: ToastOptions) => {
      const id = nextId.current++;
      const durationMs = options?.durationMs === undefined ? 3600 : options.durationMs;
      setToasts((current) => {
        const next = [
          ...current,
          {
            id,
            message,
            kind,
            persistent: durationMs === null,
            ...(options?.action ? { action: options.action } : {}),
            ...(options?.dismissLabel ? { dismissLabel: options.dismissLabel } : {}),
          },
        ];
        const expiring = next.filter((item) => !item.persistent);
        if (expiring.length <= 5) return next;
        const oldestExpiringId = expiring[0]?.id;
        return next.filter((item) => item.id !== oldestExpiringId);
      });
      if (durationMs !== null) {
        window.setTimeout(() => {
          setToasts((current) => current.filter((t) => t.id !== id));
        }, durationMs);
      }
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className="pointer-events-auto flex items-start gap-2 rounded-lg border border-line bg-raised px-3 py-2.5 shadow-lg shadow-black/40"
          >
            {t.kind === "error" ? (
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
            ) : t.kind === "info" ? (
              <Info size={15} className="mt-0.5 shrink-0 text-accent" />
            ) : (
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
            )}
            <span className="min-w-0 flex-1 text-xs leading-relaxed text-ink">{t.message}</span>
            {t.dismissLabel || t.action ? (
              <div className="flex shrink-0 items-center gap-1">
                {t.dismissLabel ? (
                  <button
                    type="button"
                    onClick={() => dismiss(t.id)}
                    className="rounded px-1 py-0.5 text-[11px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  >
                    {t.dismissLabel}
                  </button>
                ) : null}
                {t.action ? (
                  <button
                    type="button"
                    onClick={() => {
                      t.action?.onClick();
                      dismiss(t.id);
                    }}
                    className="rounded px-1 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-hover hover:text-accent-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  >
                    {t.action.label}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
