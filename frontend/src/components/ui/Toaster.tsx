"use client";

import { useCallback, useState } from "react";
import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { cx } from "@/lib/cx";
import styles from "./Toaster.module.css";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  tone: "success" | "error" | "info";
  title: string;
  description?: string;
  action?: ToastAction;
}

const ICONS = { success: CircleCheck, error: TriangleAlert, info: Info } as const;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((items) => items.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = Date.now() + Math.random();
      setToasts((items) => [...items.slice(-2), { ...toast, id }]);
      window.setTimeout(() => dismiss(id), toast.tone === "error" || toast.action ? 6000 : 3600);
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

export function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  const { t } = useI18n();
  return (
    <div className={styles.region} role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.tone];
        return (
          <div key={toast.id} className={cx(styles.toast, styles[toast.tone])}>
            <Icon size={18} className={styles.icon} aria-hidden />
            <div className={styles.body}>
              <div className={styles.title}>{toast.title}</div>
              {toast.description && <p className={styles.description}>{toast.description}</p>}
            </div>
            {toast.action && (
              <button
                type="button"
                className={styles.action}
                onClick={() => { toast.action?.onClick(); onDismiss(toast.id); }}
              >
                {toast.action.label}
              </button>
            )}
            <button className={styles.close} onClick={() => onDismiss(toast.id)} aria-label={t("common.close")}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
