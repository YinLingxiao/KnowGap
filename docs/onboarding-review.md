# 初识访谈修复与审阅入口

## 本轮行为

- 首次默认进入，可随时跳过。状态分别为 `not_started / in_progress / skipped / completed`。
- 不用 USER 是否非空、标题、用户消息数量推断完成。三个信息槽为背景与目标、讲解偏好、互动偏好。
- AI 通过独立 JSON 信息提取调用提出候选信息；代码逐项校验字段、长度、连续原话引用。
- 可一次回答多个信息槽、拒答或反问。没有有效信息就继续当前话题；最多六轮后允许核对已有信息，缺失信息不编造。
- 草稿、原话来源 message_id、进度、处理过的消息 ID 和版本持久化。重复发送不会重复计数。
- USER 仅在用户点击确认后写入；用户可编辑、清空条目。候选草稿与原话保留供溯源。
- 确认保存与完成状态同事务提交，版本冲突/扫描拒绝/超限失败不会完成；原有无关笔记保留，同前缀字段替换而非反复追加。
- 跳过保留草稿，不宣称保存成功；不会再次自动弹出，可从学习记忆的“继续完善我的画像”恢复。
- 访谈绕过普通 agent 工具循环，无文件、命令、Thread 或 memory 写入工具。访谈不触发普通学情抽取和后台画像复盘。
- 画像确认按钮是明确的本次保存授权；日常 agent memory 的审批机制仍然保留，不使用绕过审批的兜底写入。

## 接口

- `GET /api/onboarding`：状态、会话 ID、当前缺失槽、draft、ready、version。
- `POST /api/onboarding/start`：幂等开启/恢复；显式操作可重新打开已跳过/已完成访谈。
- `POST /api/onboarding/skip`：独立跳过，停止当前访谈生成，保留草稿。
- `POST /api/onboarding/complete`：`{version, entries: {background?, explanation?, interaction?}}`。必须已到核对阶段且无生成任务。

## 代码入口

- `backend/app/chat/onboarding.py`：独立提取 Prompt、状态和原话校验。
- `backend/app/chat/store.py`：启动、恢复、跳过、确认与事务。
- `backend/app/chat/service.py`：专用访谈分支；版本防止跳过后的迟到模型结果推进状态。
- `backend/app/chat/router.py`：HTTP 契约。
- `frontend/src/components/chat/ChatApp.tsx`：服务端状态驱动的访谈、核对、模型设置、恢复入口。

## Memory 与三角色

- USER 是全局长期画像的权威来源；历史偏好仍可溯源，放在 `preference_evidence`，不再作为另一份独立教学指令。
- `teaching_preferences` 从 USER 中标准化的“讲解偏好：/互动偏好：”条目生成。
- `learner_memories` 只向教学上下文提供知识点记录；历史偏好证据另列。
- 临时“这次/这道题”不写入长期偏好；公共 Prompt 与 memory 工具描述统一了职责。
- 三角色每轮读取最新 USER；Thread 不依赖协调者转述画像。
- 角色 Prompt 仍各自管理；执行 Skill 优先用于 Thread，不能覆盖用户本轮的明确要求。

## 数据迁移与限制（审阅时重点关注）

- 新增 `onboarding_sessions`，不删除数据库或修改现有模型配置。旧 `agent_state.onboarded=1` 迁为完成；旧版本已将“跳过”错误写为完成，无法从旧布尔值可靠区分，不能无依据强制重访。
- USER 仍存 SQLite，不是实际 USER.md 文件。此次没有增加第二份磁盘画像。
- 尚未接入登录；HTTP 路由仍使用固定演示身份。表按 student_id 隔离不代表已经具备认证授权。
- 空间专属要求仍应通过现有空间教学说明管理；本轮没有实现通用的、按维度自动解决所有自然语言偏好冲突的偏好数据库。全局 USER 的任意自然语言条目更新仍依赖模型正确使用精确 patch。
- JSON 提取是否忠实概括仍需要模型判断，因此必须保留人工核对；原话存在性校验不等于语义一定正确。
- 模型提取调用不是 token 流式输出；等待期间可停止和重试。
- 此次未修改服务商原生 reasoning 参数，也未声称缓存前缀永远不变。
- 未调用真实付费模型、未打包 exe；浏览器交互尚未做自动化端到端验证。

## 测试

- 后端 `pytest checks tests -q`：237 passed（Starlette 测试客户端一项弃用警告）。
- 前端 `npm run test:api`：22 passed；`npx tsc --noEmit`、`npm run lint` 通过。
- 新增覆盖：第一问后刷新对应状态、跳过/继续、反问、伪造引用、多槽回答、拒答、改名、确认版本冲突、幂等确认、失败重试、保存拒绝的事务回滚、访谈不执行工具、临时偏好不持久化。

后续真实模型验收建议使用独立测试用户/临时数据，不清空当前用户记录。
