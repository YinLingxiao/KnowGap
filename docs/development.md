# 本地开发与构建

[← 返回 README](../README.md)


需要 Python 3.10+（桌面打包清单写的是 3.12+）和能跑 Next.js 15 的 Node.js。下面是仓库根目录的 PowerShell。

## 后端

```powershell
python -m venv backend/.venv
backend\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
if (-not (Test-Path backend/.env)) { Copy-Item .env.example backend/.env }
```

`backend/.env` 里可以写一个起步模型，也可以等界面里的「设置 → 模型接入」添加服务商。服务商保存地址、认证方式和密钥；模型挂在服务商下面，各自有启用开关和能力标签。新对话用默认模型，输入框里更换只影响当前这条对话，支线在自己没选模型时沿用主线。逻辑、视觉、后台与记忆从模型库里选，不再各自填写地址和密钥。

配置写在数据目录的 `model-library.json`，含密钥，不进 Git，接口也不回传密钥。第一次启动若还没有这个文件、但已有 `ai-settings.json` 或环境变量里的有效配置，会自动生成一个服务商和一个默认模型；旧的 `ai-settings.json` 不删不改。`/api/ai/config` 仍可用，读写作用在默认模型所属的服务商上。契约见 [contracts/model-library.md](contracts/model-library.md)。密钥不要写成 `NEXT_PUBLIC_*`。

```dotenv
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model-name
LLM_TIMEOUT_SECONDS=45
```

```powershell
Set-Location backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## 前端

```powershell
Set-Location frontend
npm install
```

`frontend/.env.local`：

```dotenv
NEXT_PUBLIC_DATA_SOURCE=api
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000
```

```powershell
npm run dev -- --hostname 127.0.0.1
```

- 应用：<http://127.0.0.1:3000>
- 健康检查：<http://127.0.0.1:8000/health>
- API 文档：<http://127.0.0.1:8000/docs>

改前端环境变量后要重启开发服务器。浏览器开发模式的数据库默认是 `backend/data/knowgap.sqlite3`。

## 演示数据

```powershell
backend\.venv\Scripts\python.exe backend\scripts\seed_demo.py
backend\.venv\Scripts\python.exe backend\scripts\seed_demo.py --reset
```

`--reset` 只删除该脚本写入的演示空间、相关对话、误区和日程，以及带「（演示档案）」的画像条目。

## 桌面打包

在仓库根目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1
```

脚本会做静态前端、PyInstaller 后端和 electron-builder 安装包，输出在 `desktop/dist/`。打包前看 `git status`，避免把别人未提交的改动打进去。逐项清单见 [desktop-release-checklist.md](desktop-release-checklist.md)。

仓库：<https://github.com/YinLingxiao/KnowGap>

更早的设计说明和接口约定在 `docs/`。那些文档里有当时的计划和后来改过的行为，和本文冲突时以当前代码为准。
