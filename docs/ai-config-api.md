# AI 接口卡片后端契约

多服务商、多模型的现行契约是 [model-library.md](contracts/model-library.md)。本文保留 `/api/ai/config` 与 `/api/ai/test` 的兼容说明。

`GET/PUT /api/ai/config` 和 `POST /api/ai/test` 现在作用在**默认模型所属的服务商**上，不再单独代表一份全局配置。响应仍然不含密钥。数据目录里还没有 `model-library.json` 时，若 `ai-settings.json` 或环境变量里已有有效配置，启动会自动迁成一个服务商加一个默认模型；旧文件不删不改。换地址仍必须重新提交密钥。

已在 `frontend` 分支现有 FastAPI 教学后端上增加配置接口。
当前远程代码尚无 Claude 的 AI 配置卡片，因此本次仅交付后端和契约，未声称已完成卡片联调。

## 读取配置

`GET /api/ai/config`

```json
{"base_url":"https://provider.example/v1","model":"your-model","has_api_key":true,"configured":true}
```

永远不返回 API Key，也不返回密钥片段。`configured` 表示必填配置已填写，不代表已通过连接测试。

## 保存配置

`PUT /api/ai/config`，`Content-Type: application/json`

```json
{"base_url":"https://provider.example/v1","model":"your-model","api_key":"your-key"}
```

成功返回与读取配置相同的对象。`base_url` 填 API 根地址，不含 `/chat/completions`。
同一服务地址下，省略或留空 `api_key` 会保留已有密钥；更换地址必须提供新密钥。
保存后立即供 `/api/diagnosis` 和后续教学消息使用，无需重启。
配置以原子替换方式写入数据库同目录的 `ai-settings.json`，重启后优先于 `.env`。
此文件包含明文密钥，只存放在后端本机，已加入 Git 忽略规则；不要放进前端状态持久化或 `NEXT_PUBLIC_*`。
Unix 下新文件权限为 0600；Windows 使用目录继承权限。

## 测试连接

`POST /api/ai/test`

可以发送与保存相同的 JSON 测试尚未保存的配置，也可以不发送请求体测试已生效配置。
测试会调用一次 Chat Completions，验证教学 JSON 格式与证据引用；可能消耗供应商额度。
测试不保存配置、不创建会话、不写入学习记忆。

```json
{"status":"ok","model":"your-model","structured_output":true}
```

错误沿用 `{ "detail": "可展示的中文错误" }`：422 配置无效、503 未配置/权限/额度/保存失败、502 模型格式或连接失败、504 超时。
默认使用 OpenAI-compatible Chat Completions；Vertex Express 根地址自动使用原生 Gemini 适配器。不代表支持原生 Anthropic 协议。

## 卡片接入

1. 打开卡片时读取配置；密钥输入框保持空白，通过 `has_api_key` 提示已保存。
2. 测试按钮 POST 当前填写值，保存按钮 PUT 当前填写值；保存成功后清空密钥输入框。
3. 对失败展示 `detail`，禁止把失败当作已连接，也不要自动切换 Mock。
4. 开发环境继续使用前端现有的后端 base URL 和请求错误映射。

配置接口仅允许 loopback 客户端，且浏览器 Origin 必须在后端 `cors_origins` 中。
运行方式仍为 `python -m uvicorn app.main:app --host 127.0.0.1 --port 8000`。
此能力服务本机演示，部署成公共服务前需增加认证与用户配置隔离。

## 验证

新增回归覆盖配置持久化/重启、密钥留空保留、跨服务防止沿用密钥、即时生效、错误脱敏、
Origin 和远程地址限制、PUT CORS、测试无写入、保存失败不切换生效配置。
真实模型调用与卡片浏览器联调需在配置供应商并同步卡片代码后验证。

## Google Vertex AI 预设（Gemini）

在「设置 → 模型接入」选择 **Google Vertex AI**，现在默认使用 Vertex Express 的原生 Gemini 接口：

- 地址：`https://aiplatform.googleapis.com/v1/publishers/google/models`，无需项目 ID 或区域；不要追加模型名、方法、查询参数或密钥。
- 模型：`gemini-4-argon`（也接受 `google/gemini-4-argon`，请求时移除 `google/` 前缀）；以账号可用模型为准。
- 认证：填 Vertex Express API Key，通过 `x-goog-api-key` 请求头发送；不是 OAuth Access Token、AI Studio API Key 或服务账号 JSON。
- 普通聊天使用 `/{model}:streamGenerateContent?alt=sse`；测试连接、诊断、后台整理及视觉 JSON 任务使用 `/{model}:generateContent`，设置 `responseMimeType=application/json`。
- 后端转换系统提示、对话、图片、工具定义和工具结果；思考摘要与正文分流，模型返回的工具调用签名随工具历史和断点保留。应用注入及迁移的无签名旧工具记录使用 Google 文档规定的签名校验跳过标记；真实签名不替换。
- 用量由原生 `usageMetadata` 映射，输出含模型报告的思考 Token；不估算未报告用量。
- 保存方式、密钥不回显、同地址留空保留密钥及测试不保存等行为不变。

之前的 Vertex OAuth/OpenAI 兼容地址仍可通过「自定义」使用，继续采用 Bearer Token；其他服务商不受此次改动影响。不会自动迁移或覆盖已保存的凭证。

官方说明：https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview

### ADC（应用默认凭证）认证

Vertex 的「认证方式」现在可以选择 **API Key · Vertex Express** 或 **ADC · 应用默认凭证**。已有配置缺少 `auth_mode` 时仍按 API Key 处理，不会自动迁移或执行登录。

ADC 配置示例（不含密钥）：

```json
{"base_url":"https://aiplatform.googleapis.com/v1/projects/my-learning-project/locations/global/publishers/google/models","model":"gemini-4-argon","auth_mode":"adc","project_id":"my-learning-project","location":"global"}
```

- 在运行后端的同一电脑和系统账号下执行 `gcloud auth application-default login`。这与 `gcloud auth login` 不同；组织使用联合身份或服务账号模拟时，遵循管理员的 ADC 登录流程，不要求创建服务账号密钥。
- 切换 Google 账号或重新配置 ADC 后，请重启后端以重新发现凭证；同一凭证的访问令牌到期则由认证库自动刷新，无需重启。
- 界面按项目 ID 和区域生成原生地址。`global` 不带主机区域前缀；如 `us-central1`，则主机是 `us-central1-aiplatform.googleapis.com`。
- 使用 `google-auth` 读取 ADC，按 `cloud-platform` scope 获取访问令牌，以 Bearer 认证。令牌接近过期时自动刷新；发现与刷新在后台线程执行，并发请求共享受锁保护的凭证。
- 选定项目同时作为 quota project，账号需有模型调用及消费该项目配额的权限；需启用 Vertex AI API 和结算。ADC 不绕过组织策略。
- `GET /api/ai/config` 新增 `auth_mode`、`project_id` 和 `location`。ADC 的 `has_api_key=false`，`configured=true` 仅表示配置完整，不表示已登录或测试成功。读取配置不会探测本机凭证；「测试连接」才会认证并调用模型。
- ADC 的 Token 和刷新凭证不写入应用配置、不回传前端。切换到 ADC 保存时会清除应用旧的活动 API Key；切回 API Key 后需要重新填写密钥，防止跨认证方式沿用。
- JSON、流式聊天、工具调用及继承主模型配置的视觉/逻辑任务共用该认证。独立指定了 API 地址的服务模型继续用自己的 Key，不继承 ADC。
- 后端环境变量对应 `LLM_AUTH_MODE=adc`、`LLM_PROJECT_ID`、`LLM_LOCATION`，以及与其一致的 `LLM_BASE_URL`；仍需设置 `LLM_MODEL`。用户 ADC 文件由 Google 工具管理，禁止提交到仓库。

后端新增依赖 `google-auth[requests]`；桌面打包包含 Google 认证模块。没有实际项目和组织授权时，ADC 的自动刷新、错误脱敏和请求链路使用模拟凭证验证，不视为组织账号实连成功。

官方说明：https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment

### ChatGPT 套餐（路线 A：SIWC OAuth + Responses API）

「模型接入」新增 **ChatGPT 套餐** 预设。它不复用 API Key，也不修改 OpenAI API Key 预设。

- 认证：本地 OSS 动态注册。首次请求 `client_id=dynamic_agent_client`，并发送应用名 `agent_name_hint=KnowGap` 与稳定的 `ext_agent_host_id`；回调返回 issued client ID（`oaiapp_…`），之后复用它。
- 回调：后端临时在 `127.0.0.1:1455–1466` 启动 `/auth/callback` 回环监听，只接受本机请求；使用 state、nonce、PKCE S256。授权完成后监听自动关闭，令牌不经过前端。
- Scope：`openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`，资源为 `https://api.openai.com/v1`。缺少 `chatgpt.tokens.use.direct` 时保留登录身份，但标记套餐未授权，禁止推理。
- 令牌：访问令牌 1 小时；刷新令牌 30 天并滚动替换。保存在后端数据目录的独立 `chatgpt-auth.json`（Unix 0600，Windows 使用目录权限），不写入 `ai-settings.json`、不返回前端、不写日志；刷新在锁内串行完成。
- 推理：仅走 `POST https://api.openai.com/v1/responses`，`store=false`、`stream=true`；系统提示折叠为 `instructions`，历史放在 `input`，不发送 `temperature`、`max_output_tokens`、`previous_response_id` 等套餐接口不支持的字段。文本、思考摘要、函数调用、工具结果与用量事件映射到现有对话协议。
- 错误：保留 HTTP 状态、错误码与请求 ID。`subscription_sharing_usage_limit_exceeded` 显示为套餐额度用尽（402），`subscription_sharing_user_not_eligible` 显示资格限制（403），`subscription_sharing_usage_unavailable` 保留凭证并提示稍后重试（503）；不会静默切换到 API Key 计费。
- 模型：连接后通过 `GET /v1/models` 读取账号可见模型，兼容 `models[]` 与 `data[]` 两种返回，按 slug 选择；不硬编码单一模型。
- 退出：优先调用 OpenID discovery 的 revocation endpoint；失败时仍清除本地令牌，并明确提示未确认远端撤销。保留 client 映射和 host ID，便于再次登录。
- 当前限制：对话与结构化 JSON 已接入；视觉识图仍要求独立的多模态 API Key/ADC 配置，不继承 ChatGPT 套餐。多账号注册的数据结构已支持，界面目前展示活动账号。

真实授权需要你的 ChatGPT 账号在浏览器中确认，并受 OpenAI 套餐资格、工作区策略和预览限制约束；未完成真实登录前，回归测试只验证协议、存储、刷新、错误映射和 UI。

官方说明：
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
