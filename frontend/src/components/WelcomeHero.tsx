import { ArrowRight } from "lucide-react";
import { Button } from "./ui/Button";
import styles from "./WelcomeHero.module.css";

const DEMO_ROUTE = [
  { title: "作答", text: "选一道栈的题目，写下判断和理由。可以故意答错，看看系统怎样处理。" },
  { title: "诊断", text: "导师在你的原文上划出依据，写下批注：哪里可能有误区，或者确认你答对了。" },
  { title: "引导", text: "导师每次只问一个能回答的问题，至少往来三轮，由你自己推出结论。" },
  { title: "记忆", text: "有证据的学习状态记入右侧；换一道同类题时，导师会参考它调整提问。" },
];

/** 未选题时的导读：说明这页能做什么，以及路演时的推荐顺序 */
export function WelcomeHero({ onStart, canStart }: { onStart: () => void; canStart: boolean }) {
  return (
    <section className={styles.guide} aria-labelledby="guide-title">
      <h1 id="guide-title" className={styles.title}>
        先作答，再一起找出那道缝隙
      </h1>
      <p className={styles.lead}>
        知隙不急着给答案。它先读你的作答，标出可能有问题的地方，再用一个个问题引导你自己发现；有证据支持的学习状态会记下来，下次遇到同类题时作为参考。
      </p>

      <ol className={styles.route}>
        {DEMO_ROUTE.map((step, index) => (
          <li key={step.title} className={styles.step}>
            <span className={styles.stepIndex}>{index + 1}</span>
            <span className={styles.stepTitle}>{step.title}</span>
            <span className={styles.stepText}>{step.text}</span>
          </li>
        ))}
      </ol>

      <div className={styles.actions}>
        <Button variant="primary" size="lg" onClick={onStart} disabled={!canStart} icon={<ArrowRight size={16} />}>
          从第一题开始
        </Button>
        <span className={styles.hint}>也可以在左侧目录中任选一题</span>
      </div>
    </section>
  );
}
