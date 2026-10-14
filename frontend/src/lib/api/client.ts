import { createHttpClient } from "@/lib/api/http-client";
import { API_BASE_URL, DATA_SOURCE } from "@/lib/config";
import type { KnowGapClient } from "@/lib/types";
import { createMockClient } from "@/mocks/mock-client";

let instance: KnowGapClient | null = null;

/** 页面统一通过这里取数据；切换 Mock / 真实后端只需改环境变量。 */
export function getClient(): KnowGapClient {
  if (!instance) {
    instance = DATA_SOURCE === "api" ? createHttpClient(API_BASE_URL) : createMockClient();
  }
  return instance;
}
