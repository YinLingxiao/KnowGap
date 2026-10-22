/**
 * Events between widgets and the chat shell. Defined here rather than imported from
 * LearningWidget.tsx, because LearningWidget imports the widgets (that would be a cycle).
 */

/** Same value as WIDGET_ASK_EVENT in LearningWidget.tsx: Composer prefills its input with the prompt. */
export const WIDGET_ASK_EVENT = "knowgap:widget-ask";

/**
 * Send a message directly. Optional for the shell: a listener should apply detail.effort for this turn,
 * call sendMessage(detail.text), and set detail.handled = true. Without a listener, widgets fall back to
 * prefilling the Composer; the relay text still carries the effort recommendation.
 */
export const WIDGET_SEND_EVENT = "knowgap:widget-send";

export interface WidgetSendDetail {
  text: string;
  /** Per-turn reasoning effort recommended by the vision router. */
  effort?: "low" | "medium" | "high";
  handled: boolean;
}

export function askInComposer(prompt: string): void {
  window.dispatchEvent(new CustomEvent<string>(WIDGET_ASK_EVENT, { detail: prompt }));
}

/** dispatchEvent runs listeners synchronously, so `handled` is known when it returns. */
export function sendOrAsk(text: string, effort?: "low" | "medium" | "high"): "sent" | "prefilled" {
  const detail: WidgetSendDetail = { text, effort, handled: false };
  window.dispatchEvent(new CustomEvent<WidgetSendDetail>(WIDGET_SEND_EVENT, { detail }));
  if (detail.handled) return "sent";
  askInComposer(text);
  return "prefilled";
}

/** Send a message to the open conversation right away. Composer sets detail.handled when it accepted it (it is idle). */
export const WIDGET_AUTOSEND_EVENT = "knowgap:widget-autosend";

export interface WidgetAutoSendDetail {
  text: string;
  handled: boolean;
}

export function sendNow(text: string): "sent" | "prefilled" {
  const detail: WidgetAutoSendDetail = { text, handled: false };
  window.dispatchEvent(new CustomEvent<WidgetAutoSendDetail>(WIDGET_AUTOSEND_EVENT, { detail }));
  if (detail.handled) return "sent";
  askInComposer(text);
  return "prefilled";
}
