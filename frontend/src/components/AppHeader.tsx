import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import type { HealthState } from "@/hooks/useWorkbench";
import type { DataSource } from "@/lib/config";
import { cx } from "@/lib/cx";
import { LoopStepper, type LoopStep } from "./LoopStepper";
import { Button } from "./ui/Button";
import { LogoMark } from "./ui/LogoMark";
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
          <LogoMark size={36} />
          <div>
            <div className={styles.name}>
              KnowGap <span className={styles.cn}>知隙</span>
            </div>
            <div className={styles.tagline}>发现知识漏洞 · 引导自主纠错 · 记住你的学习</div>
          </div>
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
            <span className={styles.avatar} aria-hidden>
              演
            </span>
            <span className={styles.studentText}>
              <span className={styles.studentLabel}>演示学生</span>
              <span className={styles.studentId}>{studentId}</span>
            </span>
          </span>

          <Button
            variant="primary"
            size="sm"
            className={styles.newSession}
            icon={<Plus size={15} />}
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
