"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import styles from "./EditorDialog.module.css";

interface EditorDialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * 设置页里的「点开才填」卡片：接口地址、模型、密钥、测试和保存都放在里面，
 * 页面本身只留一排服务商卡片和当前状态，不再把一长串输入框铺在页面上。
 */
export function EditorDialog({ open, title, description, onClose, children }: EditorDialogProps) {
  const { tx } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label={title}
      onClose={(event) => {
        if (event.target !== dialog.current || dialog.current.open) return;
        onClose();
      }}
      onMouseDown={(event) => { if (event.target === dialog.current) onClose(); }}
    >
      <div className={styles.card}>
        <header className={styles.head}>
          <div>
            <h4>{title}</h4>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label={tx("关闭")}>
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
      </div>
    </dialog>
  );
}
