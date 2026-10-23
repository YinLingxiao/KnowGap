/**
 * 模型接入卡片用的服务商预设。只包含公开的接口地址与示例模型名，不涉及任何密钥。
 * 通用服务走 OpenAI Chat Completions；Vertex Express 走原生 Gemini 接口。
 */

export type ModelProviderId = "openai" | "deepseek" | "qwen" | "ark" | "moonshot" | "zhipu" | "vertex" | "chatgpt" | "custom";

export interface ModelProvider {
  id: ModelProviderId;
  name: string;
  /** API 根地址：不含具体调用方法或模型 ID */
  baseUrl: string;
  /** 模型输入框的占位示例，以服务商控制台为准 */
  modelHint: string;
  urlHint?: string;
  keyLabel?: string;
  keyHint?: string;
}

export const MODEL_PROVIDERS: ModelProvider[] = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", modelHint: "deepseek-chat" },
  { id: "qwen", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", modelHint: "qwen-plus" },
  { id: "ark", name: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", modelHint: "接入点 ID 或模型 ID" },
  { id: "moonshot", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", modelHint: "moonshot-v1-8k" },
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", modelHint: "glm-4-flash" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", modelHint: "gpt-4o-mini" },
  {
    id: "chatgpt", name: "ChatGPT 套餐",
    baseUrl: "https://api.openai.com/v1",
    modelHint: "gpt-6.1-sol",
    urlHint: "使用 ChatGPT 登录授权，不填写 API Key；模型以账号可用列表为准。",
  },
  {
    id: "vertex", name: "Google Vertex AI",
    baseUrl: "https://aiplatform.googleapis.com/v1/publishers/google/models",
    modelHint: "gemini-4-argon",
    urlHint: "Vertex Express 原生接口，无需填写项目 ID 或区域。不要追加模型名、:generateContent 或密钥参数。",
    keyLabel: "Vertex Express API Key",
    keyHint: "填写 Vertex Express 控制台生成的 API Key，不含 Bearer 前缀。不是 OAuth Access Token 或 AI Studio API Key；模型需在该账号下可用。密钥仅通过请求头发送。",
  },
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

export function vertexAdcBaseUrl(projectId: string, location: string): string {
  const region = location.trim() || "global";
  const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(projectId.trim() || "PROJECT_ID")}/locations/${encodeURIComponent(region)}/publishers/google/models`;
}

export function checkVertexAdc(projectId: string, location: string): string | null {
  if (!/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,30})$/.test(projectId.trim())) return "请填写有效的 Google Cloud 项目 ID（不是项目显示名称）或项目编号。";
  if (!/^(?:global|[a-z]+(?:-[a-z]+)*[0-9]+)$/.test(location.trim())) return "区域请填写 global 或 us-central1 等 Google Cloud 区域 ID。";
  return null;
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
  if (isVertexHost(parsed.hostname)) {
    const native = parsed.pathname.match(/^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/?$/);
    if (native) {
      const problem = checkVertexAdc(native[1], native[2]);
      if (problem) return problem;
      if (value.replace(/\/+$/, "") !== vertexAdcBaseUrl(native[1], native[2])) return "ADC 请使用与项目、区域一致的 HTTPS 原生根地址，不附加查询参数。";
      return null;
    }
    if (parsed.pathname.startsWith("/v1/publishers/") || parsed.pathname.startsWith("/v1beta1/publishers/")) {
      if (parsed.protocol !== "https:" || parsed.hostname !== "aiplatform.googleapis.com" || (parsed.port && parsed.port !== "443")) {
        return "Vertex Express 使用 https://aiplatform.googleapis.com 全局接口，不加区域前缀。";
      }
      if (!/^\/v1(?:beta1)?\/publishers\/google\/models\/?$/.test(parsed.pathname) || parsed.search || parsed.hash || parsed.username || parsed.password) {
        return "Vertex Express 仅填写 /v1/publishers/google/models 根地址，不含模型名、调用方法或密钥参数。";
      }
      return null;
    }
    // 旧版 OAuth/OpenAI 兼容配置仍可作为自定义地址使用。
    const parts = parsed.pathname.match(/^\/v1(?:beta1)?\/projects\/([^/]+)\/locations\/([^/]+)\/endpoints\/openapi\/?$/);
    if (!parts) return "Vertex 请使用 /v1/projects/项目ID/locations/区域/endpoints/openapi 兼容接口。";
    if (/PROJECT_ID|[{}<>%]/i.test(parts[1])) return "请将 PROJECT_ID 替换为实际 Google Cloud 项目 ID。";
    const expectedHost = parts[2] === "global" ? "aiplatform.googleapis.com" : `${parts[2]}-aiplatform.googleapis.com`;
    if (parsed.hostname !== expectedHost) return "Vertex 的主机区域需与 locations 后的区域一致；global 使用 aiplatform.googleapis.com。";
  }
  return null;
}

function isVertexHost(hostname: string): boolean {
  return /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(hostname);
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** 按接口地址找回预设；匹配不到时归为「自定义」 */
export function matchProvider(baseUrl: string): ModelProvider {
  const value = normalizeBaseUrl(baseUrl);
  try {
    const url = new URL(value);
    if (isVertexHost(url.hostname) && (/^\/v1(?:beta1)?\/publishers\//.test(url.pathname)
      || /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/models/.test(url.pathname))) return findProvider("vertex");
  } catch { /* 输入未完成时按普通预设匹配。 */ }
  return (
    MODEL_PROVIDERS.find((provider) => provider.baseUrl && provider.baseUrl === value) ??
    MODEL_PROVIDERS[MODEL_PROVIDERS.length - 1]
  );
}
