import { ArrowRightLeft, BookOpen, Layers, type LucideIcon } from "lucide-react";

/** 按知识点给题目一个图标：栈、队列，其余用书本 */
export function topicIcon(topicKey: string): LucideIcon {
  if (topicKey.startsWith("stack")) return Layers;
  if (topicKey.startsWith("queue")) return ArrowRightLeft;
  return BookOpen;
}
