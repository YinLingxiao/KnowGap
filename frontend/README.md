# KnowGap Frontend

KnowGap（知隙）的网页界面，使用 Next.js、React 和 TypeScript。它是一个 AI 学习工作台：和 AI 对话学习，按学习空间管理资料、日程与学习记忆。桌面版（Electron）加载同一套页面。

## 启动

在此目录执行 `npm install`、`npm run dev`，访问 http://localhost:3000。

复制 `.env.example` 为 `.env.local`。默认 `NEXT_PUBLIC_DATA_SOURCE=mock` 不连接后端，页面只显示接入提示；连接真实后端时使用：

```dotenv
NEXT_PUBLIC_DATA_SOURCE=api
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000
```

修改这些变量后需要重启开发服务；生产模式需要重新构建。`NEXT_PUBLIC_*` 会进入浏览器，不能存放模型密钥。模型配置只放在后端 `.env`。

生产预览：`npm run build`，再执行 `npm run start`。

## 接口接入状态

页面通过 `src/lib/chat/api.ts` 等客户端调用后端，契约见 `../docs/api.md`、`../docs/free-chat.md`。主要功能：

- **对话与学习空间**：对话流式回复、停止和重试，主线协调与支线讲课，练习题，学习计划与学习记忆（`src/components/chat/`、`src/hooks/useChat.ts`）。
- **资料库**：上传、检索、预览课程资料（`src/lib/api/material-client.ts`）。
- **日程**：任务、周历和 AI 拆解（`src/components/agenda/`、`src/lib/agenda/`）。
- **设置**：模型接入、搜索 Key、外观与桌面更新（`src/components/settings/`）。
- **首次使用引导**：欢迎页、新手清单与帮助中心（`src/components/onboarding/`）。

`src/lib/api/http-client.ts` 是共用的请求层：`request` 负责超时、鉴权头和错误分类，`mapSource` 把资料引用映射为页面类型。页面类型见 `src/lib/types.ts`。

- 浏览器只保存登录令牌和界面偏好；会话、消息和记忆都从后端读取。
- 409、422、模型故障和超时均有提示，缺少模型配置时保留输入。
- 数据来源由 `NEXT_PUBLIC_DATA_SOURCE` 决定：`api` 连接后端；`mock` 不连接后端，只显示接入提示。

设置（侧栏齿轮或快捷键 `,`）里的「模型接入」卡片对接 `GET/PUT /api/ai/config` 与 `POST /api/ai/test`（契约见 `../docs/ai-config-api.md`，代码在 `src/lib/api/ai-config.ts`）：选服务商预设或自定义地址，填写模型与 API Key，先测试连接再保存，保存后立即生效、无需重启后端。密钥只随请求发往本机后端，后端不回传；页面不缓存、不持久化密钥，保存成功后清空输入框。服务商地址与示例模型名以各家控制台为准。

## 验证

```bash
npm run test:api
npx tsc --noEmit
npm run lint
npm run build
```

`test:api` 用 Node 内置测试工具运行 `tests/*.test.cjs`：请求层与各客户端的契约检查（使用模拟 HTTP 响应）、界面逻辑模型和多语言词条覆盖。不连接真实后端，也不调用真实模型。

## 目录

- `src/components/`：对话、学习空间、日程、首页、引导和设置等界面组件。
- `src/lib/api/`：请求层、错误处理和各后端客户端。
- `src/lib/chat/`：对话相关的接口、类型和纯逻辑。
- `src/lib/types.ts`：页面视图模型。
- `tests/`：`test:api` 运行的 Node 内置测试。

## 设计约定

紧凑工具界面（参考 Linear）：中性灰阶 + 蓝色强调，浅色 / 深色两套主题，默认跟随系统、侧栏可手动切换；快捷键 `N` 新会话、`/` 聚焦输入框。完整规范与令牌见 [DESIGN.md](DESIGN.md)，令牌集中在 `src/app/globals.css`。组件使用 CSS Modules，图标使用 `lucide-react`，字体 Inter 来自本地依赖 `@fontsource-variable/inter`。
