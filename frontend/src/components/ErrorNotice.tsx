import { useEffect, useRef } from "react";
import {
  CircleHelp,
  RotateCcw,
  ServerCrash,
  Timer,
  TriangleAlert,
  Unplug,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { describeError, type ApiError, type ApiErrorKind, type ErrorContext } from "@/lib/api/errors";
import { cx } from "@/lib/cx";
import { Button } from "./ui/Button";
import styles from "./ErrorNotice.module.css";

const ICONS: Record<ApiErrorKind, LucideIcon> = {
  network: WifiOff,
  timeout: Timer,
  model_unavailable: ServerCrash,
  not_found: CircleHelp,
  validation: TriangleAlert,
  conflict: TriangleAlert,
  server: ServerCrash,
  contract_pending: Unplug,
  unknown: TriangleAlert,
};

interface ErrorNoticeProps {
  error: ApiError;
  context?: ErrorContext;
  compact?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
  onRestart?: () => void;
  onDismiss?: () => void;
  /** 出现时滚动到可见区域（用于页面下方的操作错误） */
  reveal?: boolean;
  className?: string;
}

export function ErrorNotice({
  error,
  context = "general",
  compact = false,
  onRetry,
  retryLabel = "重试",
  onRestart,
  onDismiss,
  reveal = false,
  className,
}: ErrorNoticeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const copy = describeError(error, context);
  const Icon = ICONS[error.kind];
  const showDetail = error.message && error.message !== copy.title;

  useEffect(() => {
    if (reveal) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [reveal, error]);

  return (
    <div
      ref={ref}
      role="alert"
      className={cx(styles.notice, compact && styles.compact, error.kind === "contract_pending" && styles.neutral, className)}
    >
      <span className={styles.icon}>
        <Icon size={compact ? 16 : 18} aria-hidden />
      </span>
      <div className={styles.body}>
        <div className={styles.title}>{copy.title}</div>
        <p className={styles.hint}>{copy.hint}</p>
        {showDetail && <p className={styles.detail}>详情：{error.message}</p>}
        {(onRetry || onRestart) && (
          <div className={styles.actions}>
            {onRestart && (
              <Button size="sm" variant="primary" icon={<RotateCcw size={14} />} onClick={onRestart}>
                重新开始作答
              </Button>
            )}
            {onRetry && (
              <Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} onClick={onRetry}>
                {retryLabel}
              </Button>
            )}
          </div>
        )}
      </div>
      {onDismiss && (
        <button className={styles.close} onClick={onDismiss} aria-label="关闭提示">
          <X size={14} />
        </button>
      )}
    </div>
  );
}
