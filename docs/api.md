# KnowGap MVP API 契约 v0.2

更新：2026-10-14。由 GPT 维护，Claude 与 Cursor 以本文件和 `/openapi.json` 为准。
这些路径已编写实现；真实模型教学效果仍待配置模型后验证。

## 通用约定

- 本地 Base URL：`http://127.0.0.1:8000`；前端使用 `NEXT_PUBLIC_API_BASE_URL`。
- 请求/响应 JSON；删除成功返回 204，无响应体。所有数组均直接返回数组，不包裹 `data`。
- 当前仅支持演示身份 `demo-student-001`，省略 `student_id` 使用该值；其他身份返回 422。
- 这是本地受控演示接口，没有用户认证。默认仅绑定 `127.0.0.1`，不公开多用户部署。
- CORS 默认允许 `http://localhost:3000` 和 `http://127.0.0.1:3000`。
- 首次作答与后续消息均不流式，等待完整响应；前端发送期间禁用重复提交。
- ID 为不透明字符串；时间为带时区的 UTC ISO 8601 字符串。

## 路径

| 方法 | 路径 | 成功响应 |
| --- | --- | --- |
| GET | `/health` | `{"status":"ok"}`；不表示模型已配置 |
| GET | `/api/problems` | `Problem[]`；不返回参考解 |
| POST | `/api/diagnosis` | `TeachingResponse`；创建会话并完成首轮 |
| POST | `/api/sessions/{session_id}/messages` | `TeachingResponse`；追加一轮 |
| GET | `/api/sessions/{session_id}?student_id=demo-student-001` | `Session`；恢复已有会话 |
| GET | `/api/memories?student_id=demo-student-001` | `Memory[]` |
| DELETE | `/api/memories/{memory_id}?student_id=demo-student-001` | 204 |

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

## 首次诊断

```json
{
  "student_id": "demo-student-001",
  "problem_id": "stack-sequence-001",
  "answer": "我认为合法，因为这些数字都在入栈序列里。"
}
```

`answer` 合并答案与解题理由。后续消息请求仅含 `{"content":"学生当前回答"}`。
`answer` / `content` 去除两端空白后须为 1—6000 字符；未知字段返回 422。

```ts
type Assessment = "correct" | "incorrect" | "uncertain";
type Diagnosis = {
  topic_key: string;
  assessment: Assessment;
  issue: string | null; // 仅 incorrect 可以且必须非空
  confidence: number; // 0—1，未校准的启发式指标，不显示为准确率或掌握率
  evidence: string; // 学生当前回答中的逐字连续原文；后端会校验
};
type TeachingResponse = {
  session_id: string;
  turn: number; // 首次为 1；每次成功请求递增
  diagnosis: Diagnosis;
  reply: string;
  used_memory_ids: string[]; // 本轮送入模型上下文的历史记忆；不是模型一定有效利用的证明
  memory_changes: Array<{ action: "created" | "updated"; memory: Memory }>;
};
```

初次与后续响应使用同一结构。`diagnosis` 评价当前学生回答；后续阶段不要求每轮重述完整题解。
前端可使用 `memory_changes` 即时更新面板，也可成功后重新 GET `/api/memories`。
看到 `used_memory_ids` 时显示“参考了历史学习记录”，再通过 Memory 的证据找到具体经历。
历史记忆只辅助提示，不覆盖当前作答判断。

### 首次结论的参考校验

首次作答明确声明“合法／不合法／可能／不可能”等结论时，后端会与确定性栈模拟比较。
如果该结论与参考结果矛盾，而模型仍返回 `correct`，本轮返回 502 且不写入任何学习记录。
例如第一题回答“我认为该序列合法，因为所有元素都能依次出栈。”却被判为正确，会被拦截。
后端拒绝矛盾的模型结果，不擅自替模型编造误区或教学回复，也不自动重试收费调用。

校验使用保守的句首结论识别，含糊、引用、条件句或相互矛盾的声明不自动判卷。
这不是通用自然语言评分器：未识别的表达、错误理由、对话中局部理解仍依赖模型并需要人工评估。
后续对话不套用整题结论校验，因为学生可能在回答某一步操作是否合法。

## 记忆和会话

```ts
type Evidence = {
  message_id: string;
  session_id: string;
  problem_id: string;
  quote: string;
  assessment: Assessment;
  phase: "initial" | "tutoring";
  created_at: string;
};
type Memory = {
  id: string;
  student_id: string;
  topic_key: string;
  issue_key: string;
  summary: string;
  status: "suspected" | "needs_review" | "improving" | "resolved";
  confidence: number; // 最新关联观察的启发式指标，不是汇总掌握率
  evidence_count: number;
  evidence_refs: Evidence[];
  updated_at: string;
};
type Session = {
  id: string;
  student_id: string;
  problem_id: string;
  turn: number;
  created_at: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    created_at: string;
    diagnosis: Diagnosis | null; // 本轮观察附在 user 消息，assistant 为 null
    used_memory_ids: string[]; // 附在 assistant 消息
  }>;
};
```

记忆按演示身份、知识点、误区去重。当前知识点 `stack.lifo`，误区键 `lifo_order`。

- 首次错误 → `suspected`；累计两条错误观察 → `needs_review`。
- 后续正确 → `improving`；最近错误之后，在两道不同题目的首次作答中正确 → `resolved`。
- `uncertain` 不创建/更新误区记忆。首次就正确且无历史误区时不制造记忆。
- 再次错误可重新进入待巩固状态。提示后的正确回答不作为独立掌握证据。
- 记忆删除会删除其关联关系，但保留原会话与消息；不是“清空所有学习记录”。
- 模型上下文最多包含 3 条相关记忆，每条最近 3 段证据及最近 12 条会话消息；数据库保留完整记录。

## 错误和重试

| 状态 | 场景 | 前端行为 |
| --- | --- | --- |
| 404 | 题目、会话或记忆不存在 | 显示错误并刷新相关列表 |
| 409 | 并发作答冲突、生成时记忆被删除、会话达到 40 轮 | 刷新会话后由学生重新提交，或开新会话 |
| 422 | 空输入、超过长度、非法身份或字段 | 提示输入问题 |
| 502 | 无法连接模型、模型输出错误/编造引用、结论与参考校验冲突、协议不兼容 | 保留输入，允许手动重试 |
| 503 | 缺配置、上游权限/额度/限流问题、数据库异常 | 提示检查配置或稍后重试 |
| 504 | 模型超时 | 保留输入，允许手动重试 |

业务错误为 `{"detail":"可读错误"}`；422 使用 FastAPI 标准 `detail` 数组，前端需兼容两种格式。
模型失败不创建会话、追加消息或更新记忆；保存一轮时会话、两条消息和记忆变更在同一事务中提交。
没有请求幂等键：浏览器断网/超时不等于服务端一定未提交，先恢复会话检查，再手动重试。

## 模型配置

见 `backend/README.md` 和根目录 `.env.example`。仅支持兼容 Chat Completions 且支持
`response_format: {"type":"json_object"}` 的服务；其余协议需要新增适配器。
生产路径没有假模型自动兜底。测试通过注入 Tutor 或 HTTP MockTransport 完成，不调用真实收费 API。
