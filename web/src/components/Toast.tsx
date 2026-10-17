import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/** An optional button in the toast, e.g. Undo. A toast with one stays up longer. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

type Show = (message: string, action?: ToastAction) => void;

const ToastContext = createContext<Show>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string; action?: ToastAction }[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback<Show>(
    (message, action) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t, { id, message, action }]);
      setTimeout(() => dismiss(id), action ? 6000 : 3200);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.action ? " has-action" : ""}`}>
            {t.message}
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
