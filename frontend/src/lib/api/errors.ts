export type ApiErrorKind =
  | "network"
  | "timeout"
  | "model_unavailable"
  | "not_found"
  | "validation"
  | "conflict"
  | "server"
  | "contract_pending"
  | "unknown";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) return new ApiError("unknown", error.message);
  return new ApiError("unknown", "发生未知错误");
}

/** 错误发生的场景，用于给出更贴切的提示 */
export type ErrorContext = "general" | "session" | "memory";

export interface ErrorCopy {
  title: string;
  hint: string;
}

export function describeError(error: ApiError, context: ErrorContext = "general"): ErrorCopy {
  switch (error.kind) {
    case "network":
      return {
        title: "无法连接后端服务",
        hint: "请确认 FastAPI 服务已启动，并检查 NEXT_PUBLIC_API_BASE_URL 配置。你的输入已保留。",
      };
    case "timeout":
      return {
        title: "请求超时",
        hint: "响应时间过长。你的输入已保留；继续发送前请先刷新会话，核对是否已经保存。",
      };
    case "model_unavailable":
      return {
        title: "模型暂时不可用",
        hint: "后端没有拿到有效的模型结果（可能是密钥未配置或服务异常）。系统不会伪造诊断，请稍后重试。",
      };
    case "not_found":
      if (context === "session") {
        return {
          title: "会话不存在或已失效",
          hint: "后端可能已重启或会话已被清理。可以重新开始一次作答，已有的学习记忆不受影响。",
        };
      }
      if (context === "memory") {
        return { title: "这条记忆已不存在", hint: "它可能已经被删除，刷新记忆列表即可。" };
      }
      return { title: "找不到请求的内容", hint: "请刷新页面后重试。" };
    case "validation":
      return { title: "输入未通过校验", hint: "请检查输入内容后重试。" };
    case "conflict":
      return { title: "会话状态已变化", hint: "请先刷新会话核对最新记录；如果已达到轮次上限，请开启新会话。" };
    case "server":
      return { title: "服务出错了", hint: "后端处理请求时发生错误，请稍后重试。" };
    case "contract_pending":
      return {
        title: "尚未对接后端接口",
        hint: "当前为 API 模式，但前端还没有接入后端接口契约。可在 .env.local 中设置 NEXT_PUBLIC_DATA_SOURCE=mock 使用演示数据。",
      };
    default:
      return { title: "出现了意外错误", hint: "请重试；如果问题持续出现，请查看浏览器控制台。" };
  }
}
