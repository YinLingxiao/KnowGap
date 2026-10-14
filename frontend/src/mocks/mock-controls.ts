/**
 * ⚠️ MOCK —— Mock 控制台的状态，只影响前端模拟数据，
 * 用于在没有后端的情况下演示加载与异常处理。
 */

export type MockFault = "none" | "model_unavailable" | "timeout" | "session_not_found" | "network";
export type MockOperation = "health" | "problems" | "diagnosis" | "message" | "memories" | "delete";

export interface MockControls {
  /** 一次性故障：被下一次匹配的请求消费后自动恢复为 none */
  fault: MockFault;
  latency: "realistic" | "instant";
}

const APPLIES_TO: Record<Exclude<MockFault, "none">, MockOperation[] | "all"> = {
  network: "all",
  model_unavailable: ["diagnosis", "message"],
  timeout: ["diagnosis", "message"],
  session_not_found: ["message"],
};

let controls: MockControls = { fault: "none", latency: "realistic" };
const listeners = new Set<() => void>();

export function getMockControls(): MockControls {
  return controls;
}

export function setMockControls(patch: Partial<MockControls>): void {
  controls = { ...controls, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribeMockControls(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function consumeFault(operation: MockOperation): MockFault {
  const { fault } = controls;
  if (fault === "none") return "none";
  const scope = APPLIES_TO[fault];
  if (scope === "all" || scope.includes(operation)) {
    setMockControls({ fault: "none" });
    return fault;
  }
  return "none";
}
