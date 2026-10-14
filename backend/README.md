# KnowGap 后端

本地演示范围：三道栈题、结构化诊断、多轮引导、SQLite 会话及可修正记忆。
当前只接受 `demo-student-001`。不提供真实多用户认证，默认仅本机访问。

## Windows PowerShell 启动

在本仓库根目录执行：

```powershell
python -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements-dev.txt
Copy-Item .env.example backend/.env
```

编辑 `backend/.env`，填写 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`。
已有 `.env` 时不要覆盖；API Key 不要发到聊天、提交或日志中。

```powershell
Set-Location backend
.venv/Scripts/python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- API 文档：<http://127.0.0.1:8000/docs>
- 机器契约：<http://127.0.0.1:8000/openapi.json>
- 人类可读契约：`docs/api.md`
- 缺模型配置时 `/health`、题目、记忆查询仍能使用；诊断返回 503。

配置加载顺序：仓库 `.env`、`backend/.env`、进程环境变量；后者覆盖前者。
兼容旧的 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 变量名，优先用 `LLM_*`。
`LLM_BASE_URL` 应包含提供商要求的版本前缀，不含 `/chat/completions`；没有默认提供商。
必须支持 Chat Completions JSON object 输出；暂不支持 Responses、原生 Claude/Gemini 等其他协议。
默认超时 45 秒，不自动重试收费调用。

数据库默认 `backend/data/knowgap.sqlite3`，相对 `DATABASE_PATH` 均以 `backend/` 为基准。
忽略旧 PostgreSQL `DATABASE_URL`；本版本没有接入 PostgreSQL。
SQLite、会话与 `.env` 不提交 Git。

## 测试

在 `backend/` 执行：

```powershell
.venv/Scripts/python.exe -m pytest checks tests -q
.venv/Scripts/python.exe checks/smoke_http.py
```

`checks/test_backend_core.py` 是 GPT 的后端回归检查；`tests/test_acceptance_*` 留给 Cursor。
检查使用临时数据库、注入模型或 HTTP 测试传输，不调用真实模型。
它们能验证程序协议与状态治理，不能证明真实模型的诊断正确、三轮提示质量或抗诱导能力。
真实模型评估由 Cursor 单独执行并记录，配置模型后再做。
