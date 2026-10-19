import { API_BASE_URL, DEMO_STUDENT_ID } from "@/lib/config";
import { AUTH_TOKEN_KEY, request } from "@/lib/api/http-client";

export const TOKEN_KEY = AUTH_TOKEN_KEY;
export const MODE_KEY = "knowgap.auth.mode.v1";
export const USER_KEY = "knowgap.auth.user.v1";
export const DEMO_NAME_KEY = "knowgap.auth.demo.name.v1";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  avatarText: string;
  avatarUrl: string;
  provider: "email" | "demo" | "";
  createdAt: string;
}

export const DEMO_USER: AuthUser = {
  id: DEMO_STUDENT_ID,
  username: "demo@local",
  displayName: "演示学习者",
  avatarText: "演",
  avatarUrl: "",
  provider: "demo",
  createdAt: "",
};

export function readToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

type RawUser = {
  id: string;
  username: string;
  display_name: string;
  avatar_text: string;
  avatar_url?: string;
  provider?: string;
  created_at: string;
};

function mapUser(data: RawUser): AuthUser {
  return {
    id: data.id,
    username: data.username,
    displayName: data.display_name,
    avatarText: data.avatar_text || data.display_name.slice(0, 1),
    avatarUrl: data.avatar_url ?? "",
    provider: "email",
    createdAt: data.created_at,
  };
}

export interface SendCodeResult {
  sent: boolean;
  delivery: "smtp" | "demo";
  demoCode?: string;
  expiresIn: number;
}

export async function sendEmailCode(email: string, purpose: "register" | "login"): Promise<SendCodeResult> {
  const data = await request<{ sent: boolean; delivery: "smtp" | "demo"; demo_code?: string; expires_in: number }>(
    API_BASE_URL,
    "/api/auth/send-code",
    {
      method: "POST",
      body: JSON.stringify({ email: email.trim(), purpose }),
    },
  );
  return {
    sent: Boolean(data.sent),
    delivery: data.delivery === "smtp" ? "smtp" : "demo",
    demoCode: data.demo_code,
    expiresIn: data.expires_in ?? 300,
  };
}

export async function registerByEmail(
  email: string,
  password: string,
  displayName: string,
  code: string,
): Promise<{ token: string; user: AuthUser }> {
  const data = await request<{ token: string; user: RawUser }>(API_BASE_URL, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email: email.trim(),
      password,
      code: code.trim(),
      display_name: displayName.trim(),
    }),
  });
  return { token: data.token, user: mapUser(data.user) };
}

export async function loginByEmail(
  email: string,
  credential: { password?: string; code?: string },
): Promise<{ token: string; user: AuthUser }> {
  const data = await request<{ token: string; user: RawUser }>(API_BASE_URL, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: email.trim(),
      ...(credential.code ? { code: credential.code.trim() } : { password: credential.password ?? "" }),
    }),
  });
  return { token: data.token, user: mapUser(data.user) };
}

export async function fetchMe(): Promise<AuthUser> {
  const data = await request<{ user: RawUser }>(API_BASE_URL, "/api/auth/me", { cache: "no-store" });
  return mapUser(data.user);
}

export async function updateDisplayName(displayName: string): Promise<AuthUser> {
  const data = await request<{ user: RawUser }>(API_BASE_URL, "/api/auth/me", {
    method: "PATCH",
    body: JSON.stringify({ display_name: displayName }),
  });
  return mapUser(data.user);
}

export async function updatePassword(currentPassword: string, newPassword: string): Promise<AuthUser> {
  const data = await request<{ user: RawUser }>(API_BASE_URL, "/api/auth/me", {
    method: "PATCH",
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  return mapUser(data.user);
}

export async function logoutRequest(): Promise<void> {
  await request(API_BASE_URL, "/api/auth/logout", { method: "POST" });
}
