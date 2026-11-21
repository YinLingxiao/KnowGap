// 1.0.0 正式版一次性清空旧版本的全部数据（对话、空间、记忆、日程、资料、模型配置），之后不再触发。
// 依赖全部注入，方便不启动 Electron 也能测试。

const path = require("path");

const RESET_VERSION = "1.0.0";
const MARKER = "data-reset.json";
// 这些文件存在说明装过旧版本
const LEGACY_SIGNS = ["knowgap.sqlite3", "ai-settings.json", "desktop-settings.json"];
// Chromium 运行中自己占用的目录和文件：不去删（删不掉也会出错），网页存储改用 session 清理
const CHROMIUM_ENTRIES = new Set([
  "Local State", "Preferences", "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache",
  "DawnWebGPUCache", "GrShaderCache", "ShaderCache", "Network", "Local Storage", "Session Storage",
  "IndexedDB", "blob_storage", "Service Worker", "Shared Dictionary", "SharedStorage", "WebStorage",
  "Crashpad", "Cookies", "Cookies-journal", "Trust Tokens", "Trust Tokens-journal", "TransportSecurity",
  "Dictionaries", "VideoDecodeStats", "databases", "lockfile", "Partitions",
  // 安装程序写的数据文件夹指针，不属于学习数据
  "data-location.txt",
]);

const NOTICE = {
  type: "info",
  title: "KnowGap 1.0.0",
  buttons: ["好的"],
  defaultId: 0,
  message: "KnowGap 1.0.0 会清空旧版本的全部数据",
  detail: "包括对话、学习空间、学习记忆、日程、资料，以及模型配置（含 API Key）。清空后会重新进入首次设置。",
};

/**
 * 返回 "reset"（清空了旧数据）、"fresh"（新安装，只写标记）或 "done"（之前已处理过）。
 * 网页存储（localStorage 等）由 session 清掉；单个文件删不掉不影响其余部分。
 */
async function resetLegacyData({ dir, fs, dialog, session, version = RESET_VERSION }) {
  const marker = path.join(dir, MARKER);
  if (fs.existsSync(marker)) return "done";
  const legacy = LEGACY_SIGNS.some((name) => fs.existsSync(path.join(dir, name)));
  if (legacy) {
    dialog.showMessageBoxSync(NOTICE);
    for (const name of fs.readdirSync(dir)) {
      if (CHROMIUM_ENTRIES.has(name)) continue;
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      } catch (error) {
        console.warn(`[KnowGap] 清理旧数据失败：${name}`, error);
      }
    }
    try {
      await session.clearStorageData();
      await session.clearCache();
    } catch (error) {
      console.warn("[KnowGap] 清理网页存储失败", error);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ version }), "utf8");
  return legacy ? "reset" : "fresh";
}

module.exports = { resetLegacyData, RESET_VERSION, MARKER, CHROMIUM_ENTRIES };
