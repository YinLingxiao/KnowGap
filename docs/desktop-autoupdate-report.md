# 桌面自动更新实现与验证报告（2026-10-23）

## 结论

已实现 v0.5.7（原计划 0.5.6，该号未发布）的更新模块、桌面设置、静默下载提示、发布前校验与测试。**尚不能签署安装级发布验收**：本轮负责人明确选择「先实现，暂不打包」，因此没有构建/安装任何临时版本，也没有使用 generic provider 执行真实安装升级。

未发布 Release、未推送、未打 tag、未修改 `desktop/dist`；未提交或写入 `docs/presentation/`，未写入密钥，未修改后端业务、日程、模型接入或登录文件。工作区已有及并行新增的他人改动均保留。

## 本任务改动的全部文件

| 文件 | 用途 |
| --- | --- |
| `desktop/updater.js` | 更新策略、状态机、固定 IPC、设置与 URL 校验、调度、安装协调 |
| `desktop/main.js` | 设置持久化、受信任页面校验、更新模块接入、等待后端退出、安装前清理 |
| `desktop/preload.js` | `window.knowgap.updater` 四个方法及取消订阅 |
| `desktop/package.json` | 0.5.7、运行时依赖、GitHub publish、无空格产物名、禁止构建自动上传、测试命令 |
| `desktop/package-lock.json` | 对应版本与运行时依赖锁定 |
| `desktop/tests/updater.test.cjs` | 假 EventEmitter 更新器、状态/安全/调度/真实 main 清理回调单测 |
| `desktop/tests/release.test.cjs` | 本地临时产物、哈希/版本/文件名/发布脚本护栏测试 |
| `frontend/src/lib/desktop-updater.ts` | 更新桥接类型、订阅 hook、卸载清理与初始快照竞争保护 |
| `frontend/src/components/settings/UpdateRows.tsx` | 软件更新设置与操作 |
| `frontend/src/components/settings/UpdateRows.module.css` | 更新组样式、焦点、窄宽布局及局部可读性修正 |
| `frontend/src/components/settings/SettingsDialog.tsx` | 仅一个 import 和 DesktopRows 下的一行挂载 |
| `frontend/src/components/desktop/UpdateIndicator.tsx` | 已下载版本的小圆点、悬停/无障碍提示、进入设置 |
| `frontend/src/components/chat/ConversationSidebar.tsx` | 仅一个 import 和侧栏底部的一行挂载 |
| `frontend/tests/desktop-updater.test.cjs` | preload 行为、源码契约及组件静态渲染测试 |
| `scripts/verify-update-artifacts.cjs` | 发布/构建共用的离线产物校验，无网络副作用 |
| `scripts/publish-release.ps1` | 读取说明文件、校验、人工确认后由 gh 上传三文件；支持 CheckOnly |
| `scripts/build-desktop.ps1` | 校验 latest.yml 和新文件名、调用共用校验器；UTF-8 BOM 兼容 PowerShell 5.1 |
| `docs/desktop-release-checklist.md` | 发布、源配置、路演开关、待做包级验收、回退步骤 |
| `README.md` | 桌面端新增更新入口与首版手动安装边界说明 |
| `docs/desktop-autoupdate-report.md` | 本报告 |

### main.js 摘要

- 将新增四个更新设置合入现有 load/save/publicSettings，不更改托盘、主题、自启设置的默认含义。
- `stopBackend()` 改为返回可等待、幂等的 Promise：等 `taskkill /t /f` 结束，失败或 8 秒超时则不开始安装。普通退出仍保留现有调用方式。
- 安装顺序：原生确认 → `quitting=true` → `await stopBackend()` → 销毁启动层/快问/托盘 → 更新模块 `quitAndInstall`。取消确认不停止后端；安装已拆除后端但失败时尝试重新启动当前版本，避免留下无后端的活窗口。
- 接入 `before-quit` 以处理用户显式开启的退出安装，阻止重复退出绕过清理；正常关闭到托盘逻辑不变。
- 更新/设置 IPC 只接受本应用主框架、同源、已知窗口；不信任页面传入地址、路径或任意通道名。外链、单实例锁、启动动画、快问和标题栏的已有行为保持。
- 开始任务时 main.js 已有他人修改的默认浏览器外链逻辑，该逻辑保留，本轮没有替换它。

### package.json 摘要

- 桌面版本 `0.5.5 → 0.5.7`；增加运行时依赖 `electron-updater@6.6.2`，Electron 33.2.1 / builder 25.1.8 不变。
- publish 指向公开仓库 `YinLingxiao/KnowGap`，安装包固定 `KnowGap-Setup-${version}.exe`。files 增加 updater.js；原 extraResources 与 NSIS 可选目录/向导配置保留。
- `dist` 固定 `--publish never`，避免有令牌时构建顺带上传。新增 `npm test`。
- **未修改 installer.nsh**，保留 `${isUpdated}` 和 `${Silent}` 防删数据护栏。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| `desktop: npm test` | **25 通过**，覆盖状态机、静默失败/无更新、进度、默认值、禁用变量、源优先级/URL 拒绝、IPC、下载开关、退出安装、重复退出、确认取消、停止后端失败、恢复退出、产物校验等 |
| `frontend: npm run test:api` | **159 通过**（含新增 7 项）。早期一轮并行模型库接口未齐导致 3 项失败，最终复跑已恢复；未修改相关文件 |
| `backend: .venv/Scripts/python.exe -m pytest -q` | **1022 通过**，1 项 Starlette/httpx 弃用警告，119.43 秒；首次因 120 秒工具时限超时，延长时限后全量通过 |
| `frontend: npx tsc --noEmit --incremental false` | **通过**，未写共享构建产物 |
| 更新相关全部前端变更文件定向 ESLint | **通过，0 错误/警告** |
| 全仓 `npm run lint` | 仍有不在本任务文件中的 **8 错误、1 警告**；见下方，不声称全仓 lint 通过 |
| 两个 PowerShell 脚本 Parser::ParseFile | **通过**，补充 BOM 后 Windows PowerShell 5.1 可解析中文脚本 |
| 发布脚本 `-CheckOnly` 对当前 dist | **如预期拒绝**：旧产物缺少 latest.yml，退出码 1；未调用 gh，未改动 dist |
| 产物校验器的临时单测 | 正确文件名/版本/SHA512/大小通过；缺文件、改名、改版本、字节篡改、坏 blockmap、错误可选 SHA256 均拒绝；临时夹具已自动删除 |
| 当前旧版 .blockmap 格式只读检查 | gzip，版本 2，验证器可解析；不意味着新安装包已经构建 |
| 浏览器中的静态组件夹具 | 复用真实组件/CSS，宽/窄内容区无横向溢出；浅/深主题说明文字对比度约 7.13/7.42；原生 details 可展开和聚焦，进度/开关有可访问名称。只验证渲染/DOM，**不是安装版端到端验证** |
| 视觉检测器 / git diff --check | 无发现；未把他人未提交改动改回 |

全仓 ESLint 剩余位置：`frontend/tests/ai-config-auth.test.cjs`、`desktop-startup.test.cjs`、`file-attachments.test.cjs`、`onboarding.test.cjs`、`reading-comfort.test.cjs`、`theme-transition.test.cjs` 中的 `module` 命名/this 别名问题；`frontend/src/components/chat/ChatApp.tsx:209` 的 hook 依赖警告。本任务没有改这些文件来规避检查。

### 明确未验证

- 未构建新 NSIS 包，未实际检查新包中的 app-update.yml、新产物 latest.yml / blockmap；已经把校验加入构建与发布前门禁。
- 未用 generic 本机 HTTP 源在真实安装版中做「检查 → 下载 → 提示 → 重启安装 → 新版启动」；没有拿假 manifest + 旧 exe 冒充升级成功。
- 未验收升级后的原安装目录、桌面快捷方式、对话、学习空间、模型配置/密钥、自启设置、登录态/端口、后端健康以及升级时不弹删数据询问。
- 未验收所有用户安装的真实 UAC 允许/取消、SmartScreen、真实差分与回退全量。官方 updater 会在 NSIS 安装时传入 `--updated`，本轮只做源码与测试验证，不代替 Windows 安装验收。
- 未做真实 GitHub 发布后升级。v0.5.7 自身仍需手动安装；负责人发布下一个更高正式版本后才能验证完整公开发布链路。
- 截图工具要求可见桌面窗口，本会话无法捕获该窗口；不声称做过安装版截图验收。静态预览服务和临时脚本已清理，无假版本被发布或留在 dist。

## 发布与回退（负责人执行）

1. 协调独占构建，在隔离 Windows 账户/沙盒完成[本机 generic 安装级验收](desktop-release-checklist.md#必做本机-generic-安装级验收本轮尚未执行)，特别核对数据/密钥只在本机比较、不输出。
2. 正式版本构建，确认 `latest.yml`、`KnowGap-Setup-<version>.exe`、`.exe.blockmap` 同版本同名；不要重命名任何资源。
3. 负责人自行准备/推送匹配标签。运行 `scripts/publish-release.ps1 -Tag v<version> -NotesFile <说明文件> -CheckOnly`，再去掉 CheckOnly，输入完整标签确认上传。脚本不创建标签、不推送、不构建。
4. 发布后核对 GitHub 的资源名与清单；用先手动安装的 v0.5.7 测下一个正式版本。
5. 回退止损：撤下错误 Release（或镜像的 latest.yml），通知已下载用户不要安装，彻底退出后用 `KNOWGAP_DISABLE_UPDATE=1` 启动。已安装则以更高版本发布修复/已验证旧代码，**不开放自动降级**；紧急手动回装前备份数据并确认向后兼容。

注意：electron-builder 标准清单是 **SHA512**，不是 SHA256。本实现比较实际 SHA512 与清单，并独立计算 SHA256 供人工记录/可选 ExpectedSha256 校验；没有把两种算法冒充成同一种。未签名/UAC 的体验风险仍在，但未降低完整性校验强度。
