"use client";

import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import type { ChatMessage } from "@/lib/chat/types";

// The existing controller remains the single owner of sending, tools and persistence.
// assistant-ui provides the reading viewport, including resize-aware scroll following.
export function ReadingProvider({ messages, children }: { messages: ChatMessage[]; children: ReactNode }) {
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    isDisabled: true,
    isRunning: messages.some((message) => message.status === "streaming"),
    convertMessage: (message) => ({
      id: message.id,
      role: message.role,
      content: [{ type: "text", text: message.content }],
      ...(message.role === "assistant" ? { status: message.status === "streaming"
        ? { type: "running" as const }
        : message.status === "complete" ? { type: "complete" as const, reason: "stop" as const }
          : { type: "incomplete" as const, reason: message.status === "cancelled" ? "cancelled" as const : "error" as const } } : {}),
    }),
    onNew: async () => {},
  });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root asChild>{children}</ThreadPrimitive.Root></AssistantRuntimeProvider>;
}

export const ReadingViewport = forwardRef<HTMLDivElement, ComponentProps<typeof ThreadPrimitive.Viewport>>(
  function ReadingViewport(props, ref) {
    return <ThreadPrimitive.Viewport {...props} ref={ref}
      scrollToBottomOnInitialize={false} scrollToBottomOnThreadSwitch={false} scrollToBottomOnRunStart={false} />;
  },
);
