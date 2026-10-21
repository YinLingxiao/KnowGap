# 对话学习计划（learning plan）接口约定

> 状态：约定 v1（2026-10-22）。后端（plan-backend）与前端（plan-frontend）两个会话按此并行开发；字段改动必须同步本文与 `frontend/src/lib/chat/plan.ts`。线上字段一律 snake_case，前端只在 `lib/chat/plan.ts` 内映射。所有接口沿用 `current_student()` 鉴权，跨学生一律 404。

## 1. 目标

把原来「每条回复一张、只画一次」的 `plan_steps` 卡片，改成**属于整段对话、AI 每轮可见并在回复中实时更新、用户可以直接操作**的学习计划。KnowGap 的关键区别：**AI 讲完不算完成，学习者答对才算完成**（`awaiting_learner` 状态）。

## 2. Plan 对象

```json
{
  "conversation_id": "conv-…",
  "version": 7,                       // 每次变更 +1，前端据此丢弃旧事件
  "steps": [
    {
      "id": "step-…",                 // 服务端生成，稳定不变
      "title": "用 n=5, k=3 的小例子走一遍出列过程",   // 1~60 字
      "status": "done",               // pending | in_progress | awaiting_learner | done | skipped
      "note": "",                     // 可选，≤120 字，例如等待作答的问题
      "thread_id": null,              // 可选，交给 Thread 执行的步骤
      "completed_message_id": "msg-…",// 变为 done 时所在的消息，时间线标记用
      "updated_at": "…"
    }
  ],
  "completed_at": null,               // 所有步骤为 done/skipped 时写入，重新出现未完成步骤时清空
  "updated_at": "…"
}
```

没有计划时接口返回 `{"conversation_id": "...", "version": 0, "steps": [], "completed_at": null, "updated_at": null}`。

## 3. AI 工具 `update_plan`（替代 `plan_steps`）

- 参数：`{"steps": [{"id"?: str, "title": str, "status": str, "note"?: str, "thread_id"?: str}]}`，**整份覆盖**（TodoWrite 风格），1~8 步。
- 服务端归一化规则（代码兜底，不只靠提示词）：
  1. 带 `id` 的按 id 匹配已有步骤；不带 id 的按标题完全一致匹配，否则视为新步骤。
  2. 同时最多一个 `in_progress`；多出的改为 `pending`。
  3. AI 不能把已 `done` 的步骤改回未完成（保持 `done`，在返回里提示）。
  4. `awaiting_learner → done` 只允许在学习者于该步进入等待之后已经发过新消息的轮次（服务端记录进入等待时的消息序号）；否则保持 `awaiting_learner`。
  5. `thread_id` 必须是当前学生在同一学习空间里的 Thread，否则丢弃该字段。
- 返回给模型：归一化后的计划 JSON（含每步 id），以及被拒绝的改动说明。
- 旧的 `plan_steps` 不再提供给模型；历史消息里的 `plan_steps` 调用前端不再渲染整张卡片。

## 4. 每轮上下文

`turn_context.learning_plan`：当前计划的精简版 `{steps: [{id, title, status, note}], progress: "2/3"}`；无计划时不出现。若用户自上一轮以来在界面上操作过计划，附加 `turn_context.plan_user_events`（如 `["用户跳过了「对比数组模拟」", "用户新增了步骤「再做一道变式题」"]`），注入一次后清空。

提示词约定（写入 common prompt，删除各 Skill 中「预填 completed/in_progress」的示例）：多步讲解或练习开始时用 `update_plan` 列出 2~5 步；每轮开头对照计划，把要做的那步设为 `in_progress`；一步讲完立即更新，不等回复结束；需要学习者作答时把该步设为 `awaiting_learner` 并在 note 写清问题，然后停下等待；学习者答对后再标 `done`；计划过时就整体改写。

## 5. 回复后兜底推进

回复后的学情分析（`analysis_messages` / `validate_analysis`）在 JSON 里新增 `plan_updates: [{"id": "step-…", "status": "done", "evidence": "学习者原话片段"}]`：只允许把 `awaiting_learner` 改为 `done`，且 `evidence` 必须逐字出现在本轮用户消息中（沿用现有 evidence 校验）。用于 AI 忘记更新时进度不卡住。

## 6. 事件与消息元数据

- SSE 新增事件 `plan`，数据为完整 Plan 对象：工具执行后、兜底推进后各推送一次。
- 计划变更时，在**本轮助手消息**的 meta 写入 `plan_changes: [{"step_id", "title", "from", "to"}]`，消息接口返回 `plan_changes` 字段（前端时间线标记用）。
- Thread 同步：带 `thread_id` 的步骤，在该 Thread 被标记为已解决时自动变为 `done`（推送到主对话的下一次 `plan` 事件或接口读取时可见）。

## 7. REST 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/conversations/{id}/plan` | 读取计划 |
| POST | `/api/conversations/{id}/plan/steps` | 用户新增一步 `{title}`，追加到末尾，状态 pending |
| PATCH | `/api/conversations/{id}/plan/steps/{step_id}` | 用户操作 `{status?: "done"\|"skipped"\|"pending", title?}`；用户可以把任何状态改成这三种 |
| DELETE | `/api/conversations/{id}/plan/steps/{step_id}` | 删除一步 |
| DELETE | `/api/conversations/{id}/plan` | 清空计划 |

用户操作都记录为 `plan_user_events`（见第 4 节），返回更新后的完整 Plan。生成进行中（对话忙）时用户操作照常允许，下一轮生效。

## 8. 前端约定

- 数据层：`frontend/src/lib/chat/plan.ts`（类型、映射、`planApi`、事件常量），两个会话只读，改动写进汇报。
- `useChat` 收到 SSE `plan` 事件后派发 `window` 事件 `PLAN_EVENT = "knowgap:plan"`，`detail: { conversationId, plan }`（plan 已映射为前端类型）；计划条组件自己按 conversationId 订阅并在挂载时调用 `planApi.get`。
- 计划条 `PlanBar` 挂在 `Composer` 输入框上方（Composer 已有 conversationId），因此首页对话、学习空间主对话、Thread 都自动拥有。
