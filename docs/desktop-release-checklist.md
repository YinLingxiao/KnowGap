# KnowGap 桌面端发布验证清单

> 适用：路演前最后一轮验收。按顺序执行，**全部通过才可发布**。
> 基线：本地 `main` 的 `2e659cd`；桌面端改动在 `desktop/`、`scripts/build-desktop.ps1`、`backend/desktop_entry.py`。
> 最近一次执行：2026-10-21（Windows 11，Node 24.14.1，Python 3.14.3，Electron 33.2.1）。

---

## 0. 前置条件

- Windows 10/11 x64；Node.js ≥ 20；Python 3.12+（需能创建 venv）。
- 关闭所有正在运行的 `KnowGap.exe` / `knowgap.exe`：
  ```powershell
  Get-Process KnowGap,knowgap -ErrorAction SilentlyContinue | Stop-Process -Force
  ```
- 备份现场演示数据（安装包升级不会删数据，但验证会写入对话）：
  ```powershell
  Copy-Item "$env:APPDATA\knowgap-desktop" "$env:APPDATA\knowgap-desktop.bak" -Recurse -Force
  ```
- 端口 `38617` 是应用的首选端口。若被其他开发服务占用，应用会自动换端口，**页面 origin 变化会暂时丢失登录态**（见 4.15）。验证前先确认：
  ```powershell
  netstat -ano | Select-String ":38617"
  ```

---

## 1. 打包

> 并行开发时，工作区里其他会话的未提交改动会被 `next build` 一起打进安装包。
> 打包前先看 `git status --short`，推荐在 `git worktree add` 出来的干净检出里执行本脚本。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1
```

脚本依次执行：清理旧产物 → `next build`（静态导出）→ PyInstaller → electron-builder（NSIS）。
任一步失败会立刻抛错并停止，不会被旧产物覆盖成"看起来成功"。

**预期产物**

| 产物 | 路径 |
| --- | --- |
| NSIS 安装包 | `desktop/dist/KnowGap Setup 0.2.0.exe` |
| 免安装目录 | `desktop/dist/win-unpacked/KnowGap.exe` |
| 前端静态导出 | `frontend/out/`（必须包含 `index.html`、`quick.html`、`404.html`） |
| 后端单文件目录 | `backend/dist/knowgap/knowgap.exe` + `_internal/` |

**脚本内置断言（缺一即失败）**

- [ ] `frontend/out/quick.html` 存在（Next 静态导出把 `/quick` 导出为 `quick.html`，不是 `quick/index.html`）
- [ ] `backend/dist/knowgap/knowgap.exe` 存在
- [ ] `desktop/dist/win-unpacked/resources/frontend/index.html` 与 `quick.html` 存在
- [ ] `desktop/dist/win-unpacked/resources/backend/knowgap.exe` 存在
- [ ] 安装包 > 50 MB 且已生成 `.blockmap`

> 注意：`.env.local` 里的 `NEXT_PUBLIC_API_BASE_URL` 不会进入安装包——脚本用进程环境变量覆盖为 `"/"`（同源相对路径），保证页面始终请求当前后端端口。构建日志会显示 `Environments: .env.local`，属正常。

---

## 2. 安装包验证

1. 双击 `desktop/dist/KnowGap Setup 0.2.0.exe`（per-user 安装，无需管理员）。
2. 预期：安装完成后自动启动；开始菜单/桌面出现 **KnowGap** 快捷方式。
3. 默认安装目录：`%LOCALAPPDATA%\Programs\knowgap-desktop\`（以实际为准）。
4. 卸载：设置 → 应用 → KnowGap → 卸载；或安装目录下 `Uninstall KnowGap.exe /S`。
   - 预期：卸载不删除 `%APPDATA%\knowgap-desktop`（学习数据保留）。

- [ ] 安装、启动、卸载均成功，无 SmartScreen「未知发布者」以外的报错
- [ ] 卸载后无 `KnowGap.exe` 残留进程

> 安装包未签名，若从网络下载会出现 SmartScreen 提示；现场用本地构建产物（无 Mark-of-the-Web）通常不触发。

---

## 3. 启动方式（便于看日志）

从终端启动免安装版，可直接看到 Electron 主进程日志（快捷键注册结果等）：

```powershell
& "desktop\dist\win-unpacked\KnowGap.exe"
```

新开一个 PowerShell 窗口执行后续检查。端口与数据目录：

```powershell
$port = (Get-Content "$env:APPDATA\knowgap-desktop\port.json" | ConvertFrom-Json).port
$port
```

数据目录固定在 Electron `userData`：**`%APPDATA%\knowgap-desktop`**
（目录名来自 `package.json` 的 `name`，不是 productName `KnowGap`）

```
knowgap.sqlite3     学习数据（对话、空间、记忆）
ai-settings.json    模型配置（含 API Key，勿外传）
.env                本机 SMTP 配置（可选）
port.json           上次使用的端口（用于重启复用）
logs/backend.log    后端日志（启动信息、请求、异常）
```

---

## 4. 运行验证

| # | 验证项 | 操作 | 通过标准 | 结果 |
| --- | --- | --- | --- | --- |
| 4.1 | 后端子进程 | 启动应用后执行 `Get-CimInstance Win32_Process -Filter "Name='knowgap.exe'" \| Select ProcessId,CommandLine` | 有且仅有 1 个 `resources\backend\knowgap.exe`，命令行含 `--port <port.json 端口>` | ☐ |
| 4.2 | 健康检查 | `Invoke-RestMethod "http://127.0.0.1:$port/health"` | 返回 `{"status":"ok"}`，HTTP 200 | ☐ |
| 4.3 | 窗口加载静态前端 | 观察主窗口 | 显示登录页（未登录）或上次界面；标题 `知隙 KnowGap`；DevTools 无红色报错、无 404 资源 | ☐ |
| 4.4 | 登录（本机演示身份） | 登录页点「使用本机演示身份直接进入 →」 | 进入主界面，左下角显示「演示学习者 · 本地版」 | ☐ |
| 4.5 | 聊天发消息 | 首页输入「用一句话解释一下什么是栈。」并发送 | 用户消息上屏，模型流式回复完成；侧栏「最近对话」出现该对话 | ☐ |
| 4.6 | 未配置模型提示 | 关闭应用，把 `ai-settings.json` 改名，重启后发消息 | 回复区出现「没有拿到回复 / 模型未配置，请在『设置 → 模型接入』填写 API 地址、模型名称和 API Key。」；首页输入框下方有「未配置模型」入口 | ☐ |
| 4.7 | 设置 → 模型配置保存 | 设置（左下齿轮）→ 模型接入，修改「模型」后点「保存」 | 出现「已保存，立即生效」；`PUT /api/ai/config 200`；`ai-settings.json` 内容更新；留空 API Key 时旧密钥保留 | ☐ |
| 4.8 | 学习空间入口 | 侧栏「学习空间」→「新建学习空间」，填名称创建 | 空间页打开，显示「考前一页纸 / 概览 / 设置」工具栏与 Thread 侧栏 | ☐ |
| 4.9 | 考前一页纸入口 | 空间页右上「考前一页纸」 | 全屏覆盖层打开，显示四宫格（易错红榜/Thread 结论/公式边界/易混概念），生成中状态可见；可关闭 | ☐ |
| 4.10 | 划词工具条 | 在 AI 回复正文中按住鼠标拖选一段文字 | 选区上方出现工具条：追问这句 / 举个通俗例子 / 摘录到空间笔记（非空间对话时第三项置灰） | ☐ |
| 4.11 | Spotlight（Alt+Space） | 按 `Alt+Space` | 顶部居中弹出透明浮窗「问点什么，回车发送」，底部提示 `Alt+Space 呼出`；再按一次或 Esc 收起 | ☐ |
| 4.12 | Spotlight 回退（Ctrl+Shift+K） | 若 4.11 无反应：先看主进程日志是否输出「快捷键 Alt+Space 注册失败」，再按 `Ctrl+Shift+K` | 浮窗同样弹出；应用启动日志显示实际注册成功的快捷键 | ☐ |
| 4.13 | /quick 静态路由 | 浏览器访问 `http://127.0.0.1:$port/quick.html` 和 `http://127.0.0.1:$port/quick` | 两者均 200 并渲染快问页面（后端会把无扩展名路由回退到 `quick.html`） | ☐ |
| 4.14 | 「在主窗口打开」跳转 | 浮窗提问并等回复完成，点「在主窗口打开」 | 浮窗隐藏；主窗口切到该对话，消息与浮窗一致；侧栏高亮该对话 | ☐ |
| 4.15 | 重启端口复用 | 关闭主窗口 → 重新启动应用；对比两次 `port.json` 与地址栏 origin | 端口不变（首次因 38617 被占用换端口后，之后复用上次端口）；登录态保留，无需重新登录 | ☐ |
| 4.16 | 打开的对话保留 | 重启后观察主区域 | 自动回到上次打开的对话；学习空间、最近对话数量、消息内容均仍在 | ☐ |
| 4.17 | 关闭后进程全退 | 关闭主窗口，等待 3 秒后执行 `Get-Process KnowGap,knowgap` | 无 `KnowGap.exe`、无 `resources\backend\knowgap.exe` 残留；端口不再 LISTENING | ☐ |
| 4.18 | 数据目录持久化 | 重启后检查 `%APPDATA%\knowgap-desktop` | `knowgap.sqlite3`、`ai-settings.json`、`port.json`、`logs\backend.log` 均在；新对话/空间重启后仍在 | ☐ |
| 4.19 | 重复启动保护 | 应用运行时再次双击 `KnowGap.exe` | 不出现第二个窗口/第二个后端；已有窗口被唤到前台 | ☐ |

### 4.6 的恢复步骤

```powershell
Rename-Item "$env:APPDATA\knowgap-desktop\ai-settings.json" "ai-settings.json.bak"
# 完成验证后恢复
Rename-Item "$env:APPDATA\knowgap-desktop\ai-settings.json.bak" "ai-settings.json"
```

### 4.11 手动验证说明

真实全局快捷键无法在自动化环境中可靠模拟，必须在**桌面会话**里亲手按键。
若 `Alt+Space` 被 PowerToys Run、输入法等占用，应用会输出注册失败日志并自动改注册 `Ctrl+Shift+K`；两个都失败时浮窗不可用，需要先释放快捷键再重启应用。

---

## 5. 失败时收集这些信息

```powershell
# 端口 / 进程
Get-Content "$env:APPDATA\knowgap-desktop\port.json"
Get-CimInstance Win32_Process -Filter "Name='knowgap.exe' or Name='KnowGap.exe'" |
  Select-Object ProcessId,ParentProcessId,CommandLine | Format-List

# 后端日志（最后 60 行）
Get-Content "$env:APPDATA\knowgap-desktop\logs\backend.log" -Tail 60

# 安装包内容抽查
Get-ChildItem "desktop\dist\win-unpacked\resources\frontend" -Filter *.html
Get-ChildItem "desktop\dist\win-unpacked\resources\backend"
```

常见问题：

| 现象 | 处理 |
| --- | --- |
| 启动弹「后端没有在 30 秒内启动」 | 看 `logs\backend.log`；多为端口占用、杀软拦截或 `_internal` 缺失。重装或换端口后重启 |
| 白屏 / 404 | 确认包内 `resources\frontend\index.html`、`quick.html` 存在；重新执行打包脚本（会清理旧产物） |
| Spotlight 无反应 | 主进程日志看快捷键注册结果；关闭占用 `Alt+Space` 的软件，或用 `Ctrl+Shift+K` |
| 登录态丢失 | 端口变了（origin 变了）。检查 38617 是否被占；`port.json` 是否可写 |
| 关闭后仍有 knowgap.exe | 确认是从主窗口关闭（不是只在任务管理器结束 Electron）；残留可 `Stop-Process -Name knowgap -Force` |

---

## 6. 已知限制 / 业务侧问题（不阻塞打包，供指挥会话决策）

1. **模型未配置时输入框仍显示上次缓存的模型名**：`Composer` 从 localStorage 读模型标签，与后端 `configured:false` 不同步，容易误导。属 `frontend/src` 业务代码，本次未改。
2. **「未配置模型」入口只在首页可见**：已打开的对话里没有该提示，只能从报错卡片得知。属业务代码。
3. **崩溃后后端可能残留**：正常关闭会 `taskkill /t /f` 清理；若 Electron 主进程被强杀，`knowgap.exe` 可能残留并占用端口，下次启动会换端口（登录态随 origin 变化）。现场遇到时先 `Stop-Process -Name knowgap -Force`。
4. **安装包未签名**：对外分发会触发 SmartScreen；现场用本机构建产物演示。
5. **Alt+Space 是系统级热键**，与 PowerToys Run 等冲突时自动回退 Ctrl+Shift+K，需现场确认实际生效的键。
