"use client";

import { useCallback } from "react";
import { ModelAccessCard } from "@/components/settings/ModelAccessCard";

/** Browser regression target; tests mock the config API, never real credentials. */
export default function ModelAccessPreview() {
  const ignore = useCallback(() => {}, []);
  if (process.env.NODE_ENV !== "development") return <p>此预览仅在开发环境可用。</p>;
  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: 24 }}>
      <ModelAccessCard source="api" health="online" signal={{ state: "unknown" }}
        onCheckHealth={ignore} onConfigChange={ignore} />
    </main>
  );
}
