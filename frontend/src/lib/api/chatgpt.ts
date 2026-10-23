/** ChatGPT plan OAuth endpoints. Tokens never reach this client. */
import { API_BASE_URL } from "../config";
import { request } from "./http-client";
import type { ChatGPTStatus } from "./ai-config";

interface WireStatus {
  connected: boolean; email: string; plan_enabled: boolean; reauth_required: boolean;
  expires_at: number; accounts: Array<{ client_id: string; email: string; active: boolean }>; error: string;
}

function mapStatus(data: WireStatus): ChatGPTStatus {
  return {
    connected: data.connected, email: data.email, planEnabled: data.plan_enabled,
    reauthRequired: data.reauth_required, expiresAt: data.expires_at, error: data.error ?? "",
    accounts: (data.accounts ?? []).map((item) => ({ clientId: item.client_id, email: item.email, active: item.active })),
  };
}

export async function startChatGPT(): Promise<{ authorizeUrl: string; expiresIn: number }> {
  const data = await request<{ authorize_url: string; expires_in: number }>(
    API_BASE_URL, "/api/chatgpt/start", { method: "POST", body: "{}" });
  return { authorizeUrl: data.authorize_url, expiresIn: data.expires_in };
}

export async function getChatGPTStatus(): Promise<ChatGPTStatus> {
  return mapStatus(await request<WireStatus>(API_BASE_URL, "/api/chatgpt/status", { cache: "no-store" }));
}

export async function logoutChatGPT(): Promise<{ revoked: boolean; warning: string }> {
  return request(API_BASE_URL, "/api/chatgpt/logout", { method: "POST", body: "{}" });
}

export async function listChatGPTModels(): Promise<Array<{ id: string; name: string }>> {
  const data = await request<{ models: Array<{ id: string; name: string }> }>(API_BASE_URL, "/api/chatgpt/models");
  return data.models;
}
