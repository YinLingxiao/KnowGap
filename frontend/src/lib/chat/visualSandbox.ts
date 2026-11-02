// ```knowgap-visual 沙箱文档：离线 CSP、宿主主题、高度与提问通信。

export const VISUAL_MSG = {
  height: "knowgap-visual:height",
  ask: "knowgap-visual:ask",
  error: "knowgap-visual:error",
  theme: "knowgap-visual:theme",
} as const;

/** 宿主需要注入 iframe 的 CSS 变量名单 */
export const THEME_VARS: readonly string[] = [
  "--bg",
  "--bg-elevated",
  "--bg-subtle",
  "--text",
  "--text-secondary",
  "--text-tertiary",
  "--border",
  "--border-strong",
  "--accent",
  "--accent-soft",
  "--accent-text",
  "--green",
  "--green-soft",
  "--orange",
  "--orange-soft",
  "--font-sans",
  "--font-mono",
  "--radius",
  "--radius-lg",
];

const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;

const BASE_STYLE =
  // html 不出滚动条：滚动条会改宽度，和高度自适应互相触发
  "<style>html,body{margin:0;background:transparent;color:var(--text);font:14px/1.6 var(--font-sans)}html{overflow:hidden}*{box-sizing:border-box}</style>";

function hostRoot(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  return document.documentElement;
}

/** 从宿主 <html> 读取 THEME_VARS 的当前值 */
export function readThemeVars(root?: HTMLElement): Record<string, string> {
  const el = root ?? hostRoot();
  if (!el || typeof getComputedStyle !== "function") return {};
  const style = getComputedStyle(el);
  const vars: Record<string, string> = {};
  for (const name of THEME_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  // 和宿主 color-scheme 不一致时 Chrome 会给 iframe 垫白底
  const scheme = style.colorScheme?.trim();
  if (scheme) vars["color-scheme"] = scheme;
  return vars;
}

function headAssets(inner: string): string {
  const assets = inner.match(/<style\b[^>]*>[\s\S]*?<\/style>|<script\b[^>]*>[\s\S]*?<\/script>/gi);
  return assets ? assets.join("") : "";
}

/** 剥掉模型可能写的 <html>/<head>/<body> 外壳，只留内容；空内容返回 "" */
export function extractVisualBody(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  let head = "";
  const rest = text
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?html\b[^>]*>/gi, "")
    .replace(/<head\b[^>]*>([\s\S]*?)<\/head>/gi, (_match: string, inner: string) => {
      // head 里的 style/script 前移到正文，空 head 不影响结果
      head += headAssets(inner);
      return "";
    })
    .replace(/<\/?body\b[^>]*>/gi, "");
  return (head + rest).trim();
}

function blockedThemeToken(token: string): boolean {
  // < 或 </style 会提前结束 style 标签
  return token.includes("<") || token.toLowerCase().includes("</style");
}

function themeStyle(theme: Record<string, string>): string {
  const decls: string[] = [];
  for (const [key, value] of Object.entries(theme)) {
    if (blockedThemeToken(key) || blockedThemeToken(value)) continue;
    decls.push(`${key}:${value}`);
  }
  return `<style>:root{${decls.join(";")}}</style>`;
}

function bridgeScript(): string {
  const height = JSON.stringify(VISUAL_MSG.height);
  const ask = JSON.stringify(VISUAL_MSG.ask);
  const error = JSON.stringify(VISUAL_MSG.error);
  const theme = JSON.stringify(VISUAL_MSG.theme);
  return `<script>(function () {
  var HEIGHT = ${height};
  var ASK = ${ask};
  var ERROR = ${error};
  var THEME = ${theme};
  function sendHeight() {
    // scrollHeight 不会小于视口，缩不回去；取 html 盒子的实际高度
    parent.postMessage({ type: HEIGHT, height: Math.ceil(document.documentElement.getBoundingClientRect().height) }, "*");
  }
  var queued = false;
  function sendHeightSoon() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      sendHeight();
    });
  }
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(sendHeightSoon).observe(document.documentElement);
  } else {
    window.addEventListener("resize", sendHeight);
  }
  window.addEventListener("load", sendHeight);
  document.addEventListener("DOMContentLoaded", sendHeight);
  window.knowgap = {
    ask: function (text) {
      parent.postMessage({ type: ASK, text: String(text).slice(0, 500) }, "*");
    }
  };
  window.onerror = function (message) {
    parent.postMessage({ type: ERROR, message: String(message) }, "*");
  };
  window.addEventListener("unhandledrejection", function (event) {
    parent.postMessage({ type: ERROR, message: String(event && event.reason) }, "*");
  });
  window.addEventListener("message", function (e) {
    if (e.source !== parent || !e.data || e.data.type !== THEME || !e.data.vars) return;
    var vars = e.data.vars;
    var keys = Object.keys(vars);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.indexOf("--") === 0 || key === "color-scheme") document.documentElement.style.setProperty(key, String(vars[key]));
    }
  });
})();</script>`;
}

/** 组装 iframe srcdoc：doctype + charset + viewport + CSP meta + :root 主题变量 + 基础样式 + 通信脚本 + 模型内容 */
export function buildVisualSrcdoc(raw: string, theme: Record<string, string>): string {
  // 模型 HTML 原样拼进 body，转义交给 React 的 srcDoc
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${CSP_META}${themeStyle(theme)}${BASE_STYLE}${bridgeScript()}</head><body>${extractVisualBody(raw)}</body></html>`;
}
