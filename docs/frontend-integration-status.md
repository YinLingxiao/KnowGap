# 前后端联调状态（2026-10-14）

前端目录：`D:\黑客松\KnowGap\frontend`，分支 `frontend`。
后端目录：`D:\黑客松\KnowGap-backend\backend`，分支 `feat/backend`。

## 已完成

- 替换前端 API 占位实现，对接全部现有接口，保持 Claude 的页面设计。
- 映射题目、诊断、会话、消息、记忆证据和记忆变化。
- 后续轮次更新诊断与检索记忆；不把“使用了记忆”宣传成教学效果已改善。
- API 模式刷新时读取后端会话；追问超时重试前检查服务器轮次。
- 处理 409/422/502/503/504，响应体读取也受超时限制。
- 防止提交期间切题、新会话和连续点击造成页面状态错配。
- 当前前端 `.env.local` 已切为 API 模式，地址 `http://127.0.0.1:8000`。此文件被忽略，不包含模型密钥。

## 验证证据

- 前端客户端契约检查：10 项通过（模拟 HTTP 响应）。
- TypeScript、ESLint、生产构建：通过。
- 浏览器连接本地真实 FastAPI：加载三道题、显示在线；提交到 `/api/diagnosis`，模型未配置时显示明确错误并保留输入。
- 后端上一轮合并检查：67 项通过；使用测试导师，没有真实模型效果证据。

## 剩余验证

用户稍后在后端 `.env` 填入 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`，重启后端。届时验证真实模型：首次诊断、连续追问、记忆写入、刷新恢复、换题检索及错误结论拦截。

前端会话恢复和成功响应映射有客户端测试，真实模型成功流程的浏览器验证尚未进行。首次诊断没有请求幂等键；保存后丢失响应时重试可能产生新会话。栈题标准答案保护只覆盖能明确识别的首次结论，不是通用防诱导保证。

## 协作交接

Claude 的前端和这次联调修改仍在 `frontend` 工作区中，未替 Claude 提交，也未合并或推送。Cursor 的验收文件保留在后端工作区中，不包含在 GPT 的后端提交里。

联调修改主要位于 `frontend/src/lib/api/http-client.ts`、`src/lib/types.ts`、`src/lib/config.ts`、`src/lib/api/errors.ts`、`src/hooks/useWorkbench.ts`、`src/components/{Workbench,ProblemPanel,DiagnosisCard,UsedMemories,ErrorNotice}.tsx`，以及客户端测试、检查配置和 README。
