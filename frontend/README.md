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

已对接健康检查、题目列表、首次诊断、追问、会话读取、记忆列表和删除接口，契约见 `../../KnowGap-backend/docs/api.md`。

- `src/lib/api/http-client.ts` 将后端字段映射为页面视图模型；答案和解题思路合并为后端的 `answer`。
- 追问后更新最新诊断和本轮检索的记忆。后端未提供“提示/答案”分类，客户端不会自行猜测。
- API 模式仅在浏览器保留会话 ID，刷新后向后端读取消息。超时重试追问前先核对服务器轮次，避免已保存的回答被再次发送。
- 409、422、模型故障和超时均有提示。缺少模型配置时保留输入，不生成模拟诊断。
- API 模式使用固定演示身份 `demo-student-001`；没有真实用户登录或身份隔离功能。

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

颜色、圆角和阴影集中在 `src/app/globals.css`，支持系统深色模式。组件使用 CSS Modules，图标使用 `lucide-react`。≥1241px 三栏，901–1240px 两栏，≤900px 单栏。
