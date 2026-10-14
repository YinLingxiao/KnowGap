import type { ReactNode } from "react";
import Image from "next/image";
import { Settings, SquarePen } from "lucide-react";
import type { HealthState, Resource } from "@/hooks/useWorkbench";
import type { DataSource } from "@/lib/config";
import { cx } from "@/lib/cx";
import { topicLabel } from "@/lib/labels";
import type { Problem } from "@/lib/types";
import { ErrorNotice } from "./ErrorNotice";
import { ThemeToggle } from "./ThemeToggle";
import { topicIcon } from "./topicIcon";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  source: DataSource;
  health: HealthState;
  studentId: string;
  problems: Resource<Problem[]>;
  selectedId: string | null;
  memoryCountByTopic: Record<string, number>;
  onSelect: (problemId: string) => void;
  onRetry: () => void;
  disabled: boolean;
  canStartNew: boolean;
  onNewSession: () => void;
  onOpenSettings: () => void;
  /** 最近一次诊断请求报告模型不可用 */
  modelIssue: boolean;
  /** Mock 模式下的 Mock 控制台入口 */
  mockConsole?: ReactNode;
}

const HEALTH_LABEL: Record<HealthState, string> = {
  checking: "正在连接后端",
  online: "后端在线",
  offline: "后端离线",
};

export function Sidebar({
  source,
  health,
  studentId,
  problems,
  selectedId,
  memoryCountByTopic,
  onSelect,
  onRetry,
  disabled,
  canStartNew,
  onNewSession,
  onOpenSettings,
  modelIssue,
  mockConsole,
}: SidebarProps) {
  const { data, loading, error } = problems;

  return (
    <nav className={styles.sidebar} aria-label="主导航">
      <div className={styles.workspace}>
        <span className={styles.logo} aria-hidden>
          <Image src="/brand/knowgap-logo-v1.png" alt="" width={32} height={32} priority />
        </span>
        <span className={styles.latin} lang="en">
          KnowGap
        </span>
        <ThemeToggle />
        <button className={styles.iconButton} onClick={onOpenSettings} aria-label="设置" title="设置（,）">
          <Settings size={15} aria-hidden />
        </button>
      </div>

      <button className={styles.newSession} onClick={onNewSession} disabled={!canStartNew} title="清空本题未提交的草稿，重新作答">
        <SquarePen size={15} aria-hidden />
        新会话
        <kbd className={styles.kbd}>N</kbd>
      </button>

      <div className={styles.source}>
        {source === "mock" ? (
          mockConsole
        ) : (
          <span className={cx(styles.health, styles[health])}>
            <span className={styles.healthDot} aria-hidden />
            {HEALTH_LABEL[health]}
          </span>
        )}
        {source === "api" && modelIssue && (
          <button className={styles.modelIssue} onClick={onOpenSettings} title="打开设置中的模型接入">
            模型未接入
          </button>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>
          题目
          {data.length > 0 && <span className={styles.sectionCount}>{data.length}</span>}
          {source === "mock" && (
            <span className={styles.mockTag} title="题目为前端临时编写的示例，尚未经过教学负责人审定">
              Mock
            </span>
          )}
        </div>

        {loading && data.length === 0 ? (
          <ul aria-busy="true" aria-label="正在加载题目">
            {[0, 1, 2].map((key) => (
              <li key={key} className={styles.skeleton} />
            ))}
          </ul>
        ) : error && data.length === 0 ? (
          <ErrorNotice error={error} compact onRetry={onRetry} />
        ) : data.length === 0 ? (
          <p className={styles.empty}>暂无可用题目</p>
        ) : (
          <ul className={styles.list}>
            {data.map((problem) => {
              const selected = problem.id === selectedId;
              const related = memoryCountByTopic[problem.topicKey] ?? 0;
              const Icon = topicIcon(problem.topicKey);
              const topic = topicLabel(problem.topicKey, problem.topicLabel);
              return (
                <li key={problem.id}>
                  <button
                    className={cx(styles.item, selected && styles.active)}
                    onClick={() => onSelect(problem.id)}
                    disabled={disabled && !selected}
                    aria-current={selected ? "page" : undefined}
                    title={disabled ? "正在处理当前请求，完成后再切换题目" : `${topic}${problem.difficulty ? ` · ${problem.difficulty}` : ""}`}
                  >
                    <Icon size={15} className={styles.itemIcon} aria-hidden />
                    <span className={styles.itemLabel}>{problem.title}</span>
                    {related > 0 && (
                      <span className={styles.count} title={`该知识点有 ${related} 条学习记忆`}>
                        {related}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className={styles.footer} title="MVP 使用固定的演示身份，不收集真实学生信息">
        <span className={styles.avatar} aria-hidden>
          演
        </span>
        <span className={styles.identity}>
          <span className={styles.identityLabel}>演示身份</span>
          <span className={styles.identityId}>{studentId}</span>
        </span>
      </div>
    </nav>
  );
}
