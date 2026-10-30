# 改造任务：主线不再为支线的每一轮对话生成卡片

> 状态：待实施。基线 `17f9ab5`（main），文档日期 2026-10-30。
> 分两个阶段，**各自独立分支、独立 PR，先阶段一再阶段二**：
> - 阶段一（第 1–7 节）：修复主线刷屏，线程卡取代进展消息。
> - 阶段二（第 8 节）：支线完成后唤醒协调者读取汇报（Claude Projects 式），放在开关后面。
>
> 面向：负责实现的开发者（含 AI 编程助手）。**先读完「红线」和「约束」两节再动手。**
> 文中行号均为基线时的位置，代码一动就会漂移，请以函数名和符号为准重新定位。

## 0. 一句话

学习空间里，支线（thread）每多说一轮，主线（main）就多一条“进展卡片”消息。要改成：**一个支线在主线里最多只占一个位置，状态由前端实时读取，不再写成消息。**这是在模仿 Claude Projects 的做法（见第 2 节）。

阶段一删掉“状态播报”之后，协调者不再从聊天记录里得知支线进度，所以阶段二补上正规通道：由主线交办的支线任务完成或失败时，把汇报存起来，在主线空闲时唤醒协调者读取，协调者默认沉默，只在需要时行动（见第 8 节）。这条通道的接口是“结构化的汇报”，以后要扩展协调者与支线之间的分工，都从这里长出来；但**本次不引入任何新的角色命名或角色提示词**。

## 红线（违反任何一条都不要提交）

1. **不得再有任何路径在支线工作期间向主线插入或更新消息。** 允许写入主线的只有：协调者自己的回复、用户消息、以及“合并回主线”产生的 `thread_summary`。（阶段二有且仅有一处例外：隐藏的系统事件消息及其触发的协调者回复，见第 8 节。）
2. **不得修改支线的 `execution_status` 推导逻辑**（`store.py` 的 `_summary`，约 325–342 行）。它只读支线自己的消息，本次改造必须保持这一点。
3. **不得改动派发、并发槽位、排队、断点恢复、用量统计的行为**：`coordination.dispatch / next_delivery / cancel_deliveries`、`THREAD_CONCURRENCY`、`checkpoints`、`model_usage`。
4. **不得 `git add -A` / `git commit -a`。** 工作区里可能有与本任务无关的未提交改动（例如 `desktop/`、`frontend/public/vendor/*`），不要碰、不要提交、不要还原。每次提交前 `git status` 核对，只 `git add` 自己改的文件。
5. **不得在真实数据库或日常应用库上跑测试和迁移验证。** 测试用 `tmp_path` 独立库（现有测试均如此）；迁移请在数据库的拷贝上验证。
6. **不得启动真实模型做验收**，不得向日常库灌入测试数据。

## 1. 问题与根因

### 现象
在学习空间的支线里每对话一轮，主线就多出一个“弹窗式”药丸（pill）。聊多轮后主线里堆满同一个支线的进展条。

### 根因（已读代码核实）
- `backend/app/chat/coordination.py` 的 `report()` 用 `client_request_id = f"report-{reply_id}"` 去重，而 `reply_id` 传入的是**支线里那条用户消息的 id**（`service.py::_report` 传 `generation.user_message_id`）。用户在支线每发一句，就产生新的 `reply_id`，于是主线 `_insert` 一条新的 `role=assistant, status=complete` 消息，`meta.thread_update` 带状态与摘要。
- 这是**按设计实现**的，不是偶发 bug：`docs/thread-coordination.md` 第 26 行写明“每个工作轮次对应主线的一张 `thread_update` 卡片”，`tests/test_thread_coordination.py` 还断言了“两轮 = 两张”。所以是设计问题，要连文档和测试一起改。

### 同源的副作用（一并解决，但要单独验证）
1. **污染协调 AI 的上下文。** `store.history()` 不过滤任何消息，这些卡片是普通 assistant 消息，会进入主线的模型历史。
2. **污染支线的背景。** `store.role_context()` 给支线的 `main_recent` 取主线最近 6 条消息，其中包含这些卡片。
3. **主线在会话列表里被不断顶到最前。** `report()` 与 `_insert` 每次都写主线的 `updated_at`。
4. **协调 AI 看到的支线列表质量差。** `role_context()` 给主线注入的 `threads` 只带 `preview`（最后一条文本的前 80 字），没有 `progress_summary`，也不限数量（含全部已解决支线）。删掉卡片后，用户问“那个支线怎么样了”，协调 AI 只能靠这份列表回答，所以必须一并补强。

## 2. 目标行为（对照 Claude Projects）

依据（官方公开文档，不代表本项目调用其接口）：
[Projects redesigned](https://claude.com/resources/articles/projects-redesigned)、
[Claude Projects（Claude Code 文档）](https://code.claude.com/docs/en/claude-projects)、
[What are projects?](https://support.claude.com/en/articles/9517075-what-are-projects)。

文档明确写到的做法：
- 协调者“只看到线程汇报的结果，不看它每一步的操作”；Claude 不会把线程的每一步贴到主对话。
- 一个线程在主对话里是**用户消息下面的一张卡**（标题加状态，可点击），完整过程留在线程里。
- 状态放在 Overview 面板分组（等待你 / 运行中 / 空闲 / 已解决 等），“有线程在等你”用一个小圆点提示。
- 线程失败归入“等待你”。
- 已解决只是一种状态，可重新打开。

文档**没有**明确写的（本方案是推断，已与产品负责人确认）：线程后续每一轮是否往主对话发东西。我们的决定是**不发**，用户靠侧栏分组和红点感知进度。

### 改造后用户能看到的行为
| 场景 | 改造前 | 改造后 |
|---|---|---|
| 主线说“带我复习链表”，协调者派发支线 | 主线出现一张进展卡，并随每一轮新增 | 该用户消息下面出现**一张**支线卡（标题 + 实时状态点），之后永远不新增 |
| 在支线里连续聊 5 轮 | 主线多 5 张卡 | **主线消息数不变**，卡上的状态点随支线状态实时变化 |
| 支线进入“等待你”/失败 | 主线新增或更新卡片 | 侧栏分组变化 + 入口红点；主线无新消息 |
| 点击“已解决 → 合并回主线” | 若干进展卡 + 一张已解决卡 | 只有一张已解决小结（`thread_summary`，现有行为不变），线程卡状态变为“已解决” |
| 建议卡片（`propose_threads`）确认后 | 建议项变“查看支线”，另外还出现进展卡 | 只有建议项变“查看支线”，**不重复出现线程卡** |

## 3. 非目标（本次不做，需要的话另开任务）

- 轮询优化（`SubjectPage.tsx` 每 1.5 秒拉线程列表和整个主线）。
- 派发时右侧面板自动抢焦点的优化。
- 协调者在支线完成后被唤醒汇报：属于阶段二（第 8 节），**不要放进阶段一的 PR**。
- 自动将长期无活动的支线置为已解决。
- 任何关于“导师 / Teacher”角色的命名、提示词或结构调整。
- 重构 `SubjectPage.tsx` 和 `MessageList.tsx` 的无关部分。

## 4. 设计决定

**D1. 线程卡的数据来自 `thread_dispatches` 表，不再存成消息。**
`thread_dispatches(source_message_id, task_key, thread_id, message_id)` 已记录“主线哪条用户消息触发了哪个支线”（`store.py::initialize`，约 105 行）。接口返回主线消息时，给用户消息附带 `dispatched_threads: [{thread_id}]`，前端把卡片渲染在该用户消息下面。
- 历史派发无需迁移，卡片会自动“长出来”。
- 这个关系有 `ON DELETE CASCADE`（连接已开 `PRAGMA foreign_keys = ON`，见 `memory/store.py:41`）。用户消息被删除时对应记录一并消失，支线本身仍在侧栏。可接受。
- 同一支线被后续用户消息续接时，每次派发各对应一条记录，所以后面的用户消息下面也会有一张该支线的卡。这符合“用户又提了一次”的语义，状态点是实时的，不会不一致。

**D2. 卡片只带 `thread_id`，标题和状态由前端按 id 从 `threads` 列表实时取。**
好处：改名同步、不会过时、不需要任何写入。找不到对应支线（已删除或尚未加载）时**不渲染**该卡，不要显示坏卡。

**D3. 由建议卡片确认产生的支线不单独渲染线程卡。**
识别方式：`task_key` 以 `proposal:` 开头（见 `service.py::confirm_proposal`）。建议项本身已是入口，再加一张会重复。后端在组装 `dispatched_threads` 时过滤掉这类记录。这是个可以随时翻转的小决定，请保留一个常量或一处判断，不要散落。

**D4. 保留 `report_progress` 工具与 `progress_summary` / `needs_user` 元数据。**
`needs_user` 驱动 `execution_status = waiting`；`progress_summary` 现在给协调者的支线列表用（见任务 A5）。只是**不再**写入主线。

**D5. 已解决小结（`thread_summary`）保持现状**，它是内容性事件，不是状态播报。

## 5. 约束（编码规范）

- 代码风格与相邻代码一致：命名、注释密度、中英文注释习惯都跟随所在文件。不要顺手格式化、重命名或重排无关代码。
- 不新增依赖。阶段一不新增 DB 表、不改表结构，对数据库只有一次性的数据迁移（任务 C）；阶段二仅允许新增 `thread_reports` 一张表。
- **所有用户可见的新文案必须走 `tx()` / `t()` 并有英文翻译**（近期提交 `feat(frontend): complete English coverage across panels` 建立了这个要求）。优先复用已有短语：状态词沿用 `MessageList.tsx` 的 `EXECUTION_LABEL`，“查看支线”已在 `ThreadProposals.tsx` 使用。确实要新增时，加到 `frontend/src/lib/i18n/phrases*.ts` 并保证相关 i18n 测试通过。
- 前端新增的类型字段一律用**可选**（`?`），参照现有 `threadUpdate?`，否则 `src/app/dev/*` 的消息样例会因缺字段而无法通过类型检查。
- 面向模型的字符串（工具返回文本、提示词）如要改动，改完要确认没有测试依赖原文。
- 删除代码要彻底：删函数就同时删 import、死变量、不再使用的 CSS 类、不再使用的 i18n 短语（短语若别处还在用则保留）。

## 6. 任务清单

### 后端

**A1. 删除 `coordination.report()`**（`backend/app/chat/coordination.py`）
保留 `dispatch / next_delivery / cancel_deliveries`。清理 `report` 用到而别处不再用的 import。

**A2. 去掉所有向主线播报的调用**（`backend/app/chat/service.py`）
先删 `from ... import report` 与 `_report` 方法，再逐个处理调用点（行号为基线值）：

| 位置 | 处理 |
|---|---|
| `recover()` 约 162–168 | 保留 `merge_meta(... {"pending_approval": None})`；删掉 `report(...)`，以及只为拼播报文本而存在的 `checkpoint / available / blocked / detail` 局部变量（断点提示由支线内的 `checkpoint_available` 字段承担，不受影响） |
| `_await_approval()` 约 267、276 | 删除两处 `_report`；保留 `pending_approval` 的写入与清除（它驱动 `waiting`） |
| `_dispatch_thread()` 约 341–342 | 删除 `if not self.store.replies(message_id): report(...)`。**返回给模型的 JSON 保持不变** |
| `confirm_proposal()` 约 386–387 | 删除 `report(...)` |
| `_progress()` 约 391–397 | 保留 `merge_meta`（`needs_user`、`progress_summary`）；删 `report(...)`；返回文本里的“已将进展同步到主线”改为不再声称同步到主线的措辞 |
| `stop()` 约 403–405 | 保留 `cancel_deliveries(...)`；删除 `report(...)` 循环 |
| `begin()` 约 429 | 删 `_report` |
| `resume()` 约 475 | 删 `_report` |
| `_run()` 的 `finally` 约 920–931 | 删除“计算 status/summary 并 `_report`”的整个 `try/except`，**保留 `_release(generation)`、`_start_next_queued_thread(...)` 的 `try/except` 与 `queue.put_nowait(None)`**（释放槽位、启动排队任务必须照旧） |

做完后在 `backend/app` 下 grep `report(` 和 `_report`，应只剩与本功能无关的命中。

**A3. 调整消息模型**（`backend/app/chat/schemas.py`、`store.py`）
- 删除 `ThreadUpdate`（约 147 行）与 `ChatMessage.thread_update`（约 268 行）；`store.py::_message` 里对应赋值一并删除，同时清理 `ThreadUpdate` 的 import（约 16 行）。
- 新增 `DispatchedThread(BaseModel): thread_id: str` 与 `ChatMessage.dispatched_threads: list[DispatchedThread] = Field(default_factory=list)`。

**A4. 组装 `dispatched_threads`**（`store.py`）
- `conversation()`（约 430 行）一次性查出该会话所有用户消息对应的派发，按 `source_message_id` 分组，再传给 `_message`。不要在 `_message` 里逐条查库（N+1）。
- 只统计 `thread_dispatches` 中 `thread_id` 对应的会话**仍存在**且 `parent_id` 等于当前主线的记录；排除 `task_key LIKE 'proposal:%'`（D3）；同一消息内按 `rowid` 升序，同一 `thread_id` 去重。
- 单条消息接口 `message()`（约 854 行，SSE 的 `start` 事件会用到）也要返回同样的字段，复用同一个辅助方法。
- 只对主线（`kind = 'main'`）的 `role = 'user'` 消息附带；其他会话和角色保持为空列表。

**A5. 强化协调者的支线列表，并清理支线背景**（`store.py::role_context`，约 690 行）
- 主线分支：每个支线在现有的 `id / title / thread_status / execution_status` 之外增加 `progress_summary`（取该支线最新一条 assistant 消息的 `meta.progress_summary`，无则省略；可复用 `_summary` 里已经查出的 `latest`，不要新增每个支线多次查询）。`preview` 保留但保持短。
- 数量上限：未解决的最近 20 个给完整字段；已解决的最近 10 个只给 `id / title / thread_status`。上限写成模块级常量。
- 支线分支：`main_recent` 不能再包含进展卡片。清理迁移（任务 C）完成后卡片已不存在，这里**不需要**再加过滤，但要有测试证明。
- `prompts/main_coordinator.py` 第 1 条规则写着“询问已有任务的状态……直接简短回答”，这依赖上面的 `threads` 数据；除非测试表明需要，不要改提示词。

### 迁移

**C. 一次性清理历史卡片**（`ChatStore.initialize()` 里，沿用文件里 `ensure_column` 等现有迁移写法）
- 删除条件：所属会话 `kind = 'main'`，消息 `role = 'assistant'` 且 `kind = 'text'`，`meta_json` 中存在 `thread_update` 键。
- 判断方式优先用 SQLite `json_extract(meta_json, '$.thread_update') IS NOT NULL`。仓库里目前没有用过 `json_extract`，请先确认运行环境的 SQLite 带 JSON1；没有就改成在 Python 里读出 `meta_json` 解析后按 id 删除。**不要**用 `LIKE '%thread_update%'` 一刀切，工具输出里可能出现这个词。
- 必须：幂等（跑两次结果一样）、在事务内、只删上述消息、不改 `updated_at`、记一条日志说明删除条数。
- 这些卡片是纯派生信息，删除不丢数据：卡片会由 D1 从 `thread_dispatches` 重新呈现。
- 上线前提醒使用者备份数据库文件。

### 前端

**B1. 类型与映射**
- `frontend/src/lib/chat/types.ts`：删除 `threadUpdate`（约 138 行），新增 `dispatchedThreads?: Array<{ threadId: string }>`。
- `frontend/src/lib/chat/api.ts`：删除 `threadUpdate` 映射（约 70–73 行），新增 `dispatched_threads → dispatchedThreads`，缺失时为空数组。

**B2. `MessageList.tsx`**
- 删除 `threadUpdate` 渲染分支（约 457–480 行）。
- 删除“紧随用户消息之后的支线更新数”的统计与 `replyCount` 展示（约 382–387、417–422 行）及对应 CSS `.replyCount`，若 `CornerDownRight` 因此不再使用，一并移除 import。
- 新增 props：`threadStates?: Record<string, { title: string; executionStatus: ExecutionStatus | null; threadStatus: "open" | "resolved" | null }>`。
- 在**用户消息**行内（用户气泡下方）渲染线程卡：遍历 `message.dispatchedThreads`，对每个 `threadId` 取 `threadStates[threadId]`，取不到则跳过。卡片为 `<button type="button">`：状态点 + 标题 + 状态文案；点击调用 `onOpenSummary(threadId)`（沿用现有回调，无需改名）；带完整标题的 `title` 与 `aria-label`。
- 状态文案：支线已解决显示“已解决”，否则用 `EXECUTION_LABEL`；状态点样式沿用现有 `dot_*` 类。样式可直接复用 `.threadPill` 系列，但去掉摘要文本（不再有 `pillSummary`）。
- 注意：用户行已有 `data-msg-id`，不要破坏它；不要改动 `threadSummary`（已解决小结）的渲染与 `data-thread-summary` 锚点，`tests/thread-merge.test.cjs` 依赖它们。

**B3. `SubjectPage.tsx`**
- 从 `threads` 生成 `threadStates`，只传给**主线**那个 `MessageList`（约 534 行）。支线侧和 `ChatApp.tsx` 的 `MessageList` 不需要。
- `threadSignal`（约 414 行）去掉 `message.threadUpdate`，可改为判断 `dispatchedThreads?.length`。
- 状态文案存在两份（`MessageList.tsx` 的 `EXECUTION_LABEL` 与 `SubjectPage.tsx` 约 1130 行的 `executionLabel`），措辞略有不同。本次**不强制合并**；若合并，必须保证两处现有展示的文案不变。

**B4. 实时出现：`useChat.ts`**
- 派发发生在协调者回复流式生成期间。`thread_dispatched` 事件（约 333 行）目前只用来展开面板。需要同时把该 `threadId` 并入当前这条主线用户消息的 `dispatchedThreads`（去重），这样卡片在流式期间就出现；之后的轮询/重载会用服务端数据覆盖，结果必须一致。
- 注意只改本地消息列表的补丁逻辑，不要改变事件处理的其他行为。

**B5. 等待提示（可选，建议单独成一个提交，便于取舍）**
当任意支线的 `executionStatus` 为 `waiting` 或 `failed` 时，在 `SubjectPage.tsx` 现有 `tabs` 里进入支线列表的那个入口上显示一个小圆点。这是用户感知进度的唯一通道（主线不再有播报），样式参考现有 `count` 徽标的写法，保持最小改动。

### 测试

后端（`backend/tests/test_thread_coordination.py`，行号为基线）：

| 测试 / 行 | 改法 |
|---|---|
| `test_main_dispatch_starts_worker_reports_and_routes_followups`，107–108 | 删“主线有 1 张 waiting 卡”的断言；改为断言支线 `execution_status == "waiting"`，且该主线用户消息的 `dispatched_threads` 恰为 `[worker_id]` |
| 同上，121 | 删“卡片数 == 2”；改为：跟进消息 `followup` 的 `dispatched_threads` 也是 `[worker_id]`，且主线里 assistant 消息数 == 协调者回合数（证明没有额外消息） |
| 审批相关用例，174、179 | 174 行删除（173 行已断言 `waiting`）；179 行改为断言支线 `execution_status == "cancelled"` |
| `test_dispatch_scope_validation_and_provider_failure`，199–200 | 改为断言支线 `execution_status == "failed"` 且最后一条消息的 `error` 含“上游模型不可用” |
| 242 | 改为断言主线**没有**新增消息，支线最新 assistant 消息 `meta.progress_summary`（用 `store.message_meta`）包含“构造方法” |
| `test_analysis_supplies_concise_report_for_direct_sidebar_turn`，259–260 | 改为断言支线 `execution_status == "waiting"` 与 `message_meta` 里的 `progress_summary`；保留 261 行 `report_thread` 断言 |
| `test_recovery_starts_queued_independent_threads_once`，280 | 改为断言同一条用户消息的 `dispatched_threads` 有 2 个 |
| `test_stop_cancels_current_and_queued_deliveries`，300–301 | 改为断言两条投递均被取消（沿用 298–299 行已有断言），主线无新增消息 |
| `test_report_failure_does_not_block_queued_worker`，548–573 | 该用例靠 monkeypatch `_report` 失败来验证“收尾失败不阻塞排队任务”，`_report` 删除后失去意义。改写为：让某个支线以 `ProviderError` 失败，断言它的槽位被释放、排队任务仍启动；如已有等价用例，可删除，并在 PR 描述里说明 |

新增后端用例：
1. **刷屏回归**：同一支线连续 5 轮用户对话，主线 `len(messages)` 前后不变。
2. **迁移**：构造含历史 `thread_update` 卡片、普通消息、`thread_summary` 的主线，迁移后只删卡片；再跑一次迁移结果不变。
3. **`role_context`**：主线分支包含 `progress_summary`；超过上限时按规则截断；已解决项只含精简字段。支线分支的 `main_recent` 不含进展内容。
4. **`dispatched_threads`**：建议确认产生的支线被排除；支线被删除后不再出现；同一支线被两条用户消息续接时两条都有；接口 `GET /api/conversations/{id}` 的响应含该字段（可参照该文件中使用 `client.get(...)` 的写法）。

前端（`frontend/tests/`，参照 `thread-merge.test.cjs` 的 transpile 方式）：
- 新增线程卡用例：渲染标题与状态；点击触发 `onOpenSummary(threadId)`；`threadStates` 缺失对应 id 时不渲染；已解决显示已解决状态；用户行 `data-msg-id` 保留；页面中不再出现 `replyCount`。
- 现有 `thread-merge.test.cjs` 必须仍然通过（已解决小结行为不变）。

### 文档

- `docs/thread-coordination.md`：第 26 行“每个工作轮次对应主线的一张 `thread_update` 卡片……”、第 12 行用户流程第 4 点“主线的关联卡片持续更新该轮的状态……”、第 32 行“消息增加 `thread_update`”等，改成新行为；第 31–37 行接口说明里补 `dispatched_threads`。
- `docs/thread-improvements.md` 第 68 行附近人工验收步骤如有关联，同步。
- 在 `docs/thread-coordination.md` 顶部加一句指向本文件。

## 7. 验收

### 自动
在 `D:\KnowGap` 下按 `docs/thread-improvements.md` 的验证命令全部通过：

```bash
cd backend
.venv/Scripts/python.exe -m pytest -q
cd ../frontend
npm run test:api
npx tsc --noEmit
npm run lint
npm run build
```

### 逐条确认（打勾再提交）
- [ ] 在 `backend/app` 搜索 `thread_update`、`ThreadUpdate`、`report(`、`_report`，无残留命中（`thread_summary` 相关不在此列）。
- [ ] 在 `frontend/src` 搜索 `threadUpdate`、`replyCount`，无残留命中。
- [ ] 同一支线连续对话 5 轮，主线消息数不变（后端用例已覆盖）。
- [ ] 主线每个支线对应用户消息下只有一张线程卡，状态点随支线状态变化，改名后同步，删除支线后卡片消失。
- [ ] 点“已解决 → 合并回主线”后，主线只新增一张已解决小结，线程卡显示已解决。
- [ ] 建议卡片确认后，不重复出现线程卡。
- [ ] 支线处于等待/失败时，侧栏分组正确，B5 的圆点出现（如实现），主线无新消息。
- [ ] 协调者被问到某支线的进展时，注入的 `threads` 里含 `progress_summary`（后端用例）。
- [ ] 迁移幂等，重复启动服务不会反复删除，也不会误删普通消息和已解决小结。
- [ ] 新增英文文案齐全，语言切换后线程卡显示正确。
- [ ] 并发槽位（最多 2 个）、排队、停止、断点恢复相关既有测试全部不改语义地通过。

### 手工（使用独立测试库与确定性模型，不用真实模型）
1. 主线说“带我复习链表”→ 协调者派发 → 该用户消息下出现一张线程卡，右侧展开支线。
2. 在支线里连续发 3 条消息 → 主线不再新增任何内容，卡片状态点在“进行中/空闲”间变化。
3. 让支线进入等待用户作答 → 侧栏出现在“等待你”分组。
4. 合并回主线 → 一张已解决小结，卡片变已解决。
5. 刷新页面 → 卡片仍在，状态正确。
6. 拿一份含历史进展卡的数据库拷贝启动 → 历史进展卡消失，线程卡由派发记录呈现。

## 8. 阶段二：支线完成后唤醒协调者

> **前置条件：阶段一已合并。**本阶段依赖阶段一已经删除 `report()`、提供了 `dispatched_threads`、强化了 `role_context`。请另开分支、另提 PR，并放在开关后面（见 E9），出问题可以单独关掉或回退，不影响阶段一的修复。
> 本阶段**不引入任何“导师 / Teacher”角色或命名**，只做 Claude Projects 式的“线程完成后向协调者汇报，协调者决定是否行动”。

### 8.1 目标行为

依据与阶段一相同的 Claude Projects 文档：线程完成时向协调者汇报，协调者读取汇报后决定下一步；并且发言频率可以收敛（“只在完成或受阻时汇报”）。

| 场景 | 行为 |
|---|---|
| 主线交办的支线任务一轮结束，结果为**完成**（本轮没有等待用户） | 记一条汇报；主线空闲且安静一小段时间后，协调者被唤醒读取汇报 |
| 同上，结果为**失败** | 同上 |
| 用户在支线里**直接聊天**产生的回合 | **不**触发（用户本人就在现场，不需要转告协调者） |
| 支线进入**等待你**（需要用户作答） | **不**触发。用户靠侧栏分组与红点感知 |
| 用户**主动停止**的回合 | **不**触发 |
| 该支线已是“已解决” | **不**触发 |
| 用户此刻正在主线对话 / 主线正在生成 | 汇报保留为待投递，等主线空闲且安静后再投递 |
| 协调者被唤醒后 | **默认沉默**。只有三种情况行动：失败（用一两句话告诉用户发生了什么、能怎么办）；汇报改变了学习计划（`update_plan`，必要时一句话说明）；有明确下一步（`propose_threads` 展示建议，等待用户确认） |
| 协调者发了言 | 以一条**普通协调者回复**出现在主线（有内容的判断，而不是状态播报）。沉默时主线上看不到任何新东西 |
| 用户在唤醒回合进行中发消息 | 用户优先：唤醒回合被取消并丢弃，汇报回到待投递，用户消息立即正常处理 |

### 8.2 总体流程

```
支线（由主线交办的回合）结束
   └─ 生产：写入 thread_reports（同一支线最多一条待投递，新的覆盖旧的）
        └─ 调度：主线空闲且安静 N 秒后
             └─ 投递（单个事务）：插入隐藏事件消息 + 标记汇报已投递
                  └─ begin(main, 事件消息, detached=True)    # 与“派发支线”同构
                       └─ 协调者回合：stay_silent / 发言 / update_plan / propose_threads
                            └─ 沉默则删除事件消息与空回复；失败或被抢占则回滚为待投递
```

触发协调者回合的方式与现有“派发支线”完全同构：往目标会话插入一条 `role=user` 的消息，再 `begin(..., detached=True)`（参见 `coordination.dispatch()` 与 `service._start_delivery()`）。

### 8.3 设计决定

**E1. 汇报持久化到新表 `thread_reports`**（阶段二允许新增这一张表，其余表不改）
字段可以微调，但必须满足：
- 主键 id；`main_id`、`thread_id`（都引用 `conversations`，`ON DELETE CASCADE`）；`reply_id`（支线那条 assistant 回复，引用 `conversation_messages`，`ON DELETE CASCADE`）。
- `outcome`：`completed` / `failed`（`CHECK`）。`summary`：文本，写入前裁剪（沿用 `clip`，不超过 600 字）。
- `state`：`pending` / `delivered` / `skipped`；`delivered_event_id`（事件消息 id，可空）；`attempts`（整数，默认 0）；`not_before`（可空，退避用）；`created_at`。
- **局部唯一索引**：`UNIQUE(thread_id) WHERE state = 'pending'`。写入时用 upsert：同一支线在汇报被投递前再次完成，覆盖旧的待投递汇报（只保留最新摘要）。这同时完成了“合并”和“限流”。
- 建表与建索引放在 `ChatStore.initialize()`，用 `CREATE TABLE IF NOT EXISTS`，沿用文件里的写法。

**E2. 隐藏事件消息**
- 新增 `ChatStore` 方法（例如 `add_system_event`），内部用 `_insert` 写入：`role='user'`、`kind='text'`、`status='complete'`、`meta={"system_event": {"type": "thread_report", "report_ids": [...], "thread_ids": [...]}}`。
- **不要**使用 `add_user_message()`，它会顺带改会话标题。
- `content` 是给模型看的文本，必须以固定前缀开头，并写明“这不是学习者的发言”，例如：
  ```
  【系统事件 · 支线汇报】以下内容不是学习者说的话。
  - 支线「{title}」（id: {thread_id}）：{已完成|执行失败}
    摘要：{summary}
  ```
  多个汇报合并成多个条目，一个事件最多合并 5 条。
- 事件消息与“标记汇报为已投递”必须在**同一事务**内完成（模仿 `dispatch()` 的做法），重放不会重复投递。

**E3. 生产者：在哪里、何时写汇报**（`service.py::_run` 的 `finally`，原来 `_report` 所在的位置）
满足以下全部条件才写：
1. 当前会话是支线，且 `generation.parent_id` 有值；
2. 本轮的用户消息带 `delegated_task`（即由主线交办），用 `self.store.message_meta(generation.user_message_id)` 判断；
3. 回复最终状态为 `complete` 且本轮没有等待用户（`needs_user` 为假），或最终状态为 `failed`；`cancelled` 不写；
4. 支线 `thread_status != 'resolved'`；
5. 开关打开（E9）。

写汇报**不能**影响槽位释放和下一个排队任务的启动：整个生产过程包在 `try/except` 里，失败只记日志（沿用该 `finally` 现有的写法），`_release` 与 `_start_next_queued_thread` 必须照旧执行。

摘要来源：优先 `meta.progress_summary`；失败时用回复的 `error`；都没有就用回复正文节选并标明是节选（沿用阶段一删除前 `finally` 里使用的规则）。

**E4. 投递调度**（`service.py` 新增 `_schedule_wake(student_id, main_id)` 与 `_deliver_reports(student_id, main_id)`）
常量放模块顶部，便于测试 monkeypatch：
- `WAKE_QUIET_SECONDS = 20`：主线最后一条消息距今不足这个时间则不投递。
- `WAKE_MAX_BATCH = 5`：一个事件最多合并的汇报数。
- `WAKE_MAX_ATTEMPTS = 3`，退避 `60 * 2**attempts` 秒。
- `WAKE_DAILY_CAP = 20`：同一学习空间过去 24 小时内最多投递的事件数；超出的汇报置为 `skipped`，不再重试。

调度用 `asyncio` 的 `loop.call_later`（或等价的单个后台任务），句柄按 `main_id` 保存，**重复调度要替换旧句柄**；`close()` 里必须取消全部句柄，否则测试和关闭服务会遗留任务。

触发调度的三个时机：① 生产者写入汇报之后；② 任意**主线**生成结束之后（`_run` 的 `finally`，当 `role == "main"` 时）；③ `recover()`。

`_deliver_reports` 在执行时重新检查：服务未关闭、开关打开、主线未在生成（`self.is_generating(main_id)`）、安静期已过、存在 `state='pending'` 且 `not_before` 已到的汇报、未超每日上限。任何一项不满足就直接返回（下一次时机会再调度）。满足则在一个 `BEGIN IMMEDIATE` 事务内取最多 `WAKE_MAX_BATCH` 条最旧的待投递汇报，插入事件消息并标记已投递，事务提交后调用 `self.begin(student_id, main_id, event_id, [], detached=True)`。

**E5. 协调者的唤醒回合**（`service.py::_run`，通过 `user_meta.get("system_event")` 识别；这个标志必须取自用户消息的 `meta`，**不要**存到 `Generation` 构造参数里，这样“重新生成”这类回合也会得到同样的限制）
对事件回合：
- 跳过记忆检索和讲义检索（`relevant_memories`、`library.search*` 传空），事件文本不是学习者的问题。
- **工具白名单**（`service.py` 约 713–719 行的 `definitions` 过滤处）：只保留 `propose_threads`、`update_plan`、`session_search`、`stay_silent`。不要给 `dispatch_thread`、`memory`、`agenda_*`、`create_document` / `edit_document` / `read_document`。同时**不要**设置 `ctx.dispatch_thread`（双重保险：即使模型硬调用也会被拒绝）。
- **跳过全部学情与记忆副作用**：`bump_note_turns` 及其后的 `_review`（约 859–879 行）、`_analyze`（约 881–891 行，沿用 882–883 行那样发出 `("analysis", {"skipped": True})`）、自动命名、上下文压缩（在 `_analyze` 内触发，随之跳过）。事件消息不得被计入 `note_counted`，也不得出现在 `_review` 的 `user_rows` 里。
- `message_meta(user_message_id)` 里的 `system_event` 同时作为后续逻辑的唯一判断依据，封装成一个小函数（例如 `is_system_event(meta)`）放在一处，不要到处写字典键判断。

**E6. 新工具 `stay_silent`**
- 在 `agent_tools/__init__.py` 的 `DEFINITIONS` 里新增（无参数），分发写法参照 `dispatch_thread` / `propose_threads`（约 307–318 行）：通过 `ctx.stay_silent` 回调，回调只设置 `generation.silent = True` 并返回简短确认文本。
- **只能出现在事件回合**：普通主线回合、支线、普通会话的工具列表里都不能有它。注意 `service.py` 约 717 行的 `else` 分支是“排除名单”写法，**必须把 `stay_silent` 加进那个排除集合**，否则支线和普通会话会拿到它。
- 回合结束后（`finish_reply` 之后）：如果 `generation.silent`，或回复正文为空，**并且**这一轮没有可见的副作用（`plan_changes` 为空、没有 `thread_proposals`），就调用一个新的 `ChatStore` 方法删除这条 assistant 回复和对应的事件消息（同一事务，先删回复再删事件）。汇报仍然保持“已投递”。
- 如果这一轮产生了计划变更或建议卡片，回复保留（即使正文为空），让用户能看到。

**E7. 用户优先：抢占**
- 现状：`router.send_message` 在 `require_idle()` 处，主线正在生成时返回 409。前端 Composer 的 `generating` 只取本地流式阶段（`phase`），服务端发起的唤醒回合不会禁用输入框，所以用户**可以**在唤醒回合进行中发送，必须由后端处理。
- 在 `service.py` 新增 `async def preempt_system_turn(conversation_id) -> bool`：若当前活跃的生成是事件回合，取消它并等待结束（设超时，如 5 秒），然后丢弃回复与事件消息，把对应汇报改回 `pending`（`delivered_event_id` 置空，`attempts` 不加）。非事件回合直接返回 False。
- 在 `router.send_message` 里 `require_idle` 之前调用它。其余接口（重新生成、压缩、切模型）保持原有 409，不抢占。
- 抢占后确认 `self.active` 已释放，用户消息才能 `begin`。

**E8. 失败、重启与回滚**
- 事件回合以 `failed` 或 `cancelled`（含抢占）结束，或被 `close()` 打断：丢弃回复与事件消息，汇报回到 `pending`，`attempts + 1`，`not_before = now + 退避`；`attempts >= WAKE_MAX_ATTEMPTS` 则置 `skipped`。把这段逻辑收口到一个 `_settle_wake(generation)`，在 `_run` 的 `finally` 里对事件回合调用，不要散落在各个 `except` 里。
- `recover()`：① 找出没有完整回复（或回复为中断失败）的事件消息，按上面的规则回滚；② 对存在待投递汇报的主线调用 `_schedule_wake`。重复启动不得重复投递。

**E9. 开关**
- 新增 `agent_config` 的 `coordinator_wakeup`，默认 **True**：在 `services/ai_settings.py` 的 `agent_config()` 读出，并在更新逻辑（约 170–181 行）里加入对应字段，使用方式沿用 `service._agent_flag`。**不需要**做设置界面。
- 关闭时：不写汇报、不投递；已有的待投递汇报保持 `pending`，不要删除。

**E10. 提示词**（`backend/app/chat/prompts/main_coordinator.py`，追加一段，不改动现有规则）
建议文本（可微调措辞，但这几条语义不能少）：

```
系统事件：当最新的用户消息以「【系统事件 · 支线汇报】」开头时，它不是学习者说的话，而是支线完成任务后的汇报，学习者看不到这条消息。此时：
1. 默认调用 stay_silent。不要复述汇报，不要寒暄，不要说「支线已完成」这类界面上已经显示的信息。
2. 只有三种情况可以发言或行动：
   (a) 支线失败：用一两句话告诉学习者发生了什么、可以怎么办；
   (b) 汇报改变了学习计划：用 update_plan 更新对应步骤，必要时用一句话说明；
   (c) 有明确的下一步：用 propose_threads 展示建议，等待学习者确认。
3. 本回合不能 dispatch_thread，也不能写文档或日程；不要声称学习者说过什么。
```

**E11. 前端**（只做展示层的两件事）
- `lib/chat/types.ts` / `api.ts`：映射后端新增的 `system_event`（schemas 里新增可选字段，例如 `system_event: SystemEvent | None`，含 `type` 与 `thread_ids`；`store._message` 从 `meta.system_event` 读出）。前端字段用可选类型，原因同阶段一的约束。
- `MessageList.tsx`：① 带 `systemEvent` 的**用户消息不渲染**，并且不参与 `lastUser`、置顶、折叠、消息计数等基于“最后一条用户消息”的逻辑；② 回复这类事件的 assistant 消息，在 `status === "streaming"` 且没有可见内容时不渲染（避免出现一个空气泡再消失），有内容后正常渲染；回复的“重新生成”等操作保持原有行为。
- `store.last_user_message()` 与 `regenerate` **不要改**：事件回合的回复被重新生成时，应当对事件消息重新运行协调者回合，这与上面的限制自然一致。
- 不需要新增用户可见文案。

### 8.4 约束（阶段二附加）

- 阶段一的“红线”第 1 条在本阶段有且仅有一处例外：**隐藏事件消息（`meta.system_event`）及其触发的协调者回复**可以写入主线。除此之外，不得新增任何向主线写消息的路径。
- 唤醒回合**必须**无法派发支线（E5 白名单加上不设置 `ctx.dispatch_thread`），防止“完成 → 派发 → 完成 → 派发”的循环。如果你发现需要放开这一条，先停下来问。
- 唤醒回合不得写学习者记忆、笔记、日程、文档。
- 不得让事件消息影响学情分析、标题、压缩、记忆回顾的计数。
- 不新增依赖；除 `thread_reports` 外不新增表；不改动支线的 `execution_status` 推导。
- 常量全部放在模块顶部并有注释，便于测试用 monkeypatch 把安静期改成 0。
- 所有新增的后台任务和定时句柄必须在 `close()` 里清理。

### 8.5 任务清单（建议提交拆分）

1. **数据与生产者**：`thread_reports` 表与索引；`ChatStore` 的写入（upsert）、查询、状态更新方法；`_run` 里的生产逻辑（E1、E3）。
2. **事件消息与回合改造**：`add_system_event` / `discard_system_event`；schemas 里的 `system_event`；`_run` 对事件回合的分支（E2、E5）。
3. **调度与回滚**：`_schedule_wake`、`_deliver_reports`、`_settle_wake`、`recover()` 接入、`close()` 清理（E4、E8）。
4. **`stay_silent` 与提示词**：工具定义与分发、排除集合、静默删除逻辑、提示词段落（E6、E10）。
5. **抢占与开关**：`preempt_system_turn`、`router.send_message` 接入、`coordinator_wakeup` 配置（E7、E9）。
6. **前端展示**：E11 与测试。
7. **文档**：`docs/thread-coordination.md` 增加“汇报与唤醒”一节，并在顶部指向本文件。

### 8.6 测试

后端（沿用 `tests/test_thread_coordination.py` 里的 `Coordinator` 假模型和独立 `tmp_path` 数据库；用 monkeypatch 把 `WAKE_QUIET_SECONDS` 设为 0）：

1. 派发回合完成 → 写入待投递汇报 → 投递后主线出现隐藏事件消息并运行协调者回合。
2. 用户在支线直接发送的回合 → 不写汇报。
3. 回合结果为 waiting / cancelled / 支线已解决 → 不写汇报；failed → 写汇报。
4. 同一支线在投递前连续完成两次 → 只有一条待投递，摘要为最新；两个支线同时完成 → 一次唤醒包含两条汇报。
5. 主线正在生成时不投递；生成结束后投递。
6. 协调者调用 `stay_silent` → 回复与事件消息被删除，汇报为 `delivered`，主线消息数不变。
7. 协调者输出文字 → 回复保留，接口响应里事件消息带 `system_event`；协调者只调用 `update_plan` 且正文为空 → 回复保留。
8. 工具限制：事件回合的工具定义里没有 `dispatch_thread`；强行构造调用被拒绝，不产生新支线；`stay_silent` 不出现在普通主线、支线、普通会话的工具定义里。
9. 抢占：唤醒回合进行中用户发消息 → 唤醒被取消并丢弃，汇报回到 `pending` 且 `attempts` 不变，用户消息正常生成；之后再次满足条件时重新投递一次。
10. 失败重试：协调者回合抛 `ProviderError` → 丢弃、`attempts + 1`、`not_before` 生效；达到上限后 `skipped`。
11. 重启恢复：存在待投递汇报，`recover()` 后被投递；存在中断的事件回合，回滚后重新投递，且不重复。
12. 每日上限与开关：超出上限置 `skipped`；开关关闭时不写汇报、不投递，已有 `pending` 保留。
13. 副作用：事件回合不调用 `_analyze`、不增加 `note_counted`、不触发 `_review`、不写学习者记忆证据。
14. 上下文：事件消息出现在后续真实用户回合的历史里，且带固定前缀。
15. 循环防护：整个唤醒回合期间不产生新的 `thread_reports` 行、不产生新支线。

前端：带 `systemEvent` 的用户消息不渲染；回复事件的空且 streaming 的 assistant 消息不渲染，有内容后渲染；它们不影响 `lastUser` 的判断。

### 8.7 验收（阶段二）

- [ ] 第 8.6 节全部通过，并且阶段一的全部测试仍然通过。
- [ ] 在 `backend/app` 搜索 `system_event`，所有使用点都经过同一个判断函数。
- [ ] 沉默时主线里看不到任何新增内容（包括没有空气泡闪现）。
- [ ] 用户在唤醒回合期间发消息，不会收到 409，也不会丢汇报。
- [ ] 重启服务后，待投递汇报被送达一次，不重复。
- [ ] 关闭开关后行为与阶段一完全一致。
- [ ] 手工验收（独立测试库 + 确定性模型）：派发一个任务 → 完成 → 静默期后协调者被唤醒；让假模型分别返回“沉默 / 发言 / 失败”三种情况，观察主线表现；唤醒回合中途发送消息，确认抢占生效。

### 8.8 阶段二风险与待核实

风险：
- 最大风险是隐藏的 `role=user` 消息被误当成学习者发言。凡是遍历用户消息的地方都要核对一遍：学情分析、记忆回顾、标题、压缩、进度统计、前端基于“最后一条用户消息”的逻辑。
- `message_count`（`store._summary`）会把事件消息计入；是否要排除由实现者判断，但要保持前后一致。
- 每次唤醒是一次完整的协调者调用（主线提示词较长），成本由 E4 的合并、安静期、每日上限来控制；用量已经按会话记入 `model_usage`。

待核实（实现前先确认，并在 PR 描述里写结论）：
- `chat_messages()`、`dialogue()`、`compress_history_messages()` 如何把用户行转成模型消息，确认事件前缀不被裁掉。
- `_compress_later` 是否只在 `_analyze` 内被调用（决定跳过 `_analyze` 后压缩是否还会被触发）。
- `conversation_messages.client_request_id` 是否有唯一约束（事件消息建议传 `None`）。
- 抢占时 `asyncio.Task` 取消与 `_run` 的 `CancelledError` 分支、`_release`、`finally` 的相互顺序，防止出现“已取消但仍在 `self.active` 里”的窗口。
- `agent_config()` 的更新逻辑是否对未知字段有严格校验。

## 9. 已核实与待核实（阶段一；阶段二的风险和待核实项见 8.8）

已通过阅读代码核实（基线 `17f9ab5`）：
- 根因与全部 `report` 调用点；`history()` 不过滤消息；`main_recent` 含主线最近消息；`execution_status` 只由支线自己的消息推导；`thread_dispatches` 的结构、级联删除、外键开启；`dispatch()` 是工具派发与建议确认共用的创建路径；手工创建支线的旧接口（`POST /api/subjects/{id}/threads` → `create_thread`）**不写** `thread_dispatches`，所以这类历史支线不会有线程卡，只在侧栏出现（产品界面已无该入口，可接受）。
- `thread_update` 只在后端 `coordination/schemas/store`、前端 `api/types/MessageList/SubjectPage`、测试与文档中出现；`desktop/` 与 `reports/` 中无引用。

**未核实，实施者请先确认：**
- 运行环境的 SQLite 是否带 `json_extract`（决定迁移写法）。
- `ChatApp.tsx` 中的 `MessageList`（非学习空间会话）不受影响，只需确认新增 props 为可选、缺省时行为不变。
- `useChat.ts` 里 `start` 事件携带的 `userMessage` 能否让 B4 拿到“当前用户消息 id”；如不能，请用最小改动保存它。
- 删除 `recover()` 里的 `report` 后，服务重启被中断的支线是否仍被推导为 `failed`（依赖那条回复本身的 `status/error`，应成立，请用测试确认）。
- 前端 i18n 测试对新增短语的具体要求。

## 10. 风险与回滚

- 风险最大的两处：A2（调用点多，漏删会导致运行时 `NameError`）和 A4（`conversation()` 查询要避免 N+1 与跨主线误关联）。每个任务单独提交，便于二分排查。
- 建议提交拆分：① 后端停止播报 + 删 `report` + schema + `dispatched_threads` + 后端测试；② `role_context` 强化；③ 迁移；④ 前端线程卡 + 前端测试；⑤ B5 红点；⑥ 文档。
- 回滚：迁移只删除可由 `thread_dispatches` 重新生成的派生数据，回滚代码后旧版本不会重新生成历史卡片（只会从下一次支线回报起重新产生），这是已知且可接受的差异。因此上线前务必备份数据库。
- 阶段一与阶段二必须是两个独立的 PR。阶段二出问题时，关掉 `coordinator_wakeup` 开关即可回到阶段一的行为；需要回退代码时，阶段二的提交不应牵连阶段一。
- 不要自行 push 或合并；每个阶段完成后在 PR 描述里列出：改了哪些文件、删除了哪些测试及理由、待核实各项（阶段一为第 9 节，阶段二为 8.8）的结论。
