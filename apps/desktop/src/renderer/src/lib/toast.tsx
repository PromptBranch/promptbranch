import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastContextValue {
  toast: (message: string, kind?: ToastKind) => void;
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

  const toast = useCallback((message: string, kind: ToastKind = "success") => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-4), { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-2 rounded-lg border border-line bg-raised px-3 py-2.5 shadow-lg shadow-black/40"
          >
            {t.kind === "error" ? (
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
            ) : (
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
            )}
            <span className="text-xs leading-relaxed text-ink">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
