import { Fragment } from "react";
import styles from "./RichText.module.css";

/** 把 `反引号` 包裹的片段渲染为代码样式，其余按纯文本输出（换行由容器的 pre-wrap 保留） */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={index} className={styles.code}>
            {part.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function plainText(text: string): string {
  return text.replace(/`/g, "");
}
