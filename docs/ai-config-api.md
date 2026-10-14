# AI 接口卡片后端契约

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
仅支持现有 OpenAI-compatible Chat Completions 适配器，不代表原生 Anthropic/Gemini 协议兼容。

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
