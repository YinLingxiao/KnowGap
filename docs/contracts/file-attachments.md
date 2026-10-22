# 对话文件附件（file attachments）接口约定

> 状态：约定 v1（2026-10-22）。file-ingest（后端）与 file-ui（前端）两个会话按此并行开发；改动需同步本文与 `frontend/src/lib/chat/attachments.ts`。所有接口沿用 `current_student()` 鉴权，跨学生 404。

## 1. 目标

学生把 PDF / Word / PPT / Excel / 文本文件直接拖进对话，AI 能读到内容、按页引用，并按意图（精读、转笔记、批改、解读数据）工作。模型不直接收文件：**后端解析成文本 → 存进资料库（复用 MaterialStore 的分页、检索与来源引用）→ 对话里用标记引用**。

## 2. 支持的格式

| kind | 扩展名 | 解析 | 定位单位 `unit_label` |
| --- | --- | --- | --- |
| pdf | .pdf | pypdf（已有） | 页 |
| docx | .docx | python-docx：段落与表格按顺序取文本，标题样式保留为 Markdown 标题；约每 1500 字切一「节」 | 节 |
| pptx | .pptx | python-pptx：每张幻灯片一页，标题 + 正文 + 备注 | 张幻灯片 |
| xlsx | .xlsx | openpyxl（只读、data_only）：每个工作表一页，前 200 行转 Markdown 表格，注明总行列数 | 个工作表 |
| text | .txt .md .csv | 已有 | 页 |

不支持：.doc / .ppt / .xls（旧二进制格式，返回 415 并提示「请另存为 .docx/.pptx/.xlsx」）、扫描版 PDF（无可提取文字时 422「这份 PDF 是扫描图片，暂不支持识别文字」）。单文件上限沿用并调整为 20 MB；页/节/幻灯片/工作表上限 200。

## 3. 上传接口

`POST /api/conversations/{conversation_id}/attachments`（multipart，字段 `file`）

- 存进资料库：对话属于学习空间时归入该空间，否则作为通用资料（unassigned）。
- 返回 201：

```json
{
  "id": "doc-…",                 // 资料 id，即 MaterialStore 的 document_id
  "name": "第3章 进程调度.pptx",
  "kind": "pptx",
  "units": 24,
  "unit_label": "张幻灯片",
  "chars": 18342,
  "outline": ["进程的状态", "调度时机", "FCFS", "…"],   // ≤20 条：标题 / 幻灯片标题 / 工作表名
  "subject_id": "subj-…" | null
}
```

- 错误：415 不支持的格式、413 过大、422 解析失败或无文字，`detail` 为中文说明。
- 现有 `POST /api/materials`（资料库上传）同样接受第 2 节的全部格式。

## 4. 消息里的附件标记

前端发送消息时，把附件写成独立行放在正文最前面：

```
[[file:doc-abc123|第3章 进程调度.pptx]]
帮我精读这份课件，挑出难点
```

- 一条消息最多 5 个附件标记。
- 后端（chat_messages）：
  1. 把标记替换为「（附件：第3章 进程调度.pptx，24 张幻灯片）」再交给模型；
  2. 在 `turn_context.attached_files` 注入每个附件的 `{id, name, kind, units, unit_label, outline, excerpt}`，`excerpt` 为开头约 3000 字（只在附件首次出现的那一轮注入全文摘录，之后轮次只给 outline）；
  3. 本轮的 `course_sources` 检索优先限定在这些附件内（按用户这句话检索最相关的 5 段，带页/幻灯片定位），没有附件时维持原逻辑；
  4. 标记里的 id 必须属于当前学生，否则忽略该标记。
- 前端：消息里的标记渲染为文件卡片（图标 + 文件名 + 「24 张幻灯片」），点击打开资料库中的该资料；不把原始标记文本显示给用户。

## 5. 文件类技能（后端选择，前端给入口）

附件出现的轮次，按用户意图挂载以下技能之一（写进 skills，作为 `active_skill`）：

| id | 触发意图（前端快捷句） | 行为要点 |
| --- | --- | --- |
| `file_close_read` | 「帮我精读这份材料，挑出重点和难点」 | 按页/幻灯片概括主线，标出 2–3 个难点并附定位；用 update_plan 列出学习步骤；难点可建议开 Thread |
| `file_to_notes` | 「把这份材料整理成复习笔记」 | 输出结构化 Markdown 笔记（概念、公式、易错点，每条带页码）；结尾提示可「存进空间笔记」 |
| `file_check_work` | 「帮我检查这份作业 / 试卷」 | 先逐题转写学生作答，再对照判断；只指出问题和依据，引导自己改正，不直接给完整答案（沿用现有引导原则） |
| `file_data_explain` | 「帮我看懂这张表格」 | 先说明每列含义与数据规模，再提 2–3 个可以自己验证的观察问题，不替学生下结论 |

无明确意图时（只发附件）：AI 用 3–5 句概括内容，并问学生想做哪一种。

前端在附件上传成功后、发送前，于输入框上方显示与文件类型匹配的快捷意图（pdf/docx/pptx：精读、转笔记、检查作业；xlsx/csv：看懂表格、精读），点击即填入对应句子。

## 6. 前端数据层

`frontend/src/lib/chat/attachments.ts`（已提供，两个会话只读）：类型、`ATTACHMENT_ACCEPT`、`attachmentApi.upload`、`formatFileMarker` / `parseFileMarkers`、`FILE_INTENTS`。
