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
| NSIS 安装包 | `desktop/dist/KnowGap-Setup-<version>.exe`（v0.5.6 起无空格） |
| 自动更新清单 / 差分映射 | `desktop/dist/latest.yml` / `KnowGap-Setup-<version>.exe.blockmap` |
| 免安装目录 | `desktop/dist/win-unpacked/KnowGap.exe` |
| 前端静态导出 | `frontend/out/`（必须包含 `index.html`、`quick.html`、`404.html`） |
| 后端单文件目录 | `backend/dist/knowgap/knowgap.exe` + `_internal/` |

**脚本内置断言（缺一即失败）**

- [ ] `frontend/out/quick.html` 存在（Next 静态导出把 `/quick` 导出为 `quick.html`，不是 `quick/index.html`）
- [ ] `backend/dist/knowgap/knowgap.exe` 存在
- [ ] `desktop/dist/win-unpacked/resources/frontend/index.html` 与 `quick.html` 存在
- [ ] `desktop/dist/win-unpacked/resources/backend/knowgap.exe` 存在
- [ ] 安装包 > 50 MB 且已生成 `.blockmap`
- [ ] `latest.yml` 的 `version`、`path`、`files[].url` 与版本和无空格文件名完全相同，文件大小及 SHA512 一致（构建脚本自动校验）

> 注意：`.env.local` 里的 `NEXT_PUBLIC_API_BASE_URL` 不会进入安装包——脚本用进程环境变量覆盖为 `"/"`（同源相对路径），保证页面始终请求当前后端端口。构建日志会显示 `Environments: .env.local`，属正常。

---

## 2. 安装包验证

1. 双击 `desktop/dist/KnowGap-Setup-<version>.exe`。0.5.0 起是中文安装向导（`nsis.oneClick: false`），不再一键静默安装：先选「为所有用户 / 仅为我」，再选安装位置。「仅为我」无需管理员。
2. 预期：完成页默认勾选「运行 KnowGap」；开始菜单/桌面出现 **KnowGap** 快捷方式。
3. 安装目录以向导里选的为准。0.2.0 和 0.3.0 是一键安装，装在 `%LOCALAPPDATA%\Programs\knowgap-desktop\`。
4. 卸载：设置 → 应用 → KnowGap → 卸载；或安装目录下 `Uninstall KnowGap.exe /S`。
   - 预期：卸载时弹出「是否同时删除学习数据？」（默认「否」）。选「否」保留 `%APPDATA%\knowgap-desktop`；选「是」删除整个目录。升级安装（直接运行新安装包）不会弹窗，数据保留。

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
| 4.8 | 学习空间入口 | 侧栏「学习空间」→「新建学习空间」，填名称创建 | 空间页打开，显示「考前一页纸 / 概览 / 设置」工具栏与支线侧栏 | ☐ |
| 4.9 | 考前一页纸入口 | 空间页右上「考前一页纸」 | 全屏覆盖层打开，显示四宫格（易错红榜/支线结论/公式边界/易混概念），生成中状态可见；可关闭 | ☐ |
| 4.10 | 划词工具条 | 在 AI 回复正文中按住鼠标拖选一段文字 | 选区上方出现工具条：追问这句 / 举个通俗例子 / 摘录到空间笔记（非空间对话时第三项置灰） | ☐ |
| 4.11 | Spotlight（Alt+Space） | 按 `Alt+Space` | 顶部居中弹出透明浮窗「问点什么，回车发送」，底部提示 `Alt+Space 呼出`；再按一次或 Esc 收起 | ☐ |
| 4.12 | Spotlight 回退（Ctrl+Shift+K） | 若 4.11 无反应：先看主进程日志是否输出「快捷键 Alt+Space 注册失败」，再按 `Ctrl+Shift+K` | 浮窗同样弹出；应用启动日志显示实际注册成功的快捷键 | ☐ |
| 4.13 | /quick 静态路由 | 浏览器访问 `http://127.0.0.1:$port/quick.html` 和 `http://127.0.0.1:$port/quick` | 两者均 200 并渲染快问页面（后端会把无扩展名路由回退到 `quick.html`） | ☐ |
| 4.14 | 「在主窗口打开」跳转 | 浮窗提问并等回复完成，点「在主窗口打开」 | 浮窗隐藏；主窗口切到该对话，消息与浮窗一致；侧栏高亮该对话 | ☐ |
| 4.15 | 重启端口复用 | 托盘「退出」后重新启动应用；对比两次 `port.json` 与地址栏 origin | 端口不变（首次因 38617 被占用换端口后，之后复用上次端口）；登录态保留，无需重新登录 | ☐ |
| 4.16 | 打开的对话保留 | 重启后观察主区域 | 自动回到上次打开的对话；学习空间、最近对话数量、消息内容均仍在 | ☐ |
| 4.17 | 托盘退出后进程全退 | 托盘右键「退出」，等待 3 秒后执行 `Get-Process KnowGap,knowgap -ErrorAction SilentlyContinue` | 无 `KnowGap.exe`、无 `knowgap.exe`；端口不再 LISTENING。点主窗口 × 不会退出（见 4.20） | ☐ |
| 4.18 | 数据目录持久化 | 重启后检查 `%APPDATA%\knowgap-desktop` | `knowgap.sqlite3`、`ai-settings.json`、`port.json`、`logs\backend.log` 均在；新对话/空间重启后仍在 | ☐ |
| 4.19 | 重复启动保护 | 应用运行时再次双击 `KnowGap.exe`（主窗口在托盘里时再测一次） | 不出现第二个窗口/第二个后端；已有主窗口被唤出。第二个进程自行退出 | ☐ |
| 4.20 | 关闭到托盘 | 默认设置下点主窗口 × | 窗口从任务栏消失，`KnowGap.exe` 与 `knowgap.exe` 仍在；托盘图标还在。第一次弹出系统通知「KnowGap 仍在后台运行，{实际快捷键} 随时快问」，`%APPDATA%\knowgap-desktop\desktop-settings.json` 里 `backgroundNotified` 变为 `true`；再隐藏不再弹 | ☐ |
| 4.21 | 托盘单击切换 | 左键单击托盘图标 | 主窗口在显示与隐藏之间切换；隐藏后后端 `/health` 仍为 200 | ☐ |
| 4.22 | 托盘菜单 | 右键托盘图标 | 菜单为：打开 KnowGap、快问（括号内是实际生效的快捷键）、今日待办 N 项、分隔线、关闭时最小化到托盘（默认勾选）、开机自启（勾选项）、退出 | ☐ |
| 4.23 | 今日待办 | 点「今日待办 N 项」 | 主窗口打开并进入日程。N 为今天计划且未完成的任务数 | ☐ |
| 4.24 | 隐藏时快问并能回主窗口 | 主窗口隐藏后按实际快捷键（默认 `Alt+Space`），在浮窗回复完成后点「在主窗口打开」 | 浮窗能弹出；主窗口从托盘被唤出并打开同一对话 | ☐ |
| 4.25 | `--hidden` 启动 | 托盘退出后执行 `npx electron . --hidden`（安装包则 `KnowGap.exe --hidden`） | 只出现托盘，主窗口不显示；`/health` 200；左键托盘图标可以打开主窗口 | ☐ |
| 4.26 | 设置里的两个开关 | 设置 → 通用 | 仅 Electron 里出现「关闭时最小化到托盘」「开机自启」。浏览器里没有这两项。关掉「关闭时最小化到托盘」后点 ×，进程按 4.17 退出 | ☐ |
| 4.27 | 关掉托盘驻留后的关闭 | 设置或托盘菜单取消「关闭时最小化到托盘」，再点主窗口 × | 窗口关闭，快捷键注销，浮窗销毁，`knowgap.exe` 被结束，无残留进程 | ☐ |
| 4.28 | 一体式窗口外壳 | 浅色、深色、跟随系统各测一次；展开和收起侧栏 | 不再出现系统实色标题条或主画布外围圆角框；内容贴到右边和底边，无额外页面滚动；原生窗口按钮与页面同色 | ☐ |
| 4.29 | 原生窗口行为 | 拖动顶部空白、双击顶部、拖到屏幕边缘、悬停最大化按钮、最小化后恢复 | 拖拽、最大化/还原、贴靠、Windows 11 Snap Layouts、缩放正常；× 仍遵循托盘设置；登录页也能拖动 | ☐ |
| 4.30 | 标题栏隔离 | 浏览器打开页面，再呼出 Alt+Space 快问 | 浏览器没有额外标题条；透明快问不增加 36px 空白，也不变成实色背景 | ☐ |
| 4.31 | 启动动效 | 冷启动应用，观察服务加载和页面接管 | 同一个主窗口中标志聚合、名称淡入；状态文字对应实际阶段，无假进度和强制等待；应用载入后品牌层淡出，按钮可点击 | ☐ |
| 4.32 | 启动状态与无障碍 | 浅/深主题、系统减弱动态效果、`--hidden` 启动；启动中关闭到托盘再唤醒 | 上次主题保留；减弱动态效果无位移和循环动画；后台启动不弹窗；启动中关闭后不被重新弹出；唤醒不重播，完成后临时渲染层被释放 | ☐ |

### 4.6 的恢复步骤

```powershell
Rename-Item "$env:APPDATA\knowgap-desktop\ai-settings.json" "ai-settings.json.bak"
# 完成验证后恢复
Rename-Item "$env:APPDATA\knowgap-desktop\ai-settings.json.bak" "ai-settings.json"
```

### 4.11 手动验证说明

真实全局快捷键必须在**桌面会话**里亲手按一次（本次已用 `SendKeys` 发送真实 `Alt+Space` 验证通过）。
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
| 关闭后仍有 knowgap.exe | 默认点 × 会留在托盘，这是预期。要完全退出用托盘「退出」，或先关掉「关闭时最小化到托盘」。残留可 `Stop-Process -Name knowgap,KnowGap -Force` |

---

## 6. 已知限制 / 业务侧问题（不阻塞打包，供指挥会话决策）

1. **模型未配置时输入框仍显示上次缓存的模型名**：`Composer` 从 localStorage 读模型标签，与后端 `configured:false` 不同步，容易误导。属 `frontend/src` 业务代码，本次未改。
2. **「未配置模型」入口只在首页可见**：已打开的对话里没有该提示，只能从报错卡片得知。属业务代码。
3. **崩溃后后端可能残留**：正常关闭会 `taskkill /t /f` 清理；若 Electron 主进程被强杀，`knowgap.exe` 可能残留并占用端口，下次启动会换端口（登录态随 origin 变化）。现场遇到时先 `Stop-Process -Name knowgap -Force`。
4. **安装包未签名**：对外分发会触发 SmartScreen；现场用本机构建产物演示。
5. **Alt+Space 是系统级热键**，与 PowerToys Run 等冲突时自动回退 Ctrl+Shift+K，需现场确认实际生效的键。
6. **后端依赖未锁定**：`backend/requirements.txt` 里 fastapi/uvicorn/pydantic 等未固定版本。全新 venv 会解析到比开发机更新的版本（本轮：fastapi 0.157.0 / starlette 1.9.0，开发机是 0.143.1 / 1.8.0），两套都验证通过，但长期不可复现。`requirements.txt` 不在本次可改范围，建议后续锁定。
7. **卸载会留下空的安装目录**：NSIS 卸载后 `%LOCALAPPDATA%\Programs\knowgap-desktop` 仍存在（0 个文件），快捷方式和注册表项已清除，`%APPDATA%\knowgap-desktop` 数据保留。属 electron-builder/NSIS 默认行为。
8. **打包必须在干净检出里做**：多个会话共用同一工作区时，别人未提交的改动会被 `next build` 打进安装包。本轮最终包是在 `git worktree`（仅 `2e659cd` + 本分支修复）里构建的。
9. **关闭按钮默认不再退出进程**：`closeToTray` 默认开启，点 × 只隐藏窗口。完全退出走托盘「退出」。开发态 `electron.exe` 的「开机自启」会登记到 Electron 可执行文件，路演以安装包为准。
10. **托盘状态依赖新的静态前端**：`DesktopBridge` 和设置页开关在 `frontend/out` 里。只换 `desktop/main.js`、不重新 `next build` 时，托盘菜单仍可用，但悬停不会更新、设置页也没有开关。

---

## 7. 本轮验证记录（2026-10-21）

- 环境：Windows 11 26300，Node 24.14.1，npm 10.9.9，Python 3.14.3；Electron 33.2.1，electron-builder 25.1.8，PyInstaller 6.22.3。
- 代码：`feat/desktop-release`（基于 `2e659cd`），干净 worktree 构建，不含并行会话未提交改动。
- 产物：`desktop/dist/KnowGap Setup 0.2.0.exe`，119,519,317 字节（114.0 MB），SHA256 `AD7B3B838B2A281E307D6DE1DBF970C6E8D9123C3F51A162BBCD449BAF2E0146`。

| # | 结果 | 说明 |
| --- | --- | --- |
| 4.1 | 通过 | 1 个 `resources\backend\knowgap.exe`，父进程为 `KnowGap.exe`，`--port 62533` |
| 4.2 | 通过 | `/health` → `{"status":"ok"}` |
| 4.3 | 通过 | 登录页正常渲染；静态资源 200；无白屏 |
| 4.4 | 通过 | 「使用本机演示身份直接进入」→ 主界面 |
| 4.5 | 通过 | 真实 DeepSeek 流式回复；侧栏出现对话；token 统计正常 |
| 4.6 | 通过 | 临时移走 `ai-settings.json` 后发送，显示「模型未配置，请在『设置 → 模型接入』填写 API 地址、模型名称和 API Key。」；首页有「未配置模型」入口 |
| 4.7 | 通过 | 改模型名 → 保存 → 「已保存，立即生效」；`PUT /api/ai/config 200`；`ai-settings.json` 更新；留空 Key 时密钥保留 |
| 4.8 | 通过 | 新建「数据结构」空间，空间页与支线侧栏正常 |
| 4.9 | 通过 | 考前一页纸覆盖层打开，四宫格生成，可关闭 |
| 4.10 | 通过 | 选中 AI 回复后出现「追问这句 / 举个通俗例子 / 摘录到空间笔记」工具条 |
| 4.11 | 通过 | `SendKeys` 发送真实 `Alt+Space`，透明浮窗出现，`quick.html` 正常渲染 |
| 4.12 | 通过 | 先用 `RegisterHotKey` 占用 Alt+Space，应用日志输出「快捷键 Alt+Space 注册失败…尝试下一个」并注册 Ctrl+Shift+K；真实按下 Ctrl+Shift+K 后浮窗出现 |
| 4.13 | 通过 | `/quick.html` 与 `/quick` 均 200（`ExportStaticFiles` 回退） |
| 4.14 | 通过 | 浮窗提问 → 回复 → 「在主窗口打开」→ 主窗口切到同一对话 |
| 4.15 | 通过 | 重启后端口仍为 62533（`port.json` 复用），无需重新登录 |
| 4.16 | 通过 | 重启后自动打开上次对话；空间/最近对话仍在 |
| 4.17 | 通过 | 关闭主窗口后无 `KnowGap.exe` / `knowgap.exe` 残留，端口释放 |
| 4.18 | 通过 | 数据在 `%APPDATA%\knowgap-desktop`，重启后 `sqlite3`/`ai-settings.json`/`port.json`/`logs` 均在 |
| 4.19 | 通过 | 二次启动进程立即退出，仅保留一个后端 |

安装包：静默安装 exit 0 → 开始菜单与桌面快捷方式生成 → 安装版启动、`/health` 与 `/quick` 均 200 → 卸载 exit 0，快捷方式/注册表清除，`%APPDATA%` 数据保留（安装目录留空，见限制 7）。

## 0.3.0 新增验证项

- [ ] 全新安装、未配置模型时首次打开：欢迎页先显示「先连上 AI 模型（约 1 分钟）」，「去填写」打开设置的模型页；保存并测试通过后自动切回「你最近在学什么？」。
- [ ] 在打包版中上传 .docx / .pptx / .xlsx 各一份：附件卡片显示规模（节 / 张幻灯片 / 个工作表），发送「精读重点」后 AI 按页引用回答（确认 python-docx / python-pptx / openpyxl 已被 PyInstaller 打进后端）。
- [ ] 开发者模式默认关闭：输入框「+」菜单中没有「目标与工作区」「帮我批准」。

## 自动更新（v0.5.7 起）

### 安全策略与边界

- **v0.5.7 是首个带更新功能的版本，必须先手动安装。** v0.5.5 没有更新器，不会自己升级。真实 GitHub 升级链路必须等下一个更高正式版本发布后验证。
- 只在已打包的 Windows 应用中启用。默认启动约 20 秒后检查，之后每 4 小时检查；自动检查、自动下载默认开；**退出时自动安装默认关**。下载完成只显示侧栏小圆点和设置中的说明，不弹窗、不自动重启。
- 关闭自动下载后，发现版本会显示「下载更新」；关闭自动检查不妨碍手动检查。已在进行的下载不会因为关开关而中断。
- 手动安装总是先原生确认（含「会中断正在生成的回复」），然后 `quitting=true` → 等待 `stopBackend()` 结束进程树 → 销毁快问、托盘 → `quitAndInstall`。从托盘恢复也走同一路径。
- 「退出时自动安装」由本应用的 `before-quit` 拦截执行同样的清理顺序，不开启 electron-updater 自带的退出安装钩子，避免与后端退出竞争；显式勾选后真正退出才安装，安装后不重新打开。关窗口留托盘不算退出。
- 后台网络错误、限流和没有新版本静默；手动检查给中文反馈。只接受正式版本，不降级；保留 SHA512 完整性校验。差分不可用时 electron-updater 回退到全量下载，同样校验。
- 未签名安装包可能显示 SmartScreen「未知发布者」；为所有用户安装可能需要 UAC。**不要为消除提示禁用哈希或其他校验**。UAC 的真实交互仍须人工验收，取消提升权限时可能需要手动重启当前版本。

### 更新源与路演开关

「设置 → 通用 → 软件更新」的更新地址留空表示 GitHub Releases；自定义应指向同时存放 `latest.yml`、安装包、`.blockmap` 的 HTTPS **目录**，不能填某个 exe 或 latest.yml 文件。拒绝用户名密码、查询参数、片段及非本机 HTTP；仅允许 `http://127.0.0.1:<port>/` 用于本机测试。更换更新源应在空闲且尚未下载时操作；已下载需先退出重开。服务器目录应保留旧版 blockmap，支持 Range 请求以便差分下载；不支持时可回退全量。

- 桌面设置写入 `%APPDATA%\knowgap-desktop\desktop-settings.json`：`autoCheckUpdates`、`autoDownloadUpdates`、`autoInstallOnQuit`、`updateUrl`。不改变已有托盘、主题、开机自启设置。
- `KNOWGAP_UPDATE_URL` 优先于设置；无效值直接阻止检查，不偷偷回退 GitHub。变量由启动进程继承，修改后要彻底退出（不是关到托盘）再启动。界面显示环境变量覆盖，不显示可能敏感的原值。
- 路演机需要完全冻结更新时：从带有 `$env:KNOWGAP_DISABLE_UPDATE = "1"` 的 PowerShell 启动安装版 KnowGap。该变量关闭检查、下载、安装，界面明确显示已关闭；不持久改写系统环境。若原实例还在托盘，先真正退出，否则单实例机制仍会唤醒旧实例。
- 自定义源拥有执行安装包的能力，只使用负责人管理的可信 HTTPS 服务器；不要把密钥或鉴权凭据写进更新地址、日志或发布说明。

### 发布：只由负责人执行

1. 协调独占构建，备份数据，确认其他 Agent 改动已经验收。更新 `desktop/package.json` 和 lock 的正式版本；构建命令固定 `--publish never`，即使有 GitHub 凭据也不会自动上传。
2. 执行 `scripts/build-desktop.ps1`。脚本校验 `latest.yml`、安装包和有效 gzip `.blockmap`，以及清单版本、文件名、字节数和 SHA512。不得重命名文件：GitHub 会把空格改成点，新文件名 `KnowGap-Setup-0.5.6.exe` 无空格，不受此影响。
3. 负责人按自己的提交/标签流程准备并推送对应标签（如 `v0.5.6`）。发布脚本**不构建、不推送、不创建标签**，`--verify-tag` 要求远端标签已存在。说明文件由负责人准备，不能含密钥。
4. 先只校验，再确认上传（相对说明文件路径以当前工作目录为准）：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-release.ps1 -Tag v0.5.6 -NotesFile .\release-notes.md -CheckOnly
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-release.ps1 -Tag v0.5.6 -NotesFile .\release-notes.md
   ```
   脚本要求输入完整标签确认，再次校验后才 `gh release create`，上传且仅上传清单、exe、blockmap。**标准 latest.yml 提供 SHA512，不提供 SHA256**：脚本按其 SHA512 校验，同时计算并打印 SHA256；可用 `-ExpectedSha256 <人工记录的值>` 再核对，清单若额外有 sha256 也必须一致。不要拿 SHA256 与 SHA512 比较或手填替换标准校验值。
5. 在 GitHub 上检查三个资源：`latest.yml`、`KnowGap-Setup-<version>.exe`、同名 `.exe.blockmap`。清单的 `path` 和 `files[].url` 必须与 exe 资源名逐字一致，版本必须正式、非 prerelease。上传中断时检查并撤回不完整 Release，不得留下只含清单或缺安装包的可用发布。镜像服务器先上传 exe/blockmap，最后原子替换 latest.yml。

### 必做：本机 generic 安装级验收（本轮尚未执行）

> 2026-10-23：负责人要求「先实现，暂不打包」。以下是待执行清单，**不是通过记录**。不要用虚构版本的清单搭配真实旧版安装包冒充成功；要构建实际具有更高版本号的临时测试安装包。

1. 独占构建后，在临时构建目录制作两个真实 NSIS 包（基线 0.5.6、临时更高正式版本）。只改临时副本的版本，不提交、不 tag、不上传 GitHub。使用隔离 Windows 测试账户/沙盒，使 `%APPDATA%`、安装记录、自启项、快捷方式全部与路演机数据隔离；**只改变 userData 路径不足以隔离安装器、快捷方式和注册表**。
2. 先安装基线，选择非默认安装目录，记录目录、桌面快捷方式目标和自启项。用合成数据创建对话、学习空间、模型配置，核对保存内容（含密钥的文件只在本机比较哈希，不打印、不上传），开启开机自启。记录数据文件哈希/记录数和端口。
3. 临时更高版本目录放原样的 `latest.yml` / exe / blockmap；本机服务只绑定回环：
   ```powershell
   python -m http.server 8123 --bind 127.0.0.1 --directory <临时更新产物目录>
   # 新终端，关闭原实例后启动基线安装版
   $env:KNOWGAP_UPDATE_URL = "http://127.0.0.1:8123/"
   & "<隔离测试安装目录>\KnowGap.exe"
   ```
4. 设置手动检查 → available/downloading（速度、大小、百分比）→ downloaded。核对侧栏小圆点悬停提示；下载完成不弹窗。等候/关到托盘/真正退出（默认自动安装关）均不安装；重开仍可发现缓存更新。
5. 后台/手动各测：断网、服务 404、故意破坏 exe（SHA512 必须阻止下载完成/安装）；完成后恢复原产物。自动检查关仍可手查；自动下载关显示「下载更新」。`KNOWGAP_DISABLE_UPDATE=1` 应完全阻止更新。
6. 在主窗口/快问生成回复时点安装，必须出现中断确认，取消不结束后端；确认后观察后端进程树退出，托盘与快问消失，再运行安装器。安装后新版本自动启动，`/health` 200、能打开原对话/空间并继续回复。
7. 验证升级沿用原安装目录、快捷方式、学习数据（含模型配置和密钥）、开机自启、固定端口及登录状态；升级不出现「是否删除学习数据」。再分别验收仅为当前用户 / 为所有用户（管理员测试账户 + UAC 允许和取消）。显式开启退出时安装后单独验证退出安装不重新打开应用。
8. 终止本机服务，退出临时测试安装版；恢复测试环境变量/自启项；仅卸载隔离账户中的临时安装，删除本轮创建的假版本、测试清单、缓存和临时构建/服务器目录。不得删除路演数据或他人的 dist。最终正式包重新构建并校验版本，禁止把临时更高版本作为 Release。

### 回退与止损

- 未发布：停止上传；保留当前安装版。构建/校验失败不得用旧 dist 冒充新包。
- 已发布但未安装：负责人将有问题的 Release 撤为草稿/预发布，或撤下 generic 的最新清单并恢复已验证清单；同时通知已下载的用户先不要点安装，彻底退出再用 `KNOWGAP_DISABLE_UPDATE=1` 重启。撤回远端清单不会自动清掉运行中进程里已下载的更新。
- 已安装：**不允许自动降级**。首选把修复/已验证的旧代码以更高版本号重新构建、完整验收后发布；紧急手动回装旧安装包前先备份整个数据目录，确认数据库向后兼容，不能通过关闭 SHA512 或开启 allowDowngrade 止损。卸载选择保留学习数据。
- 如 UAC 取消或安装器失败后没自动恢复：重新启动原安装目录里的 KnowGap.exe，确认 `/health`；不要连续点击安装，也不要用任务管理器强杀正在写数据的安装过程。
