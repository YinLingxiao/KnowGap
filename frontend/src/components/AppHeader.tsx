import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import type { HealthState } from "@/hooks/useWorkbench";
import type { DataSource } from "@/lib/config";
import { cx } from "@/lib/cx";
import { LoopStepper, type LoopStep } from "./LoopStepper";
import { Button } from "./ui/Button";
import styles from "./AppHeader.module.css";

interface AppHeaderProps {
  source: DataSource;
  health: HealthState;
  studentId: string;
  steps: LoopStep[];
  canStartNew: boolean;
  onNewSession: () => void;
  /** Mock 模式下渲染 Mock 控制台入口 */
  mockConsole?: ReactNode;
}

const HEALTH_LABEL: Record<HealthState, string> = {
  checking: "正在连接后端",
  online: "后端在线",
  offline: "后端离线",
};

export function AppHeader({ source, health, studentId, steps, canStartNew, onNewSession, mockConsole }: AppHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <span className={styles.wordmark}>知隙</span>
          <span className={styles.latin} lang="en">
            KnowGap
          </span>
          <span className={styles.subject}>数据结构学习助手</span>
        </div>

        <LoopStepper steps={steps} className={styles.stepper} />

        <div className={styles.actions}>
          {source === "mock" ? (
            mockConsole
          ) : (
            <span className={cx(styles.health, styles[health])}>
              <span className={styles.healthDot} aria-hidden />
              {HEALTH_LABEL[health]}
            </span>
          )}

          <span className={styles.student} title="MVP 使用固定的演示身份，不收集真实学生信息">
            <span className={styles.studentLabel}>演示身份</span>
            <span className={styles.studentId}>{studentId}</span>
          </span>

          <Button
            variant="secondary"
            size="sm"
            className={styles.newSession}
            icon={<Plus size={14} />}
            onClick={onNewSession}
            disabled={!canStartNew}
            aria-label="新会话"
            title="保留学习记忆，重新作答当前题目"
          >
            新会话
          </Button>
        </div>
      </div>
    </header>
  );
}
