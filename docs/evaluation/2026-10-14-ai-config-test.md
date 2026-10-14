# AI 配置后端测试 — 2026-10-14

测试基线：`feat/ai-config-backend` 的 `de41653cebd83b59024909ed99a6bee934ad4ba1`。
测试时 GitHub PR #3 仍为 open、merged=false；`frontend` 为 `d1785a2`，`main` 为 `0e75349`。
远程尚无 AI 配置卡片代码，因此不声称已完成卡片浏览器联调。
113 个文本文件已按远程 Git blob SHA 核对；测试在隔离副本和临时数据库进行。

## 结果

| 检查 | 结果 |
| --- | --- |
| 后端原有回归 | 81 passed |
| 修复后的后端回归 | 88 passed，1 条现有 Starlette/httpx 弃用警告 |
| 前端 HTTP 适配器 | 10 passed |
| ESLint | 通过 |
| TypeScript `tsc --noEmit` | 通过 |
| Next.js 生产构建 | 通过 |
| 实际 Uvicorn HTTP smoke | 通过：9 个路径、健康、题目、配置、未配置模型 503 |
| 前端适配器到后端的实际 HTTP 链路 | 通过 |

完整 HTTP 测试使用真实前端适配器、真实 Uvicorn、独立的本机模拟 Chat Completions 服务及 SQLite。
覆盖模型权限/格式错误、未保存配置的连接测试、保存配置后立即教学、四轮会话、
记忆从 suspected 到 needs_review 再到 improving、证据数量、相关记忆读取、
后端进程重启后会话与配置恢复、记忆删除后不再检索。
模拟服务返回人工编写结果，不能用于判断真实模型的准确率和教学质量。

## 发现及修复

1. 配置接口收到数组或损坏的 JSON 时，FastAPI 默认 422 详情回显输入，可能包含 API Key。
   对两个 AI 路径增加专用验证错误脱敏；其他教学路径继续保留原有验证详情。
2. 中文等非 ASCII 密钥可保存，但构造 Bearer HTTP 头时触发 UnicodeEncodeError，导致 500。
   保存前拒绝这类密钥；对 `.env` 等来源的非法密钥返回可读 503。
3. 系统配置 SOCKS 代理但未安装 socksio 时，创建 httpx 客户端触发 ImportError，导致 500。
   requirements 改为 `httpx[socks]`，并为未安装依赖的环境返回可读 503。

## 复现

```bash
cd frontend
npm ci
npm run test:api
npm run lint
npx tsc --noEmit
npm run build
cd ../backend
python -m pip install -r requirements-dev.txt
python -m pytest checks tests -q
python checks/smoke_http.py
python checks/integration_http.py
```

`integration_http.py` 自动启动临时后端和本机模拟模型服务，运行 `frontend/tests/integration-http.cjs`，
重启后端再次核对持久化，结束后停止服务并删除临时数据库。
该测试不使用实际模型密钥；清除测试子进程的代理环境变量，避免本机流量误经外部代理。

未验证：用户 Windows 工作目录中的未推送代码、AI 卡片浏览器交互、真实供应商连接、
真实模型多轮教学质量及线上部署。
