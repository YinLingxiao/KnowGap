import { ArrowRight, Brain, Database, MessageCircle } from "lucide-react";
import { Button } from "./ui/Button";
import styles from "./WelcomeHero.module.css";

const FEATURES = [
  { icon: Brain, title: "认知诊断", text: "结合参考解分析你的思路，指出疑似误区与依据；答对了就不会硬找错。" },
  { icon: MessageCircle, title: "苏格拉底式引导", text: "每轮只问一个可回答的问题，由浅入深，让你自己发现问题。" },
  { icon: Database, title: "学习记忆", text: "只记录有证据的学习状态，下次学习同类题时调整提问方式。" },
];

const DEMO_ROUTE = [
  "选一道「栈」的题目，故意给出一个错误判断",
  "跟随导师追问，完成至少 3 轮对话",
  "在右侧查看生成的学习记忆及其证据",
  "换一道同知识点的题目开始新会话，观察导师如何参考历史",
];

export function WelcomeHero({ onStart, canStart }: { onStart: () => void; canStart: boolean }) {
  return (
    <section className={styles.hero}>
      <div className={styles.art} aria-hidden>
        <StackIllustration />
      </div>
      <p className={styles.eyebrow}>AI + 学习 · 数据结构</p>
      <h1 className={styles.title}>
        不急着给答案，
        <br />
        先找到你的<span className={styles.highlight}>知识缝隙</span>
      </h1>
      <p className={styles.lead}>
        KnowGap 会先诊断你的解题思路，再用一个个问题引导你自己纠正，并把有证据支持的学习状态记下来——下一次，它会更懂你。
      </p>
      <Button variant="primary" size="lg" onClick={onStart} disabled={!canStart} icon={<ArrowRight size={16} />}>
        从第一题开始
      </Button>

      <ul className={styles.features}>
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <li key={title} className={styles.feature}>
            <span className={styles.featureIcon}>
              <Icon size={18} aria-hidden />
            </span>
            <span className={styles.featureTitle}>{title}</span>
            <span className={styles.featureText}>{text}</span>
          </li>
        ))}
      </ul>

      <div className={styles.route}>
        <div className={styles.routeTitle}>推荐演示路线</div>
        <ol className={styles.routeList}>
          {DEMO_ROUTE.map((step, index) => (
            <li key={step}>
              <span className={styles.routeIndex}>{index + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** 一个缺了一块的栈：缺口处的亮点就是要找到的「知隙」 */
function StackIllustration() {
  return (
    <svg viewBox="0 0 160 140" width="160" height="140">
      <path d="M30 22 V122 H130 V22" fill="none" stroke="var(--line-strong)" strokeWidth="3" strokeLinecap="round" />
      <rect x="40" y="98" width="80" height="16" rx="5" fill="var(--primary)" opacity="0.9" />
      <rect x="40" y="78" width="80" height="16" rx="5" fill="var(--primary)" opacity="0.7" />
      <rect x="40" y="58" width="80" height="16" rx="5" fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="5 4" />
      <circle cx="80" cy="66" r="4.5" fill="var(--accent)" />
      <rect x="40" y="38" width="80" height="16" rx="5" fill="var(--primary)" opacity="0.45" />
      <path d="M140 46 C150 46 150 30 140 30" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" />
      <path d="M136 26 L141 30 L136 34" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
