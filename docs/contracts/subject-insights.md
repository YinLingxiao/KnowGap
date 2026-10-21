# 学习空间聚合数据（Subject Insights）接口约定

`GET /api/subjects/{subject_id}/insights` —— 一个学习空间的只读聚合视图。考前一页纸（cheatsheet）和之后的空间知识迷雾拓扑图（concept_graph）都基于这个形状。

- 实现：`backend/app/chat/insights.py` 的 `subject_insights(store, student_id, subject_id)`（后端模块可直接调用，不必走 HTTP）
- 前端类型与封装：`frontend/src/lib/chat/insights.ts`（`insightsApi.getInsights`、`SubjectInsights`，字段为 camelCase）
- 测试：`backend/tests/test_subject_insights.py`

## 规则

- **只读、确定性**：不调模型、不写库；同样的数据两次请求结果完全相同（`stats.days_to_deadline` 按服务器当天日期计算，跨天会变）。
- **鉴权与隔离**：与其它 `/api/subjects/*` 路由一致，按当前登录学生过滤。空间不存在、已删除、或属于其他学生 → `404 {"detail": "学习空间不存在或已删除。"}`。
- **只增不改**：`schema_version` 当前为 `1`。新增字段不升版本；改名/删字段/改语义才升版本。消费方忽略未知字段。

## 数据来源（store.py 中的真实关联）

| 数据 | 来源 |
| --- | --- |
| 空间信息 | `subjects` 表（`store.subject()`，已做学生隔离） |
| 记忆 | `learner_memories.subject_id = 空间 id`，`kind != 'preference'`（偏好恒为全局记忆，不属于任何空间） |
| 记忆证据 | `learner_memory_evidence`（`quote` 是学生原话快照，来源对话删除后仍保留） |
| Thread | `conversations.kind = 'thread'` 且 `subject_id = 空间 id` |
| Thread 总结/takeaways | `resolve_thread()` 发到空间**主对话**里的总结卡片（`conversation_messages.meta_json.thread_summary`，按 `thread_id` 对应） |
| 资料 | `course_materials.subject_id = 空间 id` |

## 字段

### 顶层

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schema_version` | int | 当前 `1` |
| `subject` | object | 空间基本信息，见下 |
| `stats` | object | 统计数字，见下 |
| `misconceptions` | Memory[] | **未解决**的误区（status ∈ suspected / needs_review / improving），按复习优先级排序：needs_review → suspected → improving，同级按 `updated_at` 升序（越久没碰的越靠前） |
| `mastered` | Memory[] | 已掌握：`kind = mastery` 的记忆 + `status = resolved` 的误区，按 `updated_at` 降序。与 `Subject.progress.mastered` 口径一致 |
| `threads` | Thread[] | 本空间全部 Thread，open 在前，然后按 `updated_at` 降序 |
| `materials` | Material[] | 本空间课程资料（不含正文），按上传时间升序 |

### `subject`

`id`、`name`、`description`、`goal`（可为空串）、`level`（`beginner | some | fluent | exam | null`）、`deadline`（`YYYY-MM-DD` 或 `null`）、`color`、`main_conversation_id`。

### Memory

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 记忆 id（`mem-…`），可作为图节点 id |
| `kind` | `misconception \| mastery` | |
| `topic` | string | 知识点名 |
| `topic_key` | string \| null | 规范化主题键（如 `stack.lifo`），可用于跨记忆合并节点 |
| `summary` | string | 一句话描述 |
| `status` | string | 误区：`suspected / needs_review / improving / resolved`；掌握：`observed / uncertain` |
| `confidence` | number | 0–1 |
| `user_corrected` | bool | 学生是否手动修正过 |
| `tags` | string[] | |
| `evidence` | Evidence[] | 按记录先后排序 |
| `created_at` / `updated_at` | ISO 时间 | |
| `source` | `mastery \| resolved_misconception` | **仅** `mastered` 列表中出现 |

Evidence：`quote`（学生原话）、`reason`、`signal`（`supports` 支持该记忆 / `contradicts` 反证）、`conversation_id`、`message_id`、`source_available`（来源对话是否还在）、`created_at`。

### Thread

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` / `title` | string | |
| `status` | `open \| resolved` | |
| `summary` | string | 已解决 Thread 的总结；open 或没有总结卡片时为 `""` |
| `takeaways` | string[] | 同上，没有时为 `[]` |
| `memory_ids` | string[] | 合并时该 Thread 中产生证据的记忆 id（Thread ↔ 记忆的边） |
| `anchor_message_id` | string \| null | 从主对话哪条消息分出来的 |
| `created_at` / `updated_at` / `resolved_at` | ISO 时间 / null | |

### Material

`id`、`title`、`kind`（`pdf` / `text` …）、`chunk_count`、`created_at`。

### `stats`

| 字段 | 说明 |
| --- | --- |
| `misconceptions` | 未解决误区数（= `misconceptions.length`） |
| `to_review` | 其中 suspected + needs_review |
| `improving` | 其中 improving |
| `mastered` | `= mastered.length` |
| `evidence` | 本空间所有记忆的证据条数 |
| `threads_open` / `threads_resolved` | |
| `materials` | 资料数 |
| `last_studied_at` | 本空间对话最近更新时间，可为 `null` |
| `days_to_deadline` | 距截止日期天数（可为负，表示已过），无截止日期为 `null` |

## 空数据时的形状

新建空间、没有任何记忆/Thread/资料时，所有列表都是 `[]`，计数为 `0`，不会缺字段：

```json
{
  "schema_version": 1,
  "subject": {"id": "subj-…", "name": "空空间", "description": "", "goal": "", "level": null,
              "deadline": null, "color": "#3d6fdb", "main_conversation_id": "conv-…"},
  "stats": {"misconceptions": 0, "to_review": 0, "improving": 0, "mastered": 0, "evidence": 0,
            "threads_open": 0, "threads_resolved": 0, "materials": 0,
            "last_studied_at": "2026-10-21T08:00:00+00:00", "days_to_deadline": null},
  "misconceptions": [], "mastered": [], "threads": [], "materials": []
}
```

## 示例

```json
{
  "schema_version": 1,
  "subject": {"id": "subj-1a2b", "name": "数据结构", "description": "", "goal": "期末 85+", "level": "exam",
              "deadline": "2026-12-31", "color": "#3d6fdb", "main_conversation_id": "conv-main"},
  "stats": {"misconceptions": 1, "to_review": 1, "improving": 0, "mastered": 1, "evidence": 2,
            "threads_open": 1, "threads_resolved": 1, "materials": 1,
            "last_studied_at": "2026-10-21T08:12:03+00:00", "days_to_deadline": 71},
  "misconceptions": [{
    "id": "mem-9f", "kind": "misconception", "topic": "栈的顺序", "topic_key": null,
    "summary": "把栈记成了先进先出", "status": "needs_review", "confidence": 0.6, "user_corrected": false,
    "tags": [], "created_at": "…", "updated_at": "…",
    "evidence": [{"quote": "栈是先进先出", "reason": "原话", "signal": "supports",
                  "conversation_id": "conv-t1", "message_id": "msg-1", "source_available": true, "created_at": "…"}]
  }],
  "mastered": [{"id": "mem-a0", "kind": "mastery", "topic": "队列", "summary": "能正确说明队列先进先出",
                "status": "observed", "source": "mastery", "…": "…"}],
  "threads": [
    {"id": "conv-t2", "title": "红黑树", "status": "open", "summary": "", "takeaways": [], "memory_ids": [],
     "anchor_message_id": null, "created_at": "…", "updated_at": "…", "resolved_at": null},
    {"id": "conv-t1", "title": "栈的出栈顺序", "status": "resolved",
     "summary": "栈是后进先出，最后压入的元素最先弹出。", "takeaways": ["LIFO：叠盘子"], "memory_ids": ["mem-9f"],
     "anchor_message_id": null, "created_at": "…", "updated_at": "…", "resolved_at": "…"}
  ],
  "materials": [{"id": "material-3c", "title": "第3章 栈与队列.pdf", "kind": "pdf", "chunk_count": 42, "created_at": "…"}]
}
```

---

# 考前一页纸（Cheat Sheet）

`POST /api/subjects/{subject_id}/cheatsheet` —— 基于上面的聚合数据生成四宫格。实现：`backend/app/chat/cheatsheet.py`；前端：`insightsApi.getCheatSheet`、`frontend/src/components/chat/CheatSheet.tsx`。

请求体（可省略）：`{"force": false, "notes": ""}`。`force=true` 跳过缓存重新调用模型；`notes` 是浏览器里的空间 Pages 笔记（Pages 只存在 localStorage，后端看不到），作为模型补充素材，最长 20000 字。

| 区块 | 字段 | 来源 |
| --- | --- | --- |
| ① 个人易错红榜 | `sections.pitfalls[]`：`memory_id, topic, summary, status, quotes[]` | 直接取 `misconceptions` 前 8 条，`quotes` 是 `signal = supports` 的原话（最多 2 条）。**模型不参与，不会编造证据** |
| ② Thread 核心结论 | `sections.conclusions[]`：`thread_id, title, summary, takeaways[]` | 已解决且有总结的 Thread，最多 8 条。模型不参与 |
| ③ 核心公式与适用边界 | `sections.formulas[]`：`name, formula, conditions, pitfall` | 模型从讲义片段、主对话近况、Thread 结论、笔记中提炼；`formula` 用 `$…$` KaTeX |
| ④ 易混对比 + 押题自测 | `sections.contrasts[]`：`a, b, difference, tip`；`sections.quiz[]`：`question, answer` | 模型生成 |

其它字段：`subject_id`、`subject`（id/name/goal/level/deadline）、`stats`（同 insights）、`generated_at`、`cached`（本次是否命中缓存）、`degraded`、`notice`、`model`、`markdown`（整页 Markdown，前端「导出 Markdown」直接下载它）。

降级：模型未配置、报错或超过 60 秒 → 仍返回 200，`degraded: true`，③④ 为 `[]`，`notice` 说明原因，①② 照常。模型返回内容不可用（非 JSON/全空）→ `degraded: false`，③④ 为空，带 `notice`。

缓存：成功结果存 `subject_cheatsheets` 表（由 cheatsheet.py 自建，键 `(student_id, subject_id)`，不改 store.py 的表结构），按「聚合数据（不含 stats）+ notes」的指纹判断是否过期：新增误区/证据、Thread 合并、上传资料、改空间信息或笔记都会让下次打开重新生成；只是多聊几句不会。降级结果不缓存。跨学生访问同样 404。
