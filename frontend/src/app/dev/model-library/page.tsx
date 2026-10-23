"use client";

import { useState } from "react";
import { ModelAccessCard } from "@/components/settings/ModelAccessCard";
import { ServiceModelsSection, type VisionPrefs, type VisionPrefsClient } from "@/components/settings/ServiceModelsSection";
import { createMockModelLibrary, type MockLibrarySeed } from "@/lib/api/model-library";
import styles from "@/components/settings/ModelLibrary.module.css";

const SEED: MockLibrarySeed = {
  providers: [
    {
      id: "prov-a1b2c3d4",
      name: "DeepSeek",
      preset: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      authMode: "api_key",
      apiKey: "synthetic-library-key",
      models: [
        { id: "deepseek-flash", name: "deepseek-flash", tags: { reasoning: "none", vision: false, tools: true, label: null } },
        { id: "deepseek-reasoner", name: "deepseek-reasoner", tags: { reasoning: "high", vision: false, tools: false, label: "Pro" } },
        { id: "deepseek-vl", name: "deepseek-vl", enabled: false, tags: { reasoning: "none", vision: true, tools: false, label: "新" } },
      ],
    },
    {
      id: "prov-b1b2c3d4",
      name: "通义千问",
      preset: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      authMode: "api_key",
      apiKey: "synthetic-library-key",
      models: [
        { id: "qwen-plus", name: "qwen-plus", tags: { reasoning: "none", vision: false, tools: true, label: null } },
        { id: "qwen-vl-max", name: "qwen-vl-max", tags: { reasoning: "low", vision: true, tools: false, label: null } },
      ],
    },
    {
      id: "prov-c1b2c3d4",
      name: "停用的服务商",
      preset: "openai",
      baseUrl: "https://api.openai.com/v1",
      authMode: "api_key",
      apiKey: "synthetic-library-key",
      enabled: false,
      models: [{ id: "gpt-4o-mini", name: "gpt-4o-mini" }],
    },
  ],
  defaultModel: "prov-a1b2c3d4/deepseek-flash",
  serviceModels: { logic: "prov-a1b2c3d4/deepseek-reasoner", vision: "prov-b1b2c3d4/qwen-vl-max", memory: null },
};

function memoryVision(): VisionPrefsClient {
  let current: VisionPrefs = {
    bboxFormat: "xyxy_1000",
    visionEnabled: true,
    dualModelRelay: true,
    circuitConfirmFirst: true,
    suggestReplyEnabled: false,
  };
  return {
    async load() { return { ...current }; },
    async save(next) { current = { ...next }; return { ...current }; },
  };
}

export default function ModelLibraryPreview() {
  const [filled] = useState(() => createMockModelLibrary(SEED));
  const [blank] = useState(() => createMockModelLibrary());
  const [vision] = useState(memoryVision);
  const [empty, setEmpty] = useState(false);
  const client = empty ? blank : filled;
  if (process.env.NODE_ENV !== "development") return <p>此预览仅在开发环境可用。</p>;
  const theme = (value: "light" | "dark") => { document.documentElement.dataset.theme = value; };
  return (
    <main className={styles.preview}>
      <div className={styles.previewBar}>
        <button type="button" className={styles.textButton} onClick={() => theme("light")}>浅色</button>
        <button type="button" className={styles.textButton} onClick={() => theme("dark")}>深色</button>
        <button type="button" className={styles.textButton} aria-pressed={empty} onClick={() => setEmpty((value) => !value)}>
          {empty ? "查看示例库" : "查看空库"}
        </button>
      </div>
      <h1 className={styles.previewTitle}>模型接入与服务模型分工</h1>
      <ModelAccessCard
        key={empty ? "empty" : "seed"}
        plain
        source="api"
        health="online"
        signal={{ state: "unknown" }}
        client={client}
        onCheckHealth={() => undefined}
        onConfigChange={() => undefined}
      />
      <ServiceModelsSection key={empty ? "empty-service" : "seed-service"} client={client} visionClient={vision} />
    </main>
  );
}
