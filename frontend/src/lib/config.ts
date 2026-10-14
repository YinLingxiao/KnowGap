/**
 * 前端运行配置。只读取 NEXT_PUBLIC_* 变量，这些值会打包进浏览器，
 * 因此绝不能在这里放模型密钥等任何秘密信息。
 */

export type DataSource = "mock" | "api";

/** 数据来源：默认使用 Mock，后端契约接入后设置 NEXT_PUBLIC_DATA_SOURCE=api */
export const DATA_SOURCE: DataSource =
  process.env.NEXT_PUBLIC_DATA_SOURCE === "api" ? "api" : "mock";

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");

/** MVP 固定使用的演示身份（合成数据，不对应真实学生） */
export const DEMO_STUDENT_ID = "demo-student-001";

// Allow the backend's 45-second model timeout to return its own error first.
export const REQUEST_TIMEOUT_MS = 65_000;
