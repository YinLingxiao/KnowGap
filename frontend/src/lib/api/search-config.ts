/**
 * 联网搜索（AnySearch）密钥接口。密钥只随 PUT / POST 发到本机后端，后端永不回传；
 * 这里不缓存、不持久化，状态只有「是否已配置」和来源。
 */
import { API_BASE_URL } from "../config";
import { request } from "./http-client";

export type SearchKeySource = "saved" | "environment" | "none";

export interface SearchKeyStatus {
  hasKey: boolean;
  /** saved：设置页保存的；environment：环境变量或 .env；none：未配置，使用匿名额度 */
  source: SearchKeySource;
}

interface WireStatus {
  has_key: boolean;
  source: SearchKeySource;
}

function mapStatus(data: WireStatus): SearchKeyStatus {
  return { hasKey: data.has_key, source: data.source };
}

export async function getSearchKeyStatus(): Promise<SearchKeyStatus> {
  return mapStatus(await request<WireStatus>(API_BASE_URL, "/api/search/config", { cache: "no-store" }));
}

/** 空字符串表示清除设置页保存的密钥，回到环境变量或匿名额度 */
export async function saveSearchKey(apiKey: string): Promise<SearchKeyStatus> {
  return mapStatus(await request<WireStatus>(API_BASE_URL, "/api/search/config", {
    method: "PUT", body: JSON.stringify({ anysearch_api_key: apiKey.trim() }),
  }));
}

/** 用填写的密钥搜一次，不保存；没填则测当前生效的密钥。会消耗 1 次搜索额度 */
export async function testSearchKey(apiKey: string): Promise<{ results: number }> {
  const key = apiKey.trim();
  const data = await request<{ status: string; results: number }>(API_BASE_URL, "/api/search/test", {
    method: "POST", body: JSON.stringify(key ? { anysearch_api_key: key } : {}),
  });
  return { results: data.results };
}
