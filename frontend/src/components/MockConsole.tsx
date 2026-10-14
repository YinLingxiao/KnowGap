"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, FlaskConical, RotateCcw, X } from "lucide-react";
import { cx } from "@/lib/cx";
import {
  getMockControls,
  setMockControls,
  subscribeMockControls,
  type MockFault,
} from "@/mocks/mock-controls";
import { Button } from "./ui/Button";
import styles from "./MockConsole.module.css";

const FAULTS: { value: MockFault; label: string; description: string }[] = [
  { value: "none", label: "正常响应", description: "按预设脚本返回" },
  { value: "model_unavailable", label: "模型不可用", description: "下一次诊断或对话失败" },
  { value: "timeout", label: "请求超时", description: "下一次诊断或对话超时" },
  { value: "session_not_found", label: "会话失效", description: "下一次对话找不到会话" },
  { value: "network", label: "后端离线", description: "下一次任意请求连接失败" },
];

/**
 * ⚠️ 仅在 Mock 模式下渲染：页头的「Mock 演示数据」徽章，点击展开控制台，
 * 用于演示加载与异常处理。
 */
export function MockConsole({ onReset }: { onReset: () => void }) {
  const controls = useSyncExternalStore(subscribeMockControls, getMockControls, getMockControls);
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部或按 Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="当前使用前端模拟数据，诊断与记忆均来自预设脚本。点击打开 Mock 控制台"
      >
        <FlaskConical size={14} aria-hidden />
        Mock<span className={styles.triggerExtra}> 演示数据</span>
        <ChevronDown size={13} className={cx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
        {controls.fault !== "none" && <span className={styles.armed} title="已设置一次性故障" />}
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="Mock 控制台">
          <div className={styles.head}>
            <span className={styles.headTitle}>
              <FlaskConical size={15} aria-hidden />
              Mock 控制台
            </span>
            <button className={styles.close} onClick={() => setOpen(false)} aria-label="关闭 Mock 控制台">
              <X size={14} />
            </button>
          </div>
          <p className={styles.note}>
            页面当前使用前端模拟数据，诊断与记忆均来自预设脚本。这里的设置只影响模拟数据，用于演示加载与异常处理；接入真实后端后不会显示。
          </p>

          <fieldset className={styles.group}>
            <legend>下一次请求</legend>
            {FAULTS.map((fault) => (
              <label key={fault.value} className={cx(styles.option, controls.fault === fault.value && styles.active)}>
                <input
                  type="radio"
                  name="mock-fault"
                  value={fault.value}
                  checked={controls.fault === fault.value}
                  onChange={() => setMockControls({ fault: fault.value })}
                />
                <span>
                  <span className={styles.optionLabel}>{fault.label}</span>
                  <span className={styles.optionDescription}>{fault.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={controls.latency === "realistic"}
              onChange={(event) => setMockControls({ latency: event.target.checked ? "realistic" : "instant" })}
            />
            模拟网络与模型延迟
          </label>

          <Button
            size="sm"
            variant={confirmReset ? "danger" : "secondary"}
            icon={<RotateCcw size={14} />}
            onClick={() => {
              if (!confirmReset) {
                setConfirmReset(true);
                return;
              }
              setConfirmReset(false);
              setOpen(false);
              onReset();
            }}
            onBlur={() => setConfirmReset(false)}
          >
            {confirmReset ? "再次点击确认清空" : "重置演示数据"}
          </Button>
        </div>
      )}
    </div>
  );
}
