"use client";

import { useState, type ReactNode } from "react";
import { Composer } from "@/components/chat/Composer";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { createMockModelLibrary, modelKey, type ModelLibraryClient } from "@/lib/api/model-library";

const DEEPSEEK = "prov-a11d5e01";
const QWEN = "prov-b22e6f02";
const VERTEX = "prov-c33f7003";
const LONG_ID = "qwen-vl-max-institutional-research-reasoning-preview-2026";

function library(): ModelLibraryClient {
  return createMockModelLibrary({
    defaultModel: modelKey(DEEPSEEK, "deepseek-flash"),
    providers: [
      {
        id: DEEPSEEK, name: "DeepSeek", preset: "deepseek", baseUrl: "https://api.deepseek.com/v1",
        authMode: "api_key", apiKey: "synthetic-library-key",
        models: [
          { id: "deepseek-flash", tags: { reasoning: "none", tools: true } },
          { id: "deepseek-reasoner", tags: { reasoning: "high", tools: true, label: "新" } },
          { id: "deepseek-hidden", enabled: false, tags: { reasoning: "high" } },
        ],
      },
      {
        id: QWEN, name: "通义千问", preset: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        authMode: "api_key", apiKey: "synthetic-library-key",
        models: [
          { id: LONG_ID, name: LONG_ID, tags: { reasoning: "medium", vision: true, label: "Pro", tools: true } },
        ],
      },
      {
        id: VERTEX, name: "Vertex", preset: "vertex", baseUrl: "https://aiplatform.googleapis.com/v1",
        authMode: "adc",
        models: [
          { id: "google/gemini-3.5-flash", name: "gemini-3.5-flash", tags: { reasoning: "low", vision: true, tools: true } },
        ],
      },
    ],
  });
}

function Bar({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div style={{ width, container: "composer-toolbar / inline-size" }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6,
        minHeight: 42, padding: "8px 10px", border: "1px solid var(--border)",
        borderRadius: 16, background: "var(--bg-elevated)",
      }}
      >
        {children}
      </div>
    </div>
  );
}

function Picker({
  client, modelKey: initial, disabled = false, defaultOpen = false, initialQuery = "",
}: {
  client: ModelLibraryClient;
  modelKey?: string | null;
  disabled?: boolean;
  defaultOpen?: boolean;
  initialQuery?: string;
}) {
  const [key, setKey] = useState<string | null>(initial ?? null);
  const [notice, setNotice] = useState("");
  return (
    <ModelPicker
      client={client}
      modelKey={key}
      disabled={disabled}
      defaultOpen={defaultOpen}
      initialQuery={initialQuery}
      onSelect={async (next) => { setKey(next); return true; }}
      onManage={() => setNotice("已前往模型接入")}
      error={notice}
    />
  );
}

export default function ModelPickerPreview() {
  const [filled] = useState(library);
  const [empty] = useState(() => createMockModelLibrary());
  if (process.env.NODE_ENV !== "development") return <p>此预览仅在开发环境可用。</p>;
  const setTheme = (mode: "light" | "dark" | "system") => {
    if (mode === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
  };
  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "24px 24px 80px", display: "grid", gap: 28 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => setTheme("light")}>浅色</button>
        <button type="button" onClick={() => setTheme("dark")}>深色</button>
        <button type="button" onClick={() => setTheme("system")}>跟随系统</button>
      </div>
      <section id="wide" style={{ paddingTop: 340 }}>
        <p>宽</p>
        <Bar width={640}><Picker client={filled} defaultOpen /></Bar>
      </section>
      <section id="narrow" style={{ paddingTop: 340 }}>
        <p>窄面板</p>
        <Bar width={280}><Picker client={filled} defaultOpen /></Bar>
      </section>
      <section id="search" style={{ paddingTop: 280 }}>
        <p>搜索</p>
        <Bar width={640}><Picker client={filled} defaultOpen initialQuery="flash" /></Bar>
      </section>
      <section id="long" style={{ paddingTop: 340 }}>
        <p>长名称</p>
        <Bar width={640}><Picker client={filled} defaultOpen modelKey={modelKey(QWEN, LONG_ID)} /></Bar>
      </section>
      <section id="disabled">
        <p>生成中</p>
        <Bar width={640}><Picker client={filled} disabled /></Bar>
      </section>
      <section id="empty">
        <p>未配置</p>
        <Bar width={640}><Picker client={empty} /></Bar>
      </section>
      <section id="composer-reason">
        <p>支持推理</p>
        <Composer
          hero value="" onChange={() => undefined} onSend={() => undefined} onStop={() => undefined}
          phase={null} busy={false} autoFocusKey="reason" modelClient={filled}
          modelKey={modelKey(DEEPSEEK, "deepseek-reasoner")}
          onModelKeyChange={async () => true}
        />
      </section>
      <section id="composer-plain">
        <p>不支持推理</p>
        <Composer
          hero value="" onChange={() => undefined} onSend={() => undefined} onStop={() => undefined}
          phase={null} busy={false} autoFocusKey="plain" modelClient={filled}
          modelKey={modelKey(DEEPSEEK, "deepseek-flash")}
          onModelKeyChange={async () => true}
        />
      </section>
      <section id="composer-busy">
        <p>生成中输入框</p>
        <Composer
          value="" onChange={() => undefined} onSend={() => undefined} onStop={() => undefined}
          phase="streaming" busy={false} autoFocusKey="busy" modelClient={filled}
          modelKey={modelKey(DEEPSEEK, "deepseek-reasoner")}
          onModelKeyChange={async () => true}
        />
      </section>
    </main>
  );
}
