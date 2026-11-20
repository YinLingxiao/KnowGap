"use client";

import {
  Atom, BarChart3, Bookmark, BookOpen, Brain, Briefcase, Calculator, Code2, Compass, Cpu,
  Database, Dna, FlaskConical, Folder, Globe, GraduationCap, Heart, Landmark, Languages, Lightbulb,
  Music, NotebookPen, Palette, Puzzle, Rocket, Scale, Sigma, Stethoscope, Target, Terminal,
  Wrench, Zap, type LucideIcon,
} from "lucide-react";

export const DEFAULT_SPACE_ICON = "graduation-cap" as const;

export interface SpaceIconOption {
  id: string;
  label: string;
  keywords: string;
  icon: LucideIcon;
}

export const SPACE_ICONS: readonly SpaceIconOption[] = [
  { id: "graduation-cap", label: "学习", keywords: "学习 毕业帽 考试 课程 study learn exam course", icon: GraduationCap },
  { id: "folder", label: "文件夹", keywords: "文件夹 项目 通用 空间 folder project space", icon: Folder },
  { id: "book-open", label: "书本", keywords: "书本 阅读 教材 语文 文学 book read textbook literature", icon: BookOpen },
  { id: "notebook-pen", label: "笔记", keywords: "笔记 作业 写作 整理 note write homework notebook", icon: NotebookPen },
  { id: "code", label: "编程", keywords: "代码 编程 算法 汇编 java python cpp code programming cs", icon: Code2 },
  { id: "terminal", label: "终端", keywords: "终端 命令行 操作系统 linux shell terminal os", icon: Terminal },
  { id: "cpu", label: "计组", keywords: "计组 芯片 硬件 计算机组成 体系结构 cpu hardware architecture", icon: Cpu },
  { id: "database", label: "数据结构", keywords: "数据库 数据结构 存储 sql data structure database", icon: Database },
  { id: "calculator", label: "数学", keywords: "数学 计算 高数 线代 竞赛 math calculus algebra", icon: Calculator },
  { id: "sigma", label: "公式", keywords: "公式 概率 统计 离散 sigma probability statistics formula", icon: Sigma },
  { id: "atom", label: "物理", keywords: "物理 原子 科学 力学 电磁 physics atom science", icon: Atom },
  { id: "flask-conical", label: "化学", keywords: "化学 实验 有机 无机 chemistry flask lab experiment", icon: FlaskConical },
  { id: "dna", label: "生物", keywords: "生物 基因 生命 分子 biology dna genetics life", icon: Dna },
  { id: "brain", label: "人工智能", keywords: "人工智能 机器学习 心理 认知 记忆 ai ml brain cognition", icon: Brain },
  { id: "globe", label: "地理与世界", keywords: "地理 国际 世界 英语 外语 globe geography world", icon: Globe },
  { id: "languages", label: "语言", keywords: "英语 外语 语言 翻译 四六级 雅思 托福 english language translation", icon: Languages },
  { id: "scale", label: "法学", keywords: "法学 法律 政治 伦理 law legal justice politics", icon: Scale },
  { id: "landmark", label: "历史与金融", keywords: "历史 金融 经济 银行 建筑 history finance economics", icon: Landmark },
  { id: "bar-chart", label: "数据分析", keywords: "图表 经济 统计 数据分析 会计 chart analytics finance", icon: BarChart3 },
  { id: "palette", label: "设计艺术", keywords: "设计 美术 艺术 创意 ui palette design art", icon: Palette },
  { id: "music", label: "音乐", keywords: "音乐 乐理 声乐 音频 music audio theory", icon: Music },
  { id: "stethoscope", label: "医学", keywords: "医学 临床 健康 护理 medicine health clinical", icon: Stethoscope },
  { id: "wrench", label: "工程", keywords: "工程 机械 工具 制造 engineering mechanics tool", icon: Wrench },
  { id: "zap", label: "电路", keywords: "电路 电子 电力 模拟 数字 冲刺 circuit electric electronics", icon: Zap },
  { id: "compass", label: "探索路线", keywords: "路线 方向 规划 探索 导航 compass roadmap explore", icon: Compass },
  { id: "target", label: "目标考研", keywords: "目标 考研 备考 冲刺 刷题 target goal exam", icon: Target },
  { id: "rocket", label: "进阶冲刺", keywords: "进阶 火箭 项目 发射 创业 rocket launch project", icon: Rocket },
  { id: "lightbulb", label: "原理灵感", keywords: "灵感 原理 概念 思考 哲学 idea concept insight", icon: Lightbulb },
  { id: "puzzle", label: "逻辑算法", keywords: "逻辑 推理 算法 益智 拼图 puzzle logic algorithm", icon: Puzzle },
  { id: "briefcase", label: "职场面试", keywords: "职场 面试 商业 管理 工作 career interview business", icon: Briefcase },
  { id: "heart", label: "兴趣爱好", keywords: "兴趣 爱好 喜欢 生活 收藏 heart hobby interest", icon: Heart },
  { id: "bookmark", label: "重点复习", keywords: "书签 收藏 重点 复习 错题 bookmark review key", icon: Bookmark },
];

const ICON_MAP = new Map<string, LucideIcon>(SPACE_ICONS.map((item) => [item.id, item.icon]));

export function resolveSpaceIcon(name?: string | null): LucideIcon {
  return (name && ICON_MAP.get(name)) || GraduationCap;
}

export function filterSpaceIcons(query: string): readonly SpaceIconOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return SPACE_ICONS;
  return SPACE_ICONS.filter(
    (item) => item.label.toLowerCase().includes(q)
      || item.id.includes(q)
      || item.keywords.toLowerCase().includes(q),
  );
}

export function SpaceIcon({
  name,
  size = 15,
  className,
}: {
  name?: string | null;
  size?: number;
  className?: string;
}) {
  const Icon = resolveSpaceIcon(name);
  return <Icon size={size} className={className} aria-hidden />;
}
