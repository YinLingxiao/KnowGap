/**
 * 模型库契约。字段在这里做 camelCase 映射；密钥只出现在发往后端的请求体里，响应类型没有密钥。
 * 模型键按第一个 "/" 拆分。模型路径使用 encodeModelId，对应后端 {model_id:path}。
 */
import { API_BASE_URL } from "../config";
import { ApiError } from "./errors";
import { request } from "./http-client";

export type ProviderPreset = "openai" | "deepseek" | "qwen" | "ark" | "moonshot" | "zhipu" | "vertex" | "chatgpt" | "custom";
export type AuthMode = "api_key" | "adc" | "chatgpt";
export type ReasoningLevel = "none" | "low" | "medium" | "high";
export type ModelLabel = "新" | "Pro";
export type ServiceRole = "logic" | "vision" | "memory";

export interface ModelTags {
  reasoning: ReasoningLevel;
  vision: boolean;
  tools: boolean;
  label: ModelLabel | null;
}

export const EMPTY_TAGS: ModelTags = { reasoning: "none", vision: false, tools: false, label: null };

export interface LibraryModel {
  id: string;
  name: string;
  enabled: boolean;
  tags: ModelTags;
}

export interface ProviderPublic {
  id: string;
  name: string;
  preset: ProviderPreset;
  baseUrl: string;
  authMode: AuthMode;
  hasApiKey: boolean;
  projectId: string;
  location: string;
  enabled: boolean;
  models: LibraryModel[];
}

export interface CatalogModel {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  tags: ModelTags;
  isDefault: boolean;
}

export interface ModelCandidate {
  id: string;
  name: string;
  tags: ModelTags;
}

export interface ServiceModelSelection {
  logic: string | null;
  vision: string | null;
  memory: string | null;
}

export interface AffectedRefs {
  defaultModel: boolean;
  serviceModels: ServiceRole[];
}

export interface DeleteProviderResult {
  affected: AffectedRefs;
}

export interface DefaultModelState {
  key: string | null;
}

export interface ConversationModelState {
  modelKey: string | null;
}

export interface ModelTestResult {
  model: string;
  structuredOutput: boolean;
}

export interface CreateProviderInput {
  name: string;
  preset: ProviderPreset;
  baseUrl: string;
  authMode: AuthMode;
  apiKey?: string;
  projectId?: string;
  location?: string;
}

export interface UpdateProviderInput {
  name?: string;
  baseUrl?: string;
  authMode?: AuthMode;
  apiKey?: string;
  projectId?: string;
  location?: string;
  enabled?: boolean;
}

export interface CreateModelInput {
  id: string;
  name?: string;
  tags?: Partial<ModelTags>;
}

export interface UpdateModelInput {
  enabled?: boolean;
  name?: string;
  tags?: Partial<ModelTags>;
}

export interface ModelLibraryClient {
  listProviders(): Promise<ProviderPublic[]>;
  createProvider(input: CreateProviderInput): Promise<ProviderPublic>;
  updateProvider(id: string, input: UpdateProviderInput): Promise<ProviderPublic>;
  deleteProvider(id: string): Promise<DeleteProviderResult>;
  createModel(providerId: string, input: CreateModelInput): Promise<LibraryModel>;
  updateModel(providerId: string, modelId: string, input: UpdateModelInput): Promise<LibraryModel>;
  deleteModel(providerId: string, modelId: string): Promise<void>;
  fetchModels(providerId: string): Promise<ModelCandidate[]>;
  testModel(providerId: string, modelId: string): Promise<ModelTestResult>;
  listSelectableModels(): Promise<CatalogModel[]>;
  getDefaultModel(): Promise<DefaultModelState>;
  setDefaultModel(key: string): Promise<DefaultModelState>;
  getServiceModels(): Promise<ServiceModelSelection>;
  setServiceModels(input: ServiceModelSelection): Promise<ServiceModelSelection>;
  setConversationModel(conversationId: string, modelKey: string | null): Promise<ConversationModelState>;
}

export const MODELS_CHANGED_EVENT = "knowgap:models-changed";

const ROOT = "/api/models";
const PRESETS = new Set<ProviderPreset>(["openai", "deepseek", "qwen", "ark", "moonshot", "zhipu", "vertex", "chatgpt", "custom"]);
const AUTH_MODES = new Set<AuthMode>(["api_key", "adc", "chatgpt"]);
const ROLES: ServiceRole[] = ["logic", "vision", "memory"];
const FETCH_SAMPLES: Partial<Record<ProviderPreset, readonly string[]>> = {
  openai: ["gpt-4o-mini"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  qwen: ["qwen-plus"],
  moonshot: ["moonshot-v1-8k"],
  zhipu: ["glm-4-flash"],
  vertex: ["gemini-4-argon"],
  chatgpt: ["gpt-6.1-sol"],
};

export function modelKey(providerId: string, modelId: string): string {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (!provider || !model || provider.includes("/")) {
    throw new Error("服务商 ID 不能为空或包含“/”，模型 ID 也不能为空。");
  }
  return `${provider}/${model}`;
}

export function parseModelKey(key: string): { providerId: string; modelId: string } {
  const text = key.trim();
  const slash = text.indexOf("/");
  if (slash <= 0 || slash >= text.length - 1) throw new Error("模型键必须是“服务商 ID/模型 ID”。");
  return { providerId: text.slice(0, slash).trim(), modelId: text.slice(slash + 1).trim() };
}

/** 保留模型 ID 里的 "/"，其余字符按路径段编码。后端路由使用 {model_id:path}。 */
export function encodeModelId(modelId: string): string {
  return modelId.split("/").map((part) => encodeURIComponent(part)).join("/");
}

interface WireTags {
  reasoning: ReasoningLevel;
  vision: boolean;
  tools: boolean;
  label: ModelLabel | null;
}
interface WireModel {
  id: string;
  name: string;
  enabled: boolean;
  tags: WireTags;
}
interface WireProvider {
  id: string;
  name: string;
  preset: ProviderPreset;
  base_url: string;
  auth_mode: AuthMode;
  has_api_key: boolean;
  project_id: string;
  location: string;
  enabled: boolean;
  models: WireModel[];
}
interface WireCatalog {
  key: string;
  provider_id: string;
  provider_name: string;
  model_id: string;
  name: string;
  tags: WireTags;
  is_default: boolean;
}
interface WireCandidate {
  id: string;
  name: string;
  tags: WireTags;
}
interface WireAffected {
  affected: { default_model: boolean; service_models: ServiceRole[] };
}

function mapTags(data: WireTags): ModelTags {
  return { reasoning: data.reasoning ?? "none", vision: Boolean(data.vision), tools: Boolean(data.tools), label: data.label ?? null };
}

function copyTags(tags: ModelTags): ModelTags {
  return { reasoning: tags.reasoning, vision: tags.vision, tools: tags.tools, label: tags.label };
}

function mapModel(data: WireModel): LibraryModel {
  return { id: data.id, name: data.name, enabled: data.enabled, tags: mapTags(data.tags) };
}

function mapProvider(data: WireProvider): ProviderPublic {
  return {
    id: data.id, name: data.name, preset: data.preset, baseUrl: data.base_url, authMode: data.auth_mode,
    hasApiKey: data.has_api_key, projectId: data.project_id ?? "", location: data.location ?? "global",
    enabled: data.enabled, models: (data.models ?? []).map(mapModel),
  };
}

function mapCatalog(data: WireCatalog): CatalogModel {
  return {
    key: data.key, providerId: data.provider_id, providerName: data.provider_name, modelId: data.model_id,
    name: data.name, tags: mapTags(data.tags), isDefault: data.is_default,
  };
}

function tagsWire(tags: Partial<ModelTags>): Partial<WireTags> {
  const wire: Partial<WireTags> = {};
  if (tags.reasoning !== undefined) wire.reasoning = tags.reasoning;
  if (tags.vision !== undefined) wire.vision = tags.vision;
  if (tags.tools !== undefined) wire.tools = tags.tools;
  if ("label" in tags) wire.label = tags.label ?? null;
  return wire;
}

function call<T>(path: string, method?: string, body?: unknown): Promise<T> {
  return request<T>(API_BASE_URL, path, {
    cache: "no-store",
    ...(method ? { method } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function providerPath(id: string): string {
  return `${ROOT}/providers/${encodeURIComponent(id)}`;
}

function modelPath(providerId: string, modelId: string): string {
  return `${providerPath(providerId)}/models/${encodeModelId(modelId)}`;
}

export const modelLibraryApi: ModelLibraryClient = {
  async listProviders() {
    return (await call<WireProvider[]>(`${ROOT}/providers`)).map(mapProvider);
  },
  async createProvider(input) {
    return mapProvider(await call<WireProvider>(`${ROOT}/providers`, "POST", {
      name: input.name.trim(), preset: input.preset, base_url: input.baseUrl.trim(), auth_mode: input.authMode,
      ...(input.apiKey !== undefined ? { api_key: input.apiKey } : {}),
      ...(input.projectId !== undefined ? { project_id: input.projectId } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
    }));
  },
  async updateProvider(id, input) {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name.trim();
    if (input.baseUrl !== undefined) body.base_url = input.baseUrl.trim();
    if (input.authMode !== undefined) body.auth_mode = input.authMode;
    if (typeof input.apiKey === "string") body.api_key = input.apiKey;
    if (input.projectId !== undefined) body.project_id = input.projectId;
    if (input.location !== undefined) body.location = input.location;
    if (input.enabled !== undefined) body.enabled = input.enabled;
    return mapProvider(await call<WireProvider>(providerPath(id), "PATCH", body));
  },
  async deleteProvider(id) {
    const data = await call<WireAffected>(providerPath(id), "DELETE");
    return { affected: { defaultModel: Boolean(data.affected?.default_model), serviceModels: data.affected?.service_models ?? [] } };
  },
  async createModel(providerId, input) {
    return mapModel(await call<WireModel>(`${providerPath(providerId)}/models`, "POST", {
      id: input.id.trim(),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.tags ? { tags: tagsWire(input.tags) } : {}),
    }));
  },
  async updateModel(providerId, modelId, input) {
    const body: Record<string, unknown> = {};
    if (input.enabled !== undefined) body.enabled = input.enabled;
    if (input.name !== undefined) body.name = input.name;
    if (input.tags) body.tags = tagsWire(input.tags);
    return mapModel(await call<WireModel>(modelPath(providerId, modelId), "PATCH", body));
  },
  async deleteModel(providerId, modelId) {
    await call(modelPath(providerId, modelId), "DELETE");
  },
  async fetchModels(providerId) {
    const data = await call<WireCandidate[]>(`${providerPath(providerId)}/fetch`, "POST");
    return data.map((item) => ({ id: item.id, name: item.name, tags: mapTags(item.tags) }));
  },
  async testModel(providerId, modelId) {
    const data = await call<{ model: string; structured_output: boolean }>(`${providerPath(providerId)}/test`, "POST", { model_id: modelId });
    return { model: data.model, structuredOutput: data.structured_output };
  },
  async listSelectableModels() {
    return (await call<WireCatalog[]>(ROOT)).map(mapCatalog);
  },
  async getDefaultModel() {
    const data = await call<{ key: string | null }>(`${ROOT}/default`);
    return { key: data.key ?? null };
  },
  async setDefaultModel(key) {
    const data = await call<{ key: string | null }>(`${ROOT}/default`, "PUT", { key });
    return { key: data.key ?? null };
  },
  async getServiceModels() {
    const data = await call<ServiceModelSelection>(`${ROOT}/service`);
    return { logic: data.logic ?? null, vision: data.vision ?? null, memory: data.memory ?? null };
  },
  async setServiceModels(input) {
    const data = await call<ServiceModelSelection>(`${ROOT}/service`, "PUT", {
      logic: input.logic, vision: input.vision, memory: input.memory,
    });
    return { logic: data.logic ?? null, vision: data.vision ?? null, memory: data.memory ?? null };
  },
  async setConversationModel(conversationId, key) {
    const data = await call<{ model_key: string | null }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/model`, "PUT", { model_key: key },
    );
    return { modelKey: data.model_key ?? null };
  },
};

interface StoredProvider {
  id: string;
  name: string;
  preset: ProviderPreset;
  baseUrl: string;
  authMode: AuthMode;
  apiKey: string;
  projectId: string;
  location: string;
  enabled: boolean;
  models: LibraryModel[];
}

interface MockState {
  providers: StoredProvider[];
  defaultModel: string | null;
  serviceModels: ServiceModelSelection;
  conversations: Map<string, string | null>;
}

export interface MockModelSeed {
  id: string;
  name?: string;
  enabled?: boolean;
  tags?: Partial<ModelTags>;
}

export interface MockProviderSeed extends CreateProviderInput {
  id?: string;
  enabled?: boolean;
  models?: MockModelSeed[];
}

export interface MockLibrarySeed {
  providers?: MockProviderSeed[];
  defaultModel?: string | null;
  serviceModels?: Partial<ServiceModelSelection>;
}

function fail(status: number, message: string): never {
  const kind = status === 404 ? "not_found" : status === 409 ? "conflict" : status === 422 ? "validation" : "server";
  throw new ApiError(kind, message, status);
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function tagsFrom(input?: Partial<ModelTags>): ModelTags {
  return {
    reasoning: input?.reasoning ?? "none",
    vision: input?.vision ?? false,
    tools: input?.tools ?? false,
    label: input && "label" in input ? input.label ?? null : null,
  };
}

function mergeTags(current: ModelTags, patch?: Partial<ModelTags>): ModelTags {
  if (!patch) return copyTags(current);
  return {
    reasoning: patch.reasoning ?? current.reasoning,
    vision: patch.vision ?? current.vision,
    tools: patch.tools ?? current.tools,
    label: "label" in patch ? patch.label ?? null : current.label,
  };
}

function copyModel(model: LibraryModel): LibraryModel {
  return { id: model.id, name: model.name, enabled: model.enabled, tags: copyTags(model.tags) };
}

function toPublic(provider: StoredProvider): ProviderPublic {
  return {
    id: provider.id, name: provider.name, preset: provider.preset, baseUrl: provider.baseUrl,
    authMode: provider.authMode, hasApiKey: provider.apiKey.trim().length > 0, projectId: provider.projectId,
    location: provider.location, enabled: provider.enabled, models: provider.models.map(copyModel),
  };
}

function newProviderId(used: Set<string>): string {
  const bytes = new Uint8Array(4);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    const id = `prov-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (!used.has(id)) return id;
  }
  fail(503, "暂时无法分配服务商 ID，请重试。");
}

function mustProvider(state: MockState, id: string): StoredProvider {
  const found = state.providers.find((item) => item.id === id);
  if (!found) fail(404, "找不到这个服务商。");
  return found;
}

function mustModel(provider: StoredProvider, modelId: string): LibraryModel {
  const found = provider.models.find((item) => item.id === modelId);
  if (!found) fail(404, "找不到这个模型。");
  return found;
}

function keyMatches(key: string | null, providerId: string): boolean {
  if (!key) return false;
  try {
    return parseModelKey(key).providerId === providerId;
  } catch {
    return false;
  }
}

function clearProviderRefs(state: MockState, providerId: string): AffectedRefs {
  const affected: AffectedRefs = { defaultModel: false, serviceModels: [] };
  if (keyMatches(state.defaultModel, providerId)) {
    state.defaultModel = null;
    affected.defaultModel = true;
  }
  for (const role of ROLES) {
    if (keyMatches(state.serviceModels[role], providerId)) {
      state.serviceModels[role] = null;
      affected.serviceModels.push(role);
    }
  }
  for (const [conversationId, key] of state.conversations) {
    if (keyMatches(key, providerId)) state.conversations.set(conversationId, null);
  }
  return affected;
}

function requireSelectable(state: MockState, key: string): string {
  const parsed = parseModelKey(key);
  const provider = mustProvider(state, parsed.providerId);
  const model = mustModel(provider, parsed.modelId);
  if (!provider.enabled || !model.enabled) fail(422, "这个模型未启用。");
  return modelKey(provider.id, model.id);
}

function requireExisting(state: MockState, key: string | null): string | null {
  if (key === null) return null;
  const parsed = parseModelKey(key);
  const provider = mustProvider(state, parsed.providerId);
  const model = mustModel(provider, parsed.modelId);
  return modelKey(provider.id, model.id);
}

function addProvider(state: MockState, input: CreateProviderInput & { id?: string; enabled?: boolean }): StoredProvider {
  const name = input.name.trim();
  const baseUrl = normalizeUrl(input.baseUrl);
  if (!name) fail(422, "请填写服务商名称。");
  if (!baseUrl) fail(422, "请填写服务地址。");
  if (!PRESETS.has(input.preset)) fail(422, "不支持这个服务商预设。");
  if (!AUTH_MODES.has(input.authMode)) fail(422, "不支持这个认证方式。");
  const submitted = input.apiKey?.trim() ?? "";
  if (input.authMode === "api_key" && !submitted) fail(422, "API Key 模式需要填写密钥。");
  if (input.id !== undefined && !/^prov-[0-9a-f]{8}$/.test(input.id)) fail(422, "服务商 ID 无效。");
  const provider: StoredProvider = {
    id: input.id ?? newProviderId(new Set(state.providers.map((item) => item.id))),
    name, preset: input.preset, baseUrl, authMode: input.authMode,
    apiKey: input.authMode === "api_key" ? submitted : "",
    projectId: input.projectId?.trim() ?? "", location: input.location?.trim() || "global",
    enabled: input.enabled ?? true, models: [],
  };
  if (state.providers.some((item) => item.id === provider.id)) fail(409, "服务商 ID 已存在。");
  state.providers.push(provider);
  return provider;
}

function addModel(provider: StoredProvider, input: CreateModelInput & { enabled?: boolean }): LibraryModel {
  const id = input.id.trim();
  if (!id || id.length > 200) fail(422, "模型 ID 无效。");
  if (provider.models.some((item) => item.id === id)) fail(409, "这个服务商下已经有相同的模型。");
  const name = input.name?.trim() || id;
  if (name.length > 200) fail(422, "名称无效。");
  const model: LibraryModel = { id, name, enabled: input.enabled ?? true, tags: tagsFrom(input.tags) };
  provider.models.push(model);
  return model;
}

export function createMockModelLibrary(seed?: MockLibrarySeed): ModelLibraryClient {
  const state: MockState = {
    providers: [], defaultModel: null, conversations: new Map(),
    serviceModels: { logic: null, vision: null, memory: null },
  };
  for (const item of seed?.providers ?? []) {
    const provider = addProvider(state, item);
    for (const model of item.models ?? []) addModel(provider, model);
  }
  if (seed?.defaultModel) state.defaultModel = requireSelectable(state, seed.defaultModel);
  if (seed?.serviceModels) {
    state.serviceModels = {
      logic: requireExisting(state, seed.serviceModels.logic ?? null),
      vision: requireExisting(state, seed.serviceModels.vision ?? null),
      memory: requireExisting(state, seed.serviceModels.memory ?? null),
    };
  }
  return {
    async listProviders() {
      return state.providers.map(toPublic);
    },
    async createProvider(input) {
      return toPublic(addProvider(state, input));
    },
    async updateProvider(id, input) {
      const provider = mustProvider(state, id);
      const nextAuth = input.authMode ?? provider.authMode;
      const nextUrl = input.baseUrl !== undefined ? normalizeUrl(input.baseUrl) : provider.baseUrl;
      if (input.name !== undefined && !input.name.trim()) fail(422, "请填写服务商名称。");
      if (input.baseUrl !== undefined && !nextUrl) fail(422, "请填写服务地址。");
      if (input.authMode !== undefined && !AUTH_MODES.has(input.authMode)) fail(422, "不支持这个认证方式。");
      const submitted = typeof input.apiKey === "string" ? input.apiKey.trim() : undefined;
      const urlChanged = nextUrl !== provider.baseUrl;
      if (nextAuth === "api_key" && urlChanged && !submitted) fail(422, "更换服务地址时需要重新填写密钥。");
      if (nextAuth === "api_key" && submitted === undefined && !provider.apiKey) fail(422, "API Key 模式需要填写密钥。");
      if (input.name !== undefined) provider.name = input.name.trim();
      provider.baseUrl = nextUrl;
      provider.authMode = nextAuth;
      if (nextAuth !== "api_key") provider.apiKey = "";
      else if (submitted !== undefined) provider.apiKey = submitted;
      if (input.projectId !== undefined) provider.projectId = input.projectId.trim();
      if (input.location !== undefined) provider.location = input.location.trim() || "global";
      if (input.enabled !== undefined) provider.enabled = input.enabled;
      return toPublic(provider);
    },
    async deleteProvider(id) {
      const index = state.providers.findIndex((item) => item.id === id);
      if (index < 0) fail(404, "找不到这个服务商。");
      state.providers.splice(index, 1);
      return { affected: clearProviderRefs(state, id) };
    },
    async createModel(providerId, input) {
      return copyModel(addModel(mustProvider(state, providerId), input));
    },
    async updateModel(providerId, modelId, input) {
      const model = mustModel(mustProvider(state, providerId), modelId);
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name || name.length > 200) fail(422, "名称无效。");
        model.name = name;
      }
      if (input.enabled !== undefined) model.enabled = input.enabled;
      if (input.tags) model.tags = mergeTags(model.tags, input.tags);
      return copyModel(model);
    },
    async deleteModel(providerId, modelId) {
      const provider = mustProvider(state, providerId);
      const index = provider.models.findIndex((item) => item.id === modelId);
      if (index < 0) fail(404, "找不到这个模型。");
      provider.models.splice(index, 1);
    },
    async fetchModels(providerId) {
      const provider = mustProvider(state, providerId);
      if (provider.authMode === "api_key" && !provider.apiKey) fail(422, "请先填写密钥再拉取模型。");
      return (FETCH_SAMPLES[provider.preset] ?? []).map((id) => ({ id, name: id, tags: copyTags(EMPTY_TAGS) }));
    },
    async testModel(providerId, modelId) {
      const provider = mustProvider(state, providerId);
      const id = modelId.trim();
      if (!id) fail(422, "模型 ID 无效。");
      if (provider.authMode === "api_key" && !provider.apiKey) fail(422, "API Key 模式需要填写密钥。");
      return { model: id, structuredOutput: true };
    },
    async listSelectableModels() {
      const items: CatalogModel[] = [];
      for (const provider of state.providers) {
        if (!provider.enabled) continue;
        for (const model of provider.models) {
          if (!model.enabled) continue;
          const key = modelKey(provider.id, model.id);
          items.push({
            key, providerId: provider.id, providerName: provider.name, modelId: model.id,
            name: model.name, tags: copyTags(model.tags), isDefault: key === state.defaultModel,
          });
        }
      }
      return items;
    },
    async getDefaultModel() {
      return { key: state.defaultModel };
    },
    async setDefaultModel(key) {
      state.defaultModel = requireSelectable(state, key);
      return { key: state.defaultModel };
    },
    async getServiceModels() {
      return { ...state.serviceModels };
    },
    async setServiceModels(input) {
      state.serviceModels = {
        logic: requireExisting(state, input.logic),
        vision: requireExisting(state, input.vision),
        memory: requireExisting(state, input.memory),
      };
      return { ...state.serviceModels };
    },
    async setConversationModel(conversationId, key) {
      const stored = key === null ? null : requireSelectable(state, key);
      state.conversations.set(conversationId, stored);
      return { modelKey: stored };
    },
  };
}
