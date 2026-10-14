import { ArrowRight } from "lucide-react";
import { Button } from "./ui/Button";
import styles from "./WelcomeHero.module.css";

/** 未选题时的导读：用一条标明的批注示例说明差异 */
export function WelcomeHero({ onStart, canStart }: { onStart: () => void; canStart: boolean }) {
  return (
    <section className={styles.guide} aria-labelledby="guide-title">
      <h1 id="guide-title" className={styles.title}>
        先作答，再一起找出那道缝隙
      </h1>

      <p className={styles.exampleLabel}>示例，不是实时诊断</p>
      <div className={styles.example}>
        <p className={styles.exampleAnswer}>
          合法，因为
          <mark>这些数字都在入栈序列里</mark>
          。
        </p>
        <aside className={styles.exampleNote}>
          <span>批注 · 疑似误区</span>
          <p>数字都出现过，还不能说明弹出的时候它是栈顶。</p>
        </aside>
      </div>

      <div className={styles.actions}>
        <Button variant="primary" size="lg" onClick={onStart} disabled={!canStart} icon={<ArrowRight size={16} />}>
          从第一题开始
        </Button>
      </div>

      <details className={styles.more}>
        <summary>这个过程是怎样的</summary>
        <ol>
          <li>写下判断和理由。</li>
          <li>导师在原文上划出依据，并写下批注。</li>
          <li>接着只追问当前这一个问题，由你自己往下推。</li>
          <li>有证据的学习状态会记下，下次同类题作参考。想确认时，可以清空引导，重新独立作答。</li>
        </ol>
      </details>
    </section>
  );
}
