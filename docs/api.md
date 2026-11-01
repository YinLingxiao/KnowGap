# KnowGap API 契约

这份文件只保留题库与通用约定。对话、学习空间、资料、日程、记忆等现役接口见 [free-chat.md](free-chat.md)、[course-materials.md](course-materials.md)、[ai-config-api.md](ai-config-api.md)，完整路径以后端 `/openapi.json` 为准。

第一版的“诊断工作台”接口（`POST /api/diagnosis`、`/api/sessions/*`、`GET/DELETE /api/memories`、`GET /api/search`）已删除。
旧版留下的会话和记忆行仍在数据库里，启动时由 `legacy_imports` 迁移一次，复制成对话和学习记忆；迁移不删除旧表。

## 通用约定

- 本地 Base URL：`http://127.0.0.1:8000`；前端使用 `NEXT_PUBLIC_API_BASE_URL`。
- 请求/响应 JSON；删除成功返回 204，无响应体。所有数组均直接返回数组，不包裹 `data`。
- 默认仅绑定 `127.0.0.1`，不公开多用户部署。
- CORS 默认允许 `http://localhost:3000` 和 `http://127.0.0.1:3000`。
- ID 为不透明字符串；时间为带时区的 UTC ISO 8601 字符串。

## 路径

| 方法 | 路径 | 成功响应 |
| --- | --- | --- |
| GET | `/health` | `{"status":"ok"}`；不表示模型已配置 |
| GET | `/api/problems` | `Problem[]`；不返回参考解 |

## 题目

```ts
type Problem = {
  id: string;
  title: string;
  topic_key: string;
  prompt: string;
  input_sequence: number[];
  output_sequence: number[];
};
```

当前内置三道栈题，ID 为 `stack-sequence-001`、`stack-sequence-002`、`stack-sequence-003`。
`prompt` 已包含题目条件。题目内容以 API 为准，前端不要自行硬编码参考答案。

## 练习题的参考校验

对话里开启练习后，模型对作答的判断由后端校验（`chat/agent.py` 的 `validate_analysis`）：证据必须是学生原文的连续片段；
学生明确声明“合法／不合法／可能／不可能”等结论且与确定性栈模拟矛盾时，模型返回的 `correct` 会被丢弃，不记录这次作答。
后端不替模型编造误区或回复，也不自动重试收费调用。

校验使用保守的句首结论识别（`services/reference_guard.py` 的 `declared_verdict`），含糊、引用、条件句或相互矛盾的声明不自动判卷。
这不是通用自然语言评分器：未识别的表达、错误理由、对话中局部理解仍依赖模型并需要人工评估。

## 错误和重试

业务错误为 `{"detail":"可读错误"}`；422 使用 FastAPI 标准 `detail` 数组，前端需兼容两种格式。

| 状态 | 场景 |
| --- | --- |
| 404 | 对象不存在 |
| 409 | 并发冲突 |
| 422 | 空输入、超过长度、非法字段 |
| 502 | 无法连接模型、模型输出错误、协议不兼容 |
| 503 | 缺配置、上游权限/额度/限流问题、数据库异常 |
| 504 | 模型超时 |

## 模型配置

见 `backend/README.md` 和根目录 `.env.example`。仅支持兼容 Chat Completions 且支持
`response_format: {"type":"json_object"}` 的服务；其余协议需要新增适配器。
生产路径没有假模型自动兜底。测试通过注入对话模型或 HTTP MockTransport 完成，不调用真实收费 API。
