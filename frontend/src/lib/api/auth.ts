import { API_BASE_URL, DEMO_STUDENT_ID } from "@/lib/config";
import { request } from "@/lib/api/http-client";

export const USER_KEY = "knowgap.auth.user.v1";

export interface AuthUser {
  id: string;
  displayName: string;
  avatarText: string;
  avatarUrl: string;
  createdAt: string;
}

export const DEMO_USER: AuthUser = {
  id: DEMO_STUDENT_ID,
  displayName: "学习者",
  avatarText: "学",
  avatarUrl: "",
  createdAt: "",
};

type RawProfile = {
  id: string;
  display_name: string;
  avatar_text: string;
  avatar_url?: string;
  created_at?: string;
};

export function resolveAvatarUrl(raw?: string): string {
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("blob:") || raw.startsWith("data:")) {
    return raw;
  }
  return `${API_BASE_URL}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

function mapUser(data: RawProfile): AuthUser {
  const name = data.display_name || "学习者";
  return {
    id: data.id,
    displayName: name,
    avatarText: data.avatar_text || name.slice(0, 1) || "学",
    avatarUrl: resolveAvatarUrl(data.avatar_url),
    createdAt: data.created_at ?? "",
  };
}

export async function fetchMe(): Promise<AuthUser> {
  const data = await request<{ user: RawProfile }>(API_BASE_URL, "/api/profile", { cache: "no-store" });
  return mapUser(data.user);
}

export async function updateDisplayName(displayName: string): Promise<AuthUser> {
  const data = await request<{ user: RawProfile }>(API_BASE_URL, "/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ display_name: displayName }),
  });
  return mapUser(data.user);
}

export async function uploadAvatar(file: File): Promise<AuthUser> {
  const form = new FormData();
  form.append("file", file);
  const data = await request<{ user: RawProfile }>(API_BASE_URL, "/api/profile/avatar", {
    method: "POST",
    body: form,
  });
  return mapUser(data.user);
}

export async function deleteAvatar(): Promise<AuthUser> {
  const data = await request<{ user: RawProfile }>(API_BASE_URL, "/api/profile/avatar", {
    method: "DELETE",
  });
  return mapUser(data.user);
}
