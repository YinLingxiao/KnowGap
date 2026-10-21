# 知隙 KnowGap

**把一次提问，接成持续的学习。**

KnowGap 是带长期记忆的 AI 学习伙伴。直接开始对话，或建立学习空间：在主对话描述需求，AI 协调学习路线，主动创建或续接 Thread 并开始执行；用户在右侧深入交互，进展与结果回到主对话。

学习记录附带用户原话证据，用户画像和环境笔记由 Agent 的记忆工具维护，历史会话则可以按需检索。围绕这条学习主线，KnowGap 还把复习排期、专注计时、考前复盘和桌面端随手提问接在一起：AI 记得你哪里不会，也能帮你把「什么时候补」排进日程。

> ACC 2026 黑客松作品，面向本机运行。支持本地账号登录与「本机演示身份」一键进入；数据保存在本机 SQLite，未做公网多用户部署。

## 评委快速体验

1. **安装**：在 [Releases](https://github.com/YinLingxiao/KnowGap/releases) 下载最新的 Windows 安装包（`KnowGap Setup *.exe`）并安装；也可以按下文「本地启动」用源码运行。
2. **配置模型（必需）**：首次打开后进入「设置 → 模型」，填写任意 OpenAI 兼容服务的地址、API Key 和模型名，点「测试」通过即可。所有 AI 功能都依赖这一步；未配置时只能浏览界面。模型需支持 Chat Completions、JSON 输出与 function calling。
3. **进入**：登录页选择「使用本机演示身份直接进入」。
4. **导入演示数据（可选）**：源码运行时执行 `backend/.venv/Scripts/python.exe backend/scripts/seed_demo.py`，会生成「数据结构（演示）」「电路原理（演示）」两个学习空间，以及带原话证据的误区、已解决的 Thread、日程任务和 12 周专注记录；`--reset` 只删除这些演示数据。
5. **推荐体验路线**（约 5 分钟）：
   - 在「数据结构（演示）」里打开右侧「图谱」看知识迷雾拓扑图，再点顶栏 ⚡ 生成考前急救一页纸；
   - 在对话里说「帮我把这周的复习排进日程：明天晚上 8 点练二叉树遍历，周六上午复习哈希冲突」，回复里会出现「已加入日程」卡片；
   - 打开侧栏「日程」，在预览、周历和学习空间（项目）之间切换，按 `Q` 用中文快速添加任务；
   - 在任务上点「▶ 专注」，用 ⚡ 10 秒演示档走完一次番茄，把一句话收获存进空间的 Pages 笔记；
   - 在任意 AI 回复里划选一句话，试试「追问这句 / 举个例子 / 摘录到笔记」；输入 `/viva` 开始三轮模拟复试；
   - 桌面版：关闭窗口后应用留在托盘，按 `Alt+Space` 随时呼出快问浮窗。

## 实际界面

以下截图于 2026-10-15 在本地运行时拍摄，学习空间中的回复来自已配置的真实模型。界面此后经过重新设计，截图仅示意核心流程，最新外观以实际运行为准。

### 从一句话开始

首页直接提问；需要长期推进时，再选择或新建学习空间。

![自由对话首页](docs/screenshots/home.jpg)

### 为学习建立主线

填写目标与当前基础，按需要补充截止日期和资料。每个空间有自己的主对话、Thread、资料与学习记录。

![新建学习空间](docs/screenshots/create-space.jpg)

### 把卡点放进 Thread

在主对话描述任务，AI 会创建或续接 Thread 并立即开始。相关补充会转交给已有 Thread，执行中收到的补充按顺序处理。右侧显示正在执行、等待你、空闲和已解决；点主对话中的进展卡片可以查看详情和直接参与。点“已解决”后，仍可编辑模型起草的小结并合并回主对话。

2026-10-16 更新：下方截图保留此前版本的外观；新的协调与执行流程见 [Thread 设计与验证](docs/thread-coordination.md)。

![主对话与 Thread](docs/screenshots/thread.jpg)

确认小结后，主线会保留可重新打开的已解决卡片。

![合并回主对话的小结](docs/screenshots/thread-resolved.jpg)

### 看得见依据的学习记忆

记录展示知识点、状态、来源对话和用户原话。可以纠正内容、修改归属或删除。

![学习记录及原话证据](docs/screenshots/memory-evidence.jpg)

## 当前能力

**学习主线**

| 能力 | 当前行为 |
| --- | --- |
| 自由对话 | 流式回答，支持停止、重新生成和历史恢复；话题自动命名，长对话触顶时增量压缩早期上下文 |
| 学习空间 | 保存目标、基础、截止日期和说明；主对话推进路线，Thread 处理卡点，进展回到主对话 |
| 预设练习 | 输入框「+ → 练习题」带入人工校验的栈出栈序列题，服务端校验参考解 |
| 学习记忆 | 记录误区、掌握与学习偏好，附逐字原话证据，支持纠正、删除和归属筛选；新会话按话题召回 |
| Agent 记忆 | 五层 USER 画像（Identity / Preference / Context / Activity / Experience）与 MEMORY 环境笔记，可选写入审批 |
| 先验迁移 | 首轮探测已有知识锚点，用对比矩阵讲新旧知识的异同与负迁移 |
| 划词工具条 | 在 AI 回复里选中文字：追问这句、举个通俗例子、摘录到空间 Pages 笔记 |
| 学习微件 | 对比矩阵、随堂测验卡、分步推演、代码实验台（本地沙盒编译运行 Python/C/C++/JS）等交互卡片 |
| 联网真题 | 检索真题母题并做原文溯源与去重，SymPy 验算答案；全站 KaTeX 公式渲染 |
| 视觉批改 | 上传图片后由视觉模型客观转写、定位区域，逻辑模型判错；原图椭圆圈画批注、电路网表确认后列 KCL/KVL |
| 资料 | 上传 PDF、TXT、Markdown；按空间归属检索资料 |

**复盘与检验**

| 能力 | 当前行为 |
| --- | --- |
| 考前急救一页纸 | 汇总本空间的个人易错红榜（附原话）、Thread 结论、核心公式与适用边界、易混概念与押题自测；可打印 / 导出 PDF 与 Markdown |
| 知识迷雾拓扑图 | 三环结构：已掌握 / 待攻克（误区与进行中 Thread）/ 模型推导的下一阶段待解锁概念；点节点看证据并一键开启专项 Thread |
| 模拟复试 | `/viva` 三轮递进压力追问，针对历史误区与边界条件；结束后给出五维能力雷达图与改进建议 |

**规划与专注**

| 能力 | 当前行为 |
| --- | --- |
| 知隙日程 | 收件箱 / 今天 / 预览 / 周历 / 学习空间（项目）多视图；计划日期与硬截止日分开；父子任务、P1–P4 优先级、标签；导出 `.ics` |
| AI 排日程 | 在对话中说「帮我排进日程」「明天下午提醒我」，AI 先查看已有安排再写入、改期或标记完成，回复里显示「已加入日程」卡片 |
| 添加任务 | 任何页面按 `Q` 呼出；中文自然语言识别「明天下午3点 #空间 p1 45分钟」并高亮，字段按钮同步填充；可交给 AI 拆解大目标 |
| 艾宾浩斯闪回 | 每条未解决的误区自动生成第 1 / 3 / 7 天的复习任务，以完成时间为锚点递进 |
| 任务提醒 | 开始前准时 / 5 分钟 … 1 天提醒，系统通知，点击直接开始专注 |
| 心流番茄 | 侧栏专注入口，15 / 25 / 45 分钟与 10 秒演示档；结束时一句话收获自动存进空间 Pages，可顺手完成绑定任务；12 周专注热力图（设置 → 复盘） |

**桌面端（Windows）**

| 能力 | 当前行为 |
| --- | --- |
| 安装包 | Electron 随应用运行本机后端与静态前端，数据保存在用户数据目录，重启保留登录与会话 |
| 托盘与后台 | 关闭窗口最小化到托盘，提醒与计时在后台继续；托盘菜单可快问、开始专注、查看今日待办；单实例、可选开机自启 |
| Spotlight 快问 | `Alt+Space`（冲突时 `Ctrl+Shift+K`）全局呼出半透明快问条，提问自动归入学习空间，可一键在主窗口打开 |
| 工作区工具 | 读写与精确编辑文件、执行命令，在对话中展示工具结果和审批；17 条安全黑名单拦截危险命令 |

## 记忆怎样工作

| 层次 | 记录内容 | 写入与使用 |
| --- | --- | --- |
| 学习记录 `learner_memories` | 误区、掌握、学习偏好 | 回复后分析用户原话，校验连续引用；按话题召回，结合空间归属提供上下文 |
| 精选笔记 `agent_memory` | USER：身份、沟通方式、长期目标；MEMORY：环境、路径、工具约定 | Agent 调用 `memory` 的 `add / patch / remove`；每轮读取最新快照，修改下一轮生效 |
| 历史会话 | 已保存的对话原文 | Agent 按需调用 `session_search`，通过 SQLite FTS5 检索 |

- USER 上限 **1375 字**，MEMORY 上限 **2200 字**；条目去重，超限拒绝写入。
- 扫描规则拒绝部分疑似密钥和指令注入内容。这是模式匹配，无法保证覆盖全部情况。
- 设置中可开启“记忆写入需确认”，工具与后台复盘的笔记先进入待确认列表。
- 同一会话累计 10 个未因成功写入而重置的有效轮次时，触发后台笔记复盘；重新生成不重复计数。
- **删除笔记不等于清除对话历史。** 删除后笔记不再进入下一轮快照，原始对话仍可能被历史检索找到。
- 单纯提问不应被记作误区。原话校验约束证据来源，无法保证模型对知识点的判断始终正确；不准确的记录可以手动纠正。

## 本地启动

准备 Python（项目使用 3.10+ 语法）与兼容 Next.js 15 的 Node.js。在仓库根目录执行以下 PowerShell 命令。

### 1. 后端

```powershell
python -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements-dev.txt
if (-not (Test-Path backend/.env)) { Copy-Item .env.example backend/.env }
```

在 `backend/.env` 填写模型配置，也可以启动后在界面“设置”中填写并测试：

```dotenv
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model-name
LLM_TIMEOUT_SECONDS=45
```

服务地址包含提供商要求的版本前缀，不包含 `/chat/completions`。模型需支持 OpenAI 兼容的 Chat Completions 与 JSON object 输出；使用记忆和工作区工具还需支持 function calling。

密钥仅放后端，不能写入 `NEXT_PUBLIC_*`。界面保存的模型配置位于本机数据目录的 `ai-settings.json`，其中包含密钥，已被 Git 忽略。

```powershell
Set-Location backend
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### 2. 前端

另开一个终端，回到仓库根目录：

```powershell
Set-Location frontend
npm install
```

创建或编辑 `frontend/.env.local`：

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

未配置模型时可以查看页面和已有记录，生成回复需要完成模型设置。修改前端环境变量后需重启前端，生产模式需重新构建。

### 3. 可选：工作区与桌面端

在“设置”中填写已有文件夹路径，启用工作区工具。文件工具限制在工作区内；命令工具以该目录为起点，但没有文件系统沙箱，仍可访问目录外。命令始终逐次审批，文件写入可选择自动批准。

Windows 桌面打包（在仓库根目录运行）：

```powershell
./scripts/build-desktop.ps1
```

脚本构建静态前端，用 PyInstaller 打包后端，再用 electron-builder 生成安装包，输出到 `desktop/dist/`。Electron 启动本机后端并加载同源页面，数据保存在 Electron 用户数据目录。发布前的逐项验证清单见 [桌面版验证清单](docs/desktop-release-checklist.md)。

## 验证与测试

常规测试使用临时数据库和模拟模型，不调用真实付费接口：

```powershell
# 在 backend/ 中
.venv/Scripts/python.exe -m pytest checks tests -q

# 在 frontend/ 中
npm run test:api
npm run lint
npx tsc --noEmit
npm run build
```

可选的真实模型记忆评估会使用当前本机模型配置，产生真实接口调用费用；使用独立临时数据库，不读写现有学习记录：

```powershell
# 在 backend/ 中
.venv/Scripts/python.exe checks/evaluate_live_memory.py
```

覆盖画像写入、跨会话召回、修改与删除、历史检索、审批、原话证据、学习记录纠正与删除、非法写入拦截和重启持久化。完整测试对话写入本机 `logs/live-memory-evaluation.json`，已被 Git 忽略。

本轮结果与限制见 [2026-10-15 记忆系统验证](docs/evaluation/2026-10-15-memory-system.md)。

2026-10-15：后端 165 项、前端接口 15 项通过，静态检查、类型检查和生产构建通过。真实模型首轮 16/19 项通过，受上游错误影响的 3 项定向复测全部通过；审批措辞与检索结果仍有待改进，详见报告。

2026-10-22：后端 777 项、前端 90 项通过，ESLint 与 TypeScript 类型检查无错误。新增功能（日程与 AI 排期、提醒、番茄专注、一页纸、知识图谱、模拟复试、划词、托盘）另在浏览器中用真实模型与演示数据逐项走查。

## 代码与文档

```text
frontend/                 Next.js 15 / React 19 / TypeScript 界面
backend/app/chat/         对话、SSE、Thread、学情分析、工具循环、一页纸、知识图谱与技能
backend/app/memory/       SQLite、长期笔记、FTS5 检索
backend/app/agent_tools/  文件、命令、memory、session_search、真题检索与日程工具
backend/app/agenda/       日程任务、艾宾浩斯闪回、AI 拆解与 .ics 导出
backend/app/focus/        专注记录与热力图
backend/app/vision/       双模型视觉接力与服务模型分工
backend/app/code_sandbox/ 本地代码沙盒
backend/app/services/     模型设置、资料与外部搜索
backend/scripts/          演示数据导入与清除
backend/tests/            自动化测试
backend/checks/           核心回归与可选真实模型评估
desktop/                  Electron 启动器与打包配置
scripts/                  桌面构建脚本
docs/                     设计说明、截图与验证记录
```

浏览器开发模式默认数据路径为 `backend/data/knowgap.sqlite3`，相对 `DATABASE_PATH` 以 `backend/` 为基准；环境配置、数据库与本地日志不提交 Git。

- [自由对话与学习空间约定](docs/free-chat.md)
- [接口约定](docs/api.md)
- [记忆治理设计记录](docs/记忆治理优化.md)
- [桌面客户端与 Agent 设计记录](docs/桌面客户端与Agent.md)
- [技术决策记录](docs/decisions.md)
- [日程接口约定](docs/contracts/agenda.md) · [学习空间聚合接口](docs/contracts/subject-insights.md)

设计记录包含历史现状与实施计划，当前行为以代码和验证记录为准。

## 已知限制

- 所有 AI 功能需要自行配置 OpenAI 兼容的模型服务；回复质量取决于所选模型。
- 桌面端（托盘、全局快捷键、开机自启）目前只在 Windows 上构建和验证。
- 学习空间的 Pages 笔记保存在本机浏览器存储中，不随数据库迁移。
- Agent 的命令工具以工作区为起点，但没有文件系统沙箱；命令始终逐次审批。代码实验台的沙盒有静态拦截与进程树强杀，但不是完整的容器隔离。
- 账号体系面向单机使用，未做公网部署所需的安全加固。
