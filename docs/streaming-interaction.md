# 流式交互

## 使用方式

- 生成过程中继续输入，按 Enter 或点击“加入待发送”。服务器依次处理，同一会话最多暂存 10 条，可修改、撤回。
- 想马上改变当前方向，输入新要求后点击“停止并按新要求重答”。保留已收到的正文，原有队列暂停，等手动继续。
- 向上滚动后停止跟随；选中文字时冻结当前显示，后续内容继续在后台接收。点击“回到底部”恢复跟随。
- 刷新页面、切换页面后重新接回同一条回复。断线重连只读取已记录的事件，不重新请求模型或重跑工具。
- 桌面端“关闭到托盘”沿用现有设置。退出整个程序或停止后端后，保留已接收内容并标记中断；未发送队列等待手动恢复。

## 实现和兼容

现有 React 聊天控制器和 FastAPI 继续负责消息、工具审批、学习记录和业务卡片。阅读区跟随由 `MessageList` 自己处理：只有 `scrollTop` 变小（往上翻）才停止跟随，内容在渲染后继续变高（卡片、公式、图片）由 ResizeObserver 贴底。

待发送队列存 SQLite（`chat_outbox`、`chat_outbox_state`，在 `ChatStore.initialize` 增量建表）。生成事件只存在内存里（`app/chat/streaming.py` 的 `EventJournal`）：每次生成以助手消息 ID 为 run ID，SSE 事件带递增序号，独立订阅者通过 `after` 游标重放；结束后保留最近 32 条供刚断线的页面接回。正文本身在生成中每 0.3 秒写回消息表，所以不需要把逐字事件落盘。原有发送接口保持兼容；相同请求可重新接回当前生成；停止接口支持指定生成 ID，防止迟到的停止请求误停下一轮。

前端将密集文字增量合并为约 32 毫秒一次更新，大量积压或生成结束时立即追平。题目封存、原图批注、电路网表确认和工具审批仍使用原有业务流程。流式卡片允许文字字段暂时空缺，并设置独立错误边界；无法显示的卡片退回原文，避免整页白屏。

后端进程重启会中断生成，保留最近一次写回的部分正文（最多差 0.3 秒），不能恢复供应商内部的推理状态。工具断点继续受原来的安全校验约束。此实现沿用单个后台进程，不支持多个服务进程共享运行中任务。

## 不消耗模型额度的本地验收

以下命令从仓库根目录执行。先按 [development.md](development.md) 安装依赖；模拟服务只监听本机，使用独立的 `backend/data/streaming-demo/` 数据库。

第一个终端：

```powershell
cd backend
.\.venv\Scripts\python.exe scripts\streaming_demo.py
```

需要更长的手动操作时间时，可在启动模拟后端前设置 `$env:KNOWGAP_DEMO_DELAY = "0.65"`，仅放慢模拟文字输出。

第二个终端：

```powershell
cd frontend
$env:NEXT_PUBLIC_API_BASE_URL = "http://127.0.0.1:8017"
$env:NEXT_PUBLIC_DATA_SOURCE = "api"
npm run dev -- --hostname 127.0.0.1 --port 3017
```

打开 <http://127.0.0.1:3017/dev/streaming-interaction>。预览只在开发模式开放，不修改日常 API 配置。

依次检查：发送长问题 → 生成中排队 → 修改待发送 → 停止并检查暂停 → 继续发送 → 生成中刷新页面 → 向上阅读 → 选中文字追问 → 输入新要求并立即重答。

## 白屏回归

对比卡片的 JSON 刚写到 `rows: [{` 时，预览得到的行还没有 `dimension`。旧公式文字组件直接对空字段调用 `includes`，会产生客户端异常；只检查已完成的回复无法覆盖这一状态。

`widget-streaming-render.test.cjs` 使用真实公式渲染器，对对比卡和步骤卡的每一个 JSON 前缀逐一渲染。另有控制器、事件游标、队列、停止目标、重连、平滑输出和选区冻结回归。可在前端运行 `npm run test:api`，在后端运行 `python -m pytest tests/test_resumable_chat.py`。

本地模拟仅证明交互和状态恢复，不代表真实模型的回答质量或供应商稳定性。正式版本发布及自动更新见 [desktop-release-checklist.md](desktop-release-checklist.md)。
