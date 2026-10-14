/**
 * 本机演示用的模型配置接口（契约见 docs/ai-config-api.md）。
 * 密钥只随 PUT / POST 请求发到本机后端，后端永不回传；这里不缓存、不持久化任何密钥。
 */
import { API_BASE_URL } from "../config";
import { request } from "./http-client";

interface WireAIConfig {
  base_url: string;
  model: string;
  has_api_key: boolean;
  configured: boolean;
}

export interface AIConfigStatus {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  /** 必填项已填写；不代表已通过连接测试 */
  configured: boolean;
}

export interface AIConfigInput {
  baseUrl: string;
  model: string;
  /** 留空：同一服务地址下保留后端已保存的密钥 */
  apiKey: string;
}

export interface AIConfigTestResult {
  model: string;
  structuredOutput: boolean;
}

function mapStatus(data: WireAIConfig): AIConfigStatus {
  return { baseUrl: data.base_url, model: data.model, hasApiKey: data.has_api_key, configured: data.configured };
}

function toWire(input: AIConfigInput) {
  const apiKey = input.apiKey.trim();
  return JSON.stringify({
    base_url: input.baseUrl.trim(),
    model: input.model.trim(),
    ...(apiKey ? { api_key: apiKey } : {}),
  });
}

export async function getAIConfig(): Promise<AIConfigStatus> {
  return mapStatus(await request<WireAIConfig>(API_BASE_URL, "/api/ai/config", { cache: "no-store" }));
}

export async function saveAIConfig(input: AIConfigInput): Promise<AIConfigStatus> {
  return mapStatus(await request<WireAIConfig>(API_BASE_URL, "/api/ai/config", { method: "PUT", body: toWire(input) }));
}

/** 用当前填写的值调用一次模型；不保存配置。可能消耗服务商额度 */
export async function testAIConfig(input: AIConfigInput): Promise<AIConfigTestResult> {
  const data = await request<{ status: string; model: string; structured_output: boolean }>(
    API_BASE_URL, "/api/ai/test", { method: "POST", body: toWire(input) },
  );
  return { model: data.model, structuredOutput: data.structured_output };
}
