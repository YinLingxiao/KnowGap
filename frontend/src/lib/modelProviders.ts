/**
 * 模型接入卡片用的服务商预设。只包含公开的接口地址与示例模型名，不涉及任何密钥。
 * 后端只支持兼容 OpenAI Chat Completions 且支持 JSON object 输出的服务。
 */

export type ModelProviderId = "openai" | "deepseek" | "qwen" | "ark" | "moonshot" | "zhipu" | "custom";

export interface ModelProvider {
  id: ModelProviderId;
  name: string;
  /** LLM_BASE_URL：包含版本前缀，不含 /chat/completions */
  baseUrl: string;
  /** 模型输入框的占位示例，以服务商控制台为准 */
  modelHint: string;
}

export const MODEL_PROVIDERS: ModelProvider[] = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", modelHint: "deepseek-chat" },
  { id: "qwen", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", modelHint: "qwen-plus" },
  { id: "ark", name: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", modelHint: "接入点 ID 或模型 ID" },
  { id: "moonshot", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", modelHint: "moonshot-v1-8k" },
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", modelHint: "glm-4-flash" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", modelHint: "gpt-4o-mini" },
  { id: "custom", name: "自定义", baseUrl: "", modelHint: "模型名称" },
];

export function findProvider(id: string | null | undefined): ModelProvider {
  return MODEL_PROVIDERS.find((provider) => provider.id === id) ?? MODEL_PROVIDERS[0];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** 返回地址的问题说明；空地址或格式正确时返回 null */
export function checkBaseUrl(url: string): string | null {
  const value = url.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "地址格式不正确，请以 http:// 或 https:// 开头。";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "地址需以 http:// 或 https:// 开头。";
  if (/\/chat\/completions\/?$/.test(parsed.pathname)) return "去掉末尾的 /chat/completions，后端会自动拼接。";
  return null;
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** 按接口地址找回预设；匹配不到时归为「自定义」 */
export function matchProvider(baseUrl: string): ModelProvider {
  const value = normalizeBaseUrl(baseUrl);
  return (
    MODEL_PROVIDERS.find((provider) => provider.baseUrl && provider.baseUrl === value) ??
    MODEL_PROVIDERS[MODEL_PROVIDERS.length - 1]
  );
}