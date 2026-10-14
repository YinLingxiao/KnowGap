# 自由对话 API 与状态约定

首页是 ChatBox 式的自由对话：不需要先选题，题目只是可选上下文。旧的 `/api/diagnosis`、`/api/sessions/*`、`/api/memories` 保持不变，新界面不再调用它们。

代码位置：`backend/app/chat/`（`store.py` 持久化与分层检索、`service.py` 生成与流式、`agent.py` 提示词与校验、`router.py` 对话与记忆接口、`subjects.py` Subject 接口）；前端 `frontend/src/hooks/useChat.ts`、`frontend/src/lib/chat/`、`frontend/src/components/chat/`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / POST | `/api/subjects` | 学习空间列表 / 新建。新建同时创建主对话，字段见下文 |
| GET / PATCH / DELETE | `/api/subjects/{id}` | 读取、修改、删除学习空间 |
| GET / POST | `/api/subjects/{id}/threads` | 该空间的 Thread / 新建 Thread |
| POST | `/api/conversations/{id}/resolve/draft` | 起草 Thread 小结，不保存 |
| POST | `/api/conversations/{id}/resolve` | 确认小结，合并回主对话 |
| POST | `/api/conversations/{id}/reopen` | 重新打开 Thread |
| GET | `/api/conversations` | 会话列表（按更新时间倒序）；`?subject_id=` 只列某个 Subject |
| POST | `/api/conversations` | 新建；可选 `subject_id`、`problem_id`（带入练习题）、`client_request_id`（同一 id 重复提交返回同一会话） |
| GET | `/api/conversations/{id}` | 会话与全部消息（按 `seq`） |
| PATCH | `/api/conversations/{id}` | `{"title"}` 重命名，之后不再自动改标题；`{"subject_id"}` 移动会话，传 `null` 表示移出 Subject |
| DELETE | `/api/conversations/{id}` | 删除会话与消息；正在生成时先停止 |
| POST | `/api/conversations/{id}/messages` | `{"content", "client_request_id"}`，返回 `text/event-stream` |
| POST | `/api/conversations/{id}/regenerate` | 替换最后一条用户消息的回复，返回事件流 |
| POST | `/api/conversations/{id}/stop` | 停止当前生成 |
| POST | `/api/conversations/{id}/exercises` | `{"problem_id"}` 把练习题带入当前会话 |
| GET / PATCH / DELETE | `/api/learner-memories[/{id}]` | 学习记忆的查看（`?subject_id=` 过滤）、纠正（`summary`、`status`、`subject_id`，`null` 表示通用）、删除 |
| GET / POST | `/api/materials` | 课程资料；`?subject_id=` 上传到或只列某个 Subject，`?unassigned=true` 只列未归类资料 |

## 流式事件

`start`（已保存的用户消息 + `streaming` 状态的回复占位，含 `discarded_ids`）→ 若干 `delta` → 以 `done` / `cancelled` / `error` 之一结束文本 → `analysis`（练习判定、记忆变化、实际参考的记忆、推荐练习）。

## 消息状态

- 用户消息在调用模型**之前**保存；模型失败不会丢失输入。
- 回复只会停在一种终态：`complete`；`cancelled`（用户停止，或客户端断开、刷新页面，保存停止前已显示的部分）；`failed`（保存错误信息与已有部分，不进入后续模型上下文）。
- 服务重启时遗留的 `streaming` 回复会被标记为 `failed`。
- 每个会话同时只有一个生成；生成中再发送返回 409。

## 去重

`client_request_id` 在会话内唯一：

- 同一 id 再次发送且回复已完成：重放已保存的结果，不再调用模型；
- 回复失败或已停止：替换旧回复并重新生成，用户消息不重复；
- 仍在生成：409。

前端对相同文本的重试复用同一个 id。

## 学习记忆

- 回复完成后，再单独调用一次模型，提出候选记录；每条用户消息只分析一次，重新生成时不会重复分析。
- 只保留证据是用户原话逐字片段的记录；以问号、“吗”“呢”结尾的提问不能作为误区证据。
- 类型分为 `misconception`（`suspected → needs_review → improving → resolved`）、`mastery`、`preference`（`observed / uncertain`）。状态按证据由程序决定，模型只负责提出证据。
- 检索只取与当前消息或练习话题词面相关的记录，学习偏好始终参与检索。
- 用户纠正后，`summary` 不会再被模型覆盖。
- 删除会话后，记忆保留证据快照，并标记来源已删除。

## 学习空间、主对话与 Thread

界面叫学习空间，代码和表名仍是 `subject`。它不是一组平行对话：每个空间在创建时就有且只有一条主对话（`conversations.kind = main`），承载整体学习路线。具体卡点另开 Thread（`kind = thread`，`parent_id` 指向主对话，`anchor_message_id` 指向展开它的那条消息）。

- 新建：`POST /api/subjects` 接受 `goal`、`level`（`beginner` 零基础 / `some` 学过一些 / `fluent` 比较熟练 / `exam` 冲刺备考）、`deadline`、`color`。名称必填。同一个事务里创建主对话，返回 `main_conversation_id` 和 `progress`。`PATCH` 可以改这些字段。
- Thread：`GET / POST /api/subjects/{id}/threads`。创建参数 `title?`、`anchor_message_id?`、`client_request_id`（重复提交返回同一条）。未解决的排在前面。
- 合并：`POST /api/conversations/{id}/resolve/draft` 只起草，不写库，返回 `{title, summary, takeaways}`。小结必须是 2–4 句，要点最多 4 条；模型失败或格式不对时返回真实错误，Thread 状态不变。`POST /api/conversations/{id}/resolve` 用用户确认后的正文把 Thread 标为已解决，并在主对话追加一条 `kind = text` 的助手消息，细节在 `meta.thread_summary`（Thread id、标题、要点、相关记忆 id）。已解决时再次提交不追加。`POST /api/conversations/{id}/reopen` 重新打开，之后再次解决会再追加一条。
- 上下文：主对话负责路线，可以口头建议开 Thread。Thread 只处理当前问题，并附上锚点消息和主对话最近 6 条（截断）。`goal` / `level` / `deadline` 有值时才放进 `subject`，用来调整讲解深度和节奏。
- 进度：`progress.to_review` 是疑似和需巩固的误区，`improving` 是改善中，`mastered` 是掌握记录加已解决的误区，另有未解决 / 已解决 Thread 数，以及空间内对话的最近更新时间。
- 删除空间：主对话和 Thread 变回普通对话（清空 `parent_id`、锚点和状态），记忆改为通用，资料移到未归类。
- 迁移：启动时给没有主对话的旧空间补一条，并把当时已经在空间里的其他对话转成未解决 Thread。之后新建的普通对话不会被这次迁移改掉。

侧栏只放入口和「最近」（普通对话与学习空间按活跃时间混排，Thread 不出现）。总览页用进度，不用「更新于」。

## Subject 与分层检索

学习空间相当于 Claude / ChatGPT 的 Project，但主线是一条对话而不是一组平行会话。它拥有主对话、Thread、说明（instructions）、知识库（课程资料）和记忆。

- 说明会随每次对话发给模型，作为用户偏好，不能覆盖核心教学规则。
- 资料检索：先查本 Subject 的资料，不够时再补充未归类资料。其他 Subject 的资料不会被检索。
- 记忆写入：误区和掌握情况记到对话所属的 Subject；学习偏好一律记为通用（`subject_id = null`）。
- 记忆检索（`ChatStore.relevant_memories`）按层进行：
  1. 学习偏好：通用的和本 Subject 的，最多 2 条。
  2. 本 Subject 的记录，再加通用记录，按话题相关度打分，合计最多 3 条。
  3. 只有当第 2 层相关结果少于 2 条时，才查其他 Subject，最多 2 条。门槛更高：必须命中概念标签，或命中至少两个字的词，或 `topic_key` 相同；已解决的误区不取。
- 相关度：标签命中计 2 分，其余按词面重合计分，`topic_key` 相同再加分。
  标签（`tags`）由写入记录时的模型给出，是 1–4 个核心概念词，例如"栈 / LIFO"。这样"函数调用栈"这类说法也能对上已有的"栈"相关记录。
- 每条记忆在上下文中带 `scope` 字段（本科目 / 通用 / 其他科目：X）。参考了其他 Subject 的记忆时，界面会标出来源。
- 记录分析的输出用 `effect` 字段：
  - `reinforces`：证明这条记录成立；新建的记录一律用这个值。
  - `weakens`：只针对 `related_memory_id` 指向的已有记录，表示用户现在的表现与它相反。
  - 旧字段 `signal` 仍然兼容。
- 删除 Subject 不会删除学习数据：对话和资料移到未归类，记忆改为通用。
- 迁移：启动时用 `ensure_column` 给旧库补齐 `subject_id` 和 `tags_json` 列，可以重复执行。

## 练习

练习题以 `kind: "exercise"` 消息出现在对话中。最近一道题及程序校验过的参考推导（`simulate_stack`）会作为上下文传给模型。当学生明确给出的结论与参考推导矛盾，而模型却判为正确时，该判定会被丢弃（复用 `reference_guard`）。

## 旧数据兼容

启动时以及列表请求时，旧 `learning_sessions` / `learning_memories` 会被复制到新表；`legacy_imports` 记录已复制项，删除后不会再次导入。旧表不改动，旧接口仍可用。
