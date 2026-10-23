# 模型库

服务商保存一次地址、认证方式和密钥；模型是它的子项。输入框里换模型只影响当前对话。新对话和「沿用默认」使用默认模型。

写操作与 `/api/ai/config` 一样只允许本机。错误是中文 `HTTPException.detail`。校验失败不回显请求体，避免带出密钥。

## 模型键

`model_key = "<provider_id>/<model_id>"`，只按第一个 `/` 切开。模型 ID 可以含 `/`，例如 `prov-a1b2c3d4/google/gemini-3.5-flash`。

改模型的路径是 `/api/models/providers/{provider_id}/models/{model_id:path}`。客户端保留模型 ID 里的 `/`，只编码其余字符。

## 存储

`<数据目录>/model-library.json`。密钥只在这个文件里，`model_dump()` 和 HTTP 响应都会抹掉它。

```json
{
  "version": 1,
  "providers": [{
    "id": "prov-<8位十六进制>",
    "name": "DeepSeek",
    "preset": "deepseek",
    "base_url": "https://api.deepseek.com/v1",
    "auth_mode": "api_key",
    "api_key": "<只存后端>",
    "project_id": "",
    "location": "global",
    "enabled": true,
    "models": [{
      "id": "deepseek-flash",
      "name": "deepseek-flash",
      "enabled": true,
      "tags": { "reasoning": "none", "vision": false, "tools": true, "label": null }
    }]
  }],
  "default_model": "prov-xxxxxxxx/deepseek-flash",
  "service_models": { "logic": null, "vision": null, "memory": null }
}
```

- `preset`：`openai|deepseek|qwen|ark|moonshot|zhipu|vertex|chatgpt|custom`
- `auth_mode`：`api_key|adc|chatgpt`
- `tags.reasoning`：`none|low|medium|high`。`tags.label`：`null|"新"|"Pro"`
- 拉取列表时按模型名保守猜测；猜不出就是 `none/false`，不乱标。拉取结果不直接写入。
- `service_models.*` 为 `null` 表示沿用默认模型。
- 同一服务商更换地址时必须重新提交密钥。`api_key` 不传或为 `null` 表示保持原密钥。

没有 `model-library.json` 时，若 `ai-settings.json` 或环境变量里有有效配置，启动时生成一个服务商、一个模型，并设为默认。旧文件不删不改。

## HTTP

前缀 `/api/models`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/providers` | 服务商列表。无密钥，有 `has_api_key` 和 `models[]` |
| POST | `/providers` | `{name, preset, base_url, auth_mode, api_key?, project_id?, location?}` |
| PATCH | `/providers/{id}` | 名称、地址、认证方式、密钥、`project_id`、`location`、`enabled` |
| DELETE | `/providers/{id}` | 删除。默认模型或服务模型被牵连时置空，并返回 `affected` |
| POST | `/providers/{id}/models` | `{id, name?, tags?}` |
| PATCH | `/providers/{id}/models/{model_id}` | `{enabled?, name?, tags?}`。`tags` 只改请求里出现的字段；`label: null` 表示清除 |
| DELETE | `/providers/{id}/models/{model_id}` | 删除该模型，同样返回 `affected` |
| POST | `/providers/{id}/fetch` | 返回候选 `[{id,name,tags}]`，不写入。OpenAI 兼容为 `GET {base}/models`；ChatGPT 用现有授权；Vertex 用内置列表 |
| POST | `/providers/{id}/test` | `{model_id}`。真实调用一次，响应同 `/api/ai/test` |
| GET | `/` | 选择器列表。只含已启用服务商下的已启用模型：`{key, provider_id, provider_name, model_id, name, tags, is_default}` |
| GET/PUT | `/default` | `{key}` |
| GET/PUT | `/service` | `{logic, vision, memory}`，每项是模型键或 `null` |

删除响应：

```json
{"affected": {"default_model": false, "service_models": ["logic"]}}
```

`PUT /api/conversations/{id}/model` 的请求体是 `{model_key: string|null}`。`null` 表示回到默认。正在生成时返回 409。会话摘要和详情带只读字段 `model_key`。支线自己的 `model_key` 为空时，读取结果沿用主线。

所选模型已删除或已停用时，这一轮改用默认模型，并在 SSE 里通知一次：`start.model_notice` 和 `event: model_notice`，内容都是「原模型不可用，已改用默认模型」。同一条失效记录不重复提示。

## 进程内

`ModelLibrary.resolve(model_key)` 返回填好 `llm_*` 的 `Settings`。`model_key` 为空、或指向已删除、已停用的模型时回退到默认模型。默认也不可用时抛 `ProviderError(503)`。`effective_key` 返回实际会用的键，没有任何可用模型时返回 `None` 而不抛错。`service_settings(role)` 在该项为 `null` 时等同 `resolve(None)`。

逻辑、视觉、后台与记忆都从这里解析。话题命名和会话整理走 memory；识图走 vision。
