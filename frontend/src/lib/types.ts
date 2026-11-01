/**
 * 前端视图模型（View Model）
 *
 * ⚠️ 这些类型只描述「页面需要展示什么」，不是前后端接口契约。
 * 接口响应由 src/lib/api 与 src/lib/chat/api.ts 映射为这些类型。
 */

export type HealthState = "checking" | "online" | "offline";

/** 学习记忆状态（MVP_SPEC §6.2 建议的四种状态） */
export type MemoryStatus = "suspected" | "needs_review" | "improving" | "resolved";

export interface Problem {
  id: string;
  title: string;
  topicKey: string;
  topicLabel?: string;
  difficulty?: string;
  /** 题干，可用反引号标记 `代码片段` */
  statement: string;
  /** 入栈顺序与待判断序列（后端题目提供时用于排版，不含参考答案） */
  inputSequence?: number[];
  outputSequence?: number[];
}

export interface CourseMaterial {
  id: string; title: string; kind: "pdf" | "txt" | "md" | "csv" | "docx" | "pptx" | "xlsx";
  pageCount: number; chunkCount: number; createdAt: string;
  /** 原始文件字节数：预览面板用它在拉取整份文件前判断要不要降级成「下载查看」 */
  sizeBytes: number;
  /** null：未归入任何 Subject */
  subjectId?: string | null;
}

export interface SourceReference {
  id: string; documentId: string; title: string; label: string;
  page?: number | null; startLine?: number | null; endLine?: number | null; excerpt: string;
}
