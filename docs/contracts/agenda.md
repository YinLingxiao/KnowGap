# 知隙日程（agenda）接口约定

> 状态：约定 v1（2026-10-21）。后端、日程主界面、周历/AI 拆解三个会话按此并行开发；字段改动必须同步本文、`frontend/src/lib/agenda/types.ts` 与 `api.ts`。
> 线上字段一律 snake_case，前端只在 `lib/agenda/api.ts` 内做映射。所有接口沿用现有鉴权（`current_student()`），跨学生访问一律 404。

## 1. 三类任务来源

| 来源 | 存储 | 说明 |
| --- | --- | --- |
| `manual` | `agenda_tasks` 表 | 用户手动或快录添加的待办，支持父子任务 |
| `ai_breakdown` | `agenda_tasks` 表 | AI 拆解排期后用户确认入列的任务（父任务 + 子任务） |
| `review` | `agenda_tasks` 表 | 艾宾浩斯错题闪回，由后端根据 `misconception` 学习记忆自动生成 |
| 支线 | **不存储**，`GET /api/agenda/feed` 实时聚合 | 进行中（open）的空间支线，截止日继承所属空间的 `deadline` |

## 2. Task 对象

```json
{
  "id": "task-…",
  "title": "复习戴维南定理",
  "notes": "",                       // Markdown
  "parent_id": null,
  "priority": 1,                     // 1~4，1 最高；P1 红 / P2 橙 / P3 蓝 / P4 无色
  "labels": ["电路原理"],
  "subject_id": "subj-…",            // 可空
  "thread_id": null,                 // 关联的支线（conversation id），可空
  "scheduled_date": "2026-10-22",    // 计划哪天学（Schedule），可空
  "scheduled_start_at": "2026-10-22T15:00", // 计划几点开始（本地时间，无时区），可空；有值时 scheduled_date 必须等于其日期部分
  "duration_minutes": 45,            // 可空
  "deadline_date": "2026-10-30",     // 硬截止日（Deadline），可空，与 Schedule 独立
  "status": "open",                  // open | done | cancelled
  "completed_at": null,              // ISO 时间，done 时由后端写入
  "source": "manual",                // manual | ai_breakdown | review
  "memory_id": null,                 // review 任务对应的 misconception 记忆 id
  "review_step": null,               // review 任务的轮次 1|2|3
  "sort_order": 0,                   // 同组内排序，浮点
  "created_at": "…",
  "updated_at": "…"
}
```

校验：`title` 1~200 字；`priority` 1~4（默认 4）；`labels` 至多 10 个、每个至多 20 字；日期 `YYYY-MM-DD`；`scheduled_start_at` `YYYY-MM-DDTHH:MM`；`duration_minutes` 5~720；`parent_id` 只能指向同一学生的顶层任务（只支持两层）；`subject_id` / `thread_id` 必须属于当前学生，否则 422。

## 3. 艾宾浩斯闪回规则（anchor = completion）

- 每条 `kind = "misconception"` 且 `status` 不是已解决的学习记忆，对应一条闪回链。
- 第 1 轮：`scheduled_date = 记忆创建日期 + 1 天`。
- 完成第 k 轮（PATCH 为 `done`）后，后端立即生成第 k+1 轮：第 2 轮 = 完成日期 + 3 天，第 3 轮 = 完成日期 + 7 天。第 3 轮完成后链结束。
- 记忆被标记为已解决或被删除时，链上未完成的 review 任务改为 `cancelled`。
- 生成是幂等的：每次 `GET /api/agenda/tasks` 或 `/feed` 时同步一次（同一记忆同一轮次最多一条）。
- review 任务标题：`闪回：{记忆 topic}`，`notes` 带记忆 summary 与最近一条原话证据，`subject_id` 继承记忆的 `subject_id`，`priority` 默认 2。

## 4. 接口

### `GET /api/agenda/tasks`
查询参数：`status=open|done|all`（默认 `open`）、`subject_id`（可选）。
返回 `{"tasks": Task[]}`，含父子任务（前端按 `parent_id` 组装），不含 `cancelled`（`status=all` 时也不含）。

### `GET /api/agenda/feed`
查询参数：`from`、`to`（`YYYY-MM-DD`，含两端，用于周历；均可省略）。
返回：
```json
{
  "today": "2026-10-21",
  "tasks": [Task],         // 所有 open 任务 + from~to 之间完成的 done 任务
  "threads": [{
    "thread_id": "conv-…", "title": "…", "subject_id": "subj-…", "subject_name": "电路原理",
    "subject_color": "#3d6fdb", "deadline_date": "2026-10-30", "updated_at": "…"
  }]
}
```

### `POST /api/agenda/tasks`
请求体：Task 的可写字段（`title` 必填；`notes parent_id priority labels subject_id thread_id scheduled_date scheduled_start_at duration_minutes deadline_date source`），`source` 只接受 `manual` | `ai_breakdown`。返回 201 + Task。

### `POST /api/agenda/tasks/batch`
用于 AI 拆解确认入列：`{"parent": TaskCreate | null, "children": TaskCreate[]}`（children 至多 30 条，忽略其中的 `parent_id`，有 parent 时全部挂到新建的 parent 下）。单事务，返回 201 + `{"parent": Task | null, "children": Task[]}`。

### `PATCH /api/agenda/tasks/{id}`
部分更新可写字段与 `status`、`sort_order`。传 `null` 表示清空该字段。`status` 改为 `done` 时写 `completed_at`，改回 `open` 时清空。review 任务完成时按第 3 节生成下一轮。返回 Task。

### `DELETE /api/agenda/tasks/{id}`
删除任务及其子任务，返回 204。review 任务也可删除（视为放弃该轮，不再生成后续轮次）。

### `POST /api/agenda/breakdown`
请求体：`{"goal": "两周内搞定电路原理期末", "subject_id": "subj-…" | null, "deadline_date": "2026-11-05" | null, "today": "2026-10-21"}`。
后端调用模型（可带上空间 goal、误区、进行中支线作为参考），返回**草稿，不入库**：
```json
{"parent": TaskDraft, "children": [TaskDraft]}
```
`TaskDraft` = TaskCreate 的字段子集（`title notes priority labels scheduled_date scheduled_start_at duration_minutes deadline_date`）。后端负责校验与裁剪：日期必须在 `today` 与 `deadline_date`（如有）之间，至多 12 个子任务。模型不可用或超时返回 503 + `{"detail": "…"}`，前端提示后允许手动添加。

### `GET /api/agenda/export.ics`
查询参数：`status=open|all`（默认 `open`）、`subject_id`（可选）。返回 `text/calendar; charset=utf-8`，`Content-Disposition: attachment; filename="knowgap-agenda.ics"`。
- 有 `scheduled_start_at` 的任务导出为带时间的 `VEVENT`（时长取 `duration_minutes`，缺省 30 分钟）；只有 `scheduled_date` 的导出为全天事件；只有 `deadline_date` 的导出为全天事件，标题前加「截止：」。
- 需要鉴权头，前端用 `fetch` + `authHeader()` 取 Blob 后触发下载，不能直接用 `<a href>`。

## 5. 前端协作约定

- **数据层**：`frontend/src/lib/agenda/types.ts`、`api.ts`（已提供，各会话只读；需要改动请在汇报中说明，由集成步骤统一改）。
- **日程主界面**（agenda-ui 会话）拥有：`components/agenda/AgendaPage.tsx`（页面外壳、视图切换）、列表视图、`TaskInspector` 右侧抽屉、Quick Add 与 `lib/agenda/quickAdd.ts` 中文解析器、导航入口（侧栏「日程」+ `ChatApp` 的 `agenda` 视图）、`.ics` 导出按钮。
- **周历与 AI 拆解**（agenda-calendar 会话）拥有：`components/agenda/WeekCalendar.tsx`、`components/agenda/AiBreakdownDialog.tsx`，以独立组件交付，props 如下，由主界面挂载：

```ts
// WeekCalendar：一周 7 列 × 时间轴；全天/仅日期任务放顶部全天行；截止日以红色旗标显示在对应日期；支线以蓝色条显示在截止日
interface WeekCalendarProps {
  weekStart: string;                 // 周一，YYYY-MM-DD
  tasks: AgendaTask[];
  threads: AgendaThread[];
  today: string;
  onWeekChange: (weekStart: string) => void;
  onSelectTask: (taskId: string) => void;
  onSelectThread?: (threadId: string) => void;
  /** 拖拽或拉伸时间块；scheduledStartAt 为 null 表示拖到全天行 */
  onReschedule: (taskId: string, patch: { scheduledDate: string; scheduledStartAt: string | null; durationMinutes: number | null }) => void;
  /** 在空白时间格点击创建 */
  onCreateAt?: (slot: { scheduledDate: string; scheduledStartAt: string | null }) => void;
}

// AiBreakdownDialog：输入大目标 → 调 breakdown 预览草稿（可逐条编辑/删除/改日期）→ 确认后调 batch 入列
interface AiBreakdownDialogProps {
  open: boolean;
  subjects: { id: string; name: string; color: string; deadline: string | null }[];
  defaultSubjectId?: string | null;
  initialGoal?: string;
  onClose: () => void;
  onCreated: (created: { parent: AgendaTask | null; children: AgendaTask[] }) => void;
}
```

- **刷新**：任何模块改了任务后派发 `window` 事件 `knowgap:agenda-changed`（无 detail），日程页监听后重新拉取。

## 6. v2 增补（2026-10-21 晚）：提醒、全局添加任务、桌面托盘

### 6.1 提醒字段 `reminder_minutes`
- Task 新增可写字段 `reminder_minutes`：整数，开始前多少分钟提醒，`0` = 准时，`null` = 不提醒；允许值 `0 / 5 / 10 / 15 / 30 / 60 / 120 / 1440`，其他值 422。
- 只对有 `scheduled_start_at` 的任务生效；没有开始时间时可以存，但不会触发。
- `.ics` 导出：有提醒的 VEVENT 加 `VALARM`（`TRIGGER:-PT{n}M`，`ACTION:DISPLAY`）。
- AI 工具 `agenda_add` / `agenda_update` 的任务字段同步增加 `reminder_minutes`。
- 前端类型：`AgendaTask.reminderMinutes`、`TaskInput.reminderMinutes`（`lib/agenda/types.ts`、`api.ts` 已加映射）。

### 6.2 全局「添加任务」弹窗
- 任何模块派发 `window` 事件 `COMPOSE_TASK_EVENT = "knowgap:compose-task"`，`detail: ComposeTaskDetail`（`scheduledDate / subjectId / parentId / title` 均可选，作为默认值），即打开弹窗。
- 弹窗由 task-composer 会话实现并在 ChatApp 挂载一次；创建成功后派发 `AGENDA_CHANGED_EVENT`。
- 日程页各视图里的「+ 添加任务」一律派发这个事件，不再各自实现输入框（行内快录 QuickAdd 可保留在「今天/待办」顶部）。

### 6.3 桌面端桥接（`window.knowgap`，preload 暴露）
| 方法 / 事件 | 方向 | 说明 |
| --- | --- | --- |
| `showMain(): void` | 页面 → 主进程 | 显示并聚焦主窗口（窗口在托盘里时也能唤出）。通知点击、快问浮窗跳转都用它 |
| `setTrayStatus({ todayCount?: number })` | 页面 → 主进程 | 托盘菜单里的「今日待办 N 项」 |
| `getDesktopSettings(): Promise<{ closeToTray: boolean; openAtLogin: boolean }>` / `setDesktopSettings(patch)` | 页面 ↔ 主进程 | 设置页的两个开关 |
| 页面 `window` 事件 `knowgap:tray-command`，`detail` 为 `open-agenda` 或 `quick-ask` | 主进程 → 页面 | 托盘菜单命令，由 preload 转成 DOM 事件；`open-agenda` 复用 `knowgap:open-agenda` |
- 浏览器（非 Electron）里 `window.knowgap` 不存在，所有调用都要可选链并静默降级。
- 其他会话需要调用而类型尚未声明时，用局部类型断言，例如 `(window as unknown as { knowgap?: { showMain?: () => void } }).knowgap?.showMain?.()`，不要去改 SettingsDialog.tsx 里的全局声明（归 desktop-tray 会话）。
