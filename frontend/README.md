# KnowGap Frontend

KnowGap 学习演示页面，使用 Next.js、React 和 TypeScript。

作答 → 认知诊断 → 引导式对话 → 查看学习记忆 → 新会话参考历史。

## 启动

在此目录执行 `npm install`、`npm run dev`，访问 http://localhost:3000。

复制 `.env.example` 为 `.env.local`。默认 `NEXT_PUBLIC_DATA_SOURCE=mock` 使用明确标注的模拟数据；连接真实后端时使用：

```dotenv
NEXT_PUBLIC_DATA_SOURCE=api
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000
```

修改这些变量后需要重启开发服务；生产模式需要重新构建。`NEXT_PUBLIC_*` 会进入浏览器，不能存放模型密钥。模型配置只放在后端 `.env`。

生产预览：`npm run build`，再执行 `npm run start`。

## 接口接入状态

已对接健康检查、题目列表、首次诊断、追问、会话读取、记忆列表和删除接口，契约见 `../docs/api.md`。

- `src/lib/api/http-client.ts` 将后端字段映射为页面视图模型；答案和解题思路合并为后端的 `answer`。
- 追问后更新最新诊断和本轮检索的记忆。后端未提供“提示/答案”分类，客户端不会自行猜测。
- API 模式仅在浏览器保留会话 ID，刷新后向后端读取消息。超时重试追问前先核对服务器轮次，避免已保存的回答被再次发送。
- 409、422、模型故障和超时均有提示。缺少模型配置时保留输入，不生成模拟诊断。
- API 模式使用固定演示身份 `demo-student-001`；没有真实用户登录或身份隔离功能。

设置（侧栏齿轮或快捷键 `,`）里的「模型接入」卡片对接 `GET/PUT /api/ai/config` 与 `POST /api/ai/test`（契约见 `../docs/ai-config-api.md`，代码在 `src/lib/api/ai-config.ts`）：选服务商预设或自定义地址，填写模型与 API Key，先测试连接再保存，保存后立即生效、无需重启后端。密钥只随请求发往本机后端，后端不回传；页面不缓存、不持久化密钥，保存成功后清空输入框。API 模式启动时读取一次配置，未配置时侧栏显示「模型未接入」。Mock 模式下卡片只显示说明。服务商地址与示例模型名以各家控制台为准。

初次诊断若在服务器保存后丢失响应，客户端尚不能通过幂等键找回未知的会话 ID；重试可能创建新会话。后续可补充请求幂等接口。

## 验证

```bash
npm run test:api
npx tsc --noEmit
npm run lint
npm run build
```

2026-10-14：10 项客户端契约测试、类型检查、静态检查和生产构建通过。测试使用模拟 HTTP 响应，覆盖字段映射、会话恢复、记忆证据、204 删除和错误处理。

浏览器已验证真实后端的题目加载、在线状态、提交请求，以及缺少模型配置时的错误提示和输入保留。尚未配置真实模型，未验证真实 AI 诊断、追问质量与完整教学闭环。

## 目录

- `src/components/`：三栏工作台、题目、诊断、对话和记忆组件。
- `src/hooks/useWorkbench.ts`：加载、提交、会话恢复、追问和记忆状态。
- `src/lib/api/`：HTTP 客户端、客户端选择和错误处理。
- `src/lib/types.ts`：页面视图模型和客户端接口。
- `src/mocks/`：独立的模拟数据模式，不调用模型；页面明确显示 Mock 标识。
- `tests/http-client.test.cjs`：使用 Node 内置测试工具执行的客户端契约检查。

## 设计约定

紧凑工具界面（参考 Linear）：中性灰阶 + 蓝色强调，浅色 / 深色两套主题，默认跟随系统、侧栏可手动切换；快捷键 `N` 新会话、`/` 聚焦输入框。完整规范与令牌见 [DESIGN.md](DESIGN.md)，令牌集中在 `src/app/globals.css`。组件使用 CSS Modules，图标使用 `lucide-react`，字体 Inter 来自本地依赖 `@fontsource-variable/inter`。
