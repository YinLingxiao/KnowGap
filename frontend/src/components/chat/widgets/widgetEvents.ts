/**
 * Events between widgets and the chat shell. Defined here rather than imported from
 * LearningWidget.tsx, because LearningWidget imports the widgets (that would be a cycle).
 */

import { createContext, useContext } from "react";

/** 当前卡片所属会话；MessageList 在外层提供。拿不到时为 null */
export const WidgetScopeContext = createContext<string | null>(null);

export function useWidgetScope(): string | null {
  return useContext(WidgetScopeContext);
}

/** Composer prefills its input with the prompt. */
export const WIDGET_ASK_EVENT = "knowgap:widget-ask";

/** 三种事件都带 conversationId：Composer 只响应自己的会话；null 仅由 acceptUnscoped 的 Composer 响应 */
export interface WidgetAskDetail {
  conversationId: string | null;
  prompt: string;
}

/**
 * Send a message directly. Optional for the shell: a listener should apply detail.effort for this turn,
 * call sendMessage(detail.text), and set detail.handled = true. Without a listener, widgets fall back to
 * prefilling the Composer; the relay text still carries the effort recommendation.
 */
export const WIDGET_SEND_EVENT = "knowgap:widget-send";

export interface WidgetSendDetail {
  conversationId: string | null;
  text: string;
  /** Per-turn reasoning effort recommended by the vision router. */
  effort?: "low" | "medium" | "high";
  handled: boolean;
}

export function askInComposer(conversationId: string | null, prompt: string): void {
  window.dispatchEvent(new CustomEvent<WidgetAskDetail>(WIDGET_ASK_EVENT, { detail: { conversationId, prompt } }));
}

/** dispatchEvent runs listeners synchronously, so `handled` is known when it returns. */
export function sendOrAsk(conversationId: string | null, text: string, effort?: "low" | "medium" | "high"): "sent" | "prefilled" {
  const detail: WidgetSendDetail = { conversationId, text, effort, handled: false };
  window.dispatchEvent(new CustomEvent<WidgetSendDetail>(WIDGET_SEND_EVENT, { detail }));
  if (detail.handled) return "sent";
  askInComposer(conversationId, text);
  return "prefilled";
}

/** Send a message to the open conversation right away. Composer sets detail.handled when it accepted it (it is idle). */
export const WIDGET_AUTOSEND_EVENT = "knowgap:widget-autosend";

export interface WidgetAutoSendDetail {
  conversationId: string | null;
  text: string;
  handled: boolean;
}

export function sendNow(conversationId: string | null, text: string): "sent" | "prefilled" {
  const detail: WidgetAutoSendDetail = { conversationId, text, handled: false };
  window.dispatchEvent(new CustomEvent<WidgetAutoSendDetail>(WIDGET_AUTOSEND_EVENT, { detail }));
  if (detail.handled) return "sent";
  askInComposer(conversationId, text);
  return "prefilled";
}
