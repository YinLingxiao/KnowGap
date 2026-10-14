# 三个 AI 的协作说明

日期：2026-10-14。按用户最新安排，GPT 和 Cursor 共享后端目录及分支。

| 工具 | 目录 | 分支 | 文件归属 |
| --- | --- | --- | --- |
| GPT | `D:\黑客松\KnowGap-backend` | `feat/backend` | `backend/app/`、依赖、`backend/checks/`、配置示例、接口和架构文档 |
| Cursor / Grok | `D:\黑客松\KnowGap-backend` | 同一个 `feat/backend` | `backend/tests/test_acceptance_*`、`demo/`、`docs/evaluation/` |
| Claude | `D:\黑客松\KnowGap` | 用户已让 Claude 创建的前端分支；沿用当前分支 | `frontend/` |

`KnowGap-evaluation` 暂时闲置，不需要在里面开发。不要删除用户目录或切换他人的分支。

共享目录不得自行 checkout/switch/reset/clean/stash。提交前逐个指定本人负责的文件，禁止 `git add .`。
GPT 的核心回归在 `backend/checks/test_backend_core.py`，Cursor 另建验收文件，避免同时编辑。
接口变更先同步本文件旁的 `api.md`，再更新前端与验收测试。

## Claude 的任务（可直接复制）

你负责 KnowGap 前端，只修改 `D:\黑客松\KnowGap\frontend`，沿用你当前分支。
GPT 后端的最新契约在 `D:\黑客松\KnowGap-backend\docs\api.md`，请读取该绝对路径，
不要依赖你的目录里尚未更新的旧接口文档。后端启动后用 `/openapi.json` 核对字段。

实现同一页面内的选题、答案与理由输入、诊断结果、逐轮教学对话、记忆摘要和证据、删除记忆、
新会话参考历史的展示。用 `GET /api/problems` 返回的题目，不硬编码答案。
首次与后续均使用 `TeachingResponse`；保存 `session_id` 后可通过会话读取接口恢复。
加载时防止重复提交；错误保留输入；422 的 detail 是数组，其余业务错误通常是字符串。
confidence 不是准确率，不能显示成学生掌握率。`used_memory_ids` 表示上下文送入了哪些记忆，
不能仅凭该字段宣称真实教学已改善。
缺少真实模型时展示明确配置错误；开发用模拟数据须标注，不能作为真实联调成功证据。
不要改后端或把密钥放进浏览器。完成后执行构建与类型检查，记录实际结果。

## Cursor 的任务（可直接复制）

你与 GPT 共用 `D:\黑客松\KnowGap-backend` 的 `feat/backend`，只修改上述分配范围。
先读实际代码、`docs/api.md` 和 `backend/README.md`。
内置题目在 `backend/app/services/problems.py`，请独立推演参考解、为每题准备正确/错误/证据不足回答，
将人工评估材料放入 `demo/`，不要直接修改 GPT 的题目服务。

为诊断不过度判错、至少三轮引导、SQLite 重启持久化、跨会话检索、记忆纠错、删除、
输入和模型异常、存储失败建立独立验收测试与复现说明。
自动化测试使用临时数据库和注入 Tutor/HTTP MockTransport，不访问开发数据库，不自动调用收费模型。
`create_app(settings, tutor)` 可注入测试替身；替身须返回 `TutorOutput`，evidence 须逐字来自当前回答。
真实模型评估另行运行，覆盖循环追问、错误诊断、诱导指令、错误记忆固化；未配置模型则明确标记待验证。
程序测试的通过不能证明模型教学质量通过。报告写入 `docs/evaluation/`，包含实际执行命令和缺陷复现。

## 合并与联调

1. GPT 完成契约和后端实现，运行核心回归；Cursor 在同一目录独立验收。
2. Claude 读取跨目录契约连接本机 `8000` 端口；前端运行在 `3000`。
3. 配置真实模型后，做错误答案 → 三轮引导 → 新题历史检索 → 后续修正记忆的人工演示。
4. 三方按归属分别提交，最终集成前审看 diff，避免顺带提交 `.env`、数据库、虚拟环境。
5. 真实模型评估与完整浏览器闭环未执行前，不宣称 MVP 已通过全部验收。
