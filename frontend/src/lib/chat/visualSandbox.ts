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
  "--ink-solid",
  "--on-ink",
  "--font-sans",
  "--font-mono",
  "--radius",
  "--radius-lg",
];

const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;

/**
 * 沙箱自带的组件样式（kg- 前缀）。模型只拿到颜色变量时，按钮、滑块、图例都得自己从零写，
 * 每张图风格不一、也费篇幅；有了这一套，写语义类名就能得到和宿主一致的外观。
 * 元素级的默认样式（button、input、label）让没写类名的旧内容也跟着变整齐；
 * 这些规则排在模型内容之前，模型自己的 <style> 仍然可以覆盖。
 */
const KIT_RULES = [
  "h3,.kg-title{margin:0;color:var(--text);font:600 16px/1.35 var(--font-sans)}",
  ".kg-sub{margin:2px 0 0;color:var(--text-secondary);font-size:13px}",
  "p{margin:8px 0}",
  "label{color:var(--text-secondary);font-size:13px}",
  "code,kbd{font-family:var(--font-mono);font-size:12.5px}",
  // 控件
  "button,.kg-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;margin:0;padding:0 12px;border:1px solid var(--border-strong);border-radius:999px;background:var(--bg-elevated);color:var(--text);font:500 13px var(--font-sans);cursor:pointer;transition:background-color .16s ease,border-color .16s ease,color .16s ease,transform .1s ease}",
  "button:hover:not(:disabled){background:var(--bg-subtle)}",
  "button:active:not(:disabled){transform:scale(.97)}",
  "button:disabled{opacity:.45;cursor:not-allowed}",
  "button.is-primary,.kg-btn.is-primary{border-color:var(--ink-solid,var(--text));background:var(--ink-solid,var(--text));color:var(--on-ink,var(--bg))}",
  "button.is-active,.kg-btn.is-active{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-text)}",
  "button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
  "input[type=range]{width:100%;height:20px;margin:0;background:transparent;accent-color:var(--accent)}",
  "input[type=number],input[type=text],select{height:30px;padding:0 10px;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--text);font:400 13px var(--font-sans)}",
  // 版式
  ".kg-stack{display:flex;flex-direction:column;gap:12px}",
  ".kg-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
  ".kg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}",
  ".kg-stage{display:flex;align-items:center;justify-content:center;padding:14px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg-subtle)}",
  ".kg-stage>svg{display:block;width:100%;height:auto}",
  ".kg-field{display:flex;flex-direction:column;gap:4px}",
  ".kg-field>label{display:flex;justify-content:space-between;gap:8px}",
  ".kg-field output,.kg-field label b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}",
  ".kg-caption{margin:0;color:var(--text-secondary);font-size:12.5px;line-height:1.6}",
  // 数据
  ".kg-chip{display:inline-flex;align-items:center;gap:5px;padding:1px 9px;border:1px solid var(--border);border-radius:999px;background:var(--bg-subtle);color:var(--text-secondary);font-size:12px;font-weight:500}",
  ".kg-chip.is-accent{border-color:transparent;background:var(--accent-soft);color:var(--accent-text)}",
  ".kg-chip.is-green{border-color:transparent;background:var(--green-soft);color:var(--green)}",
  ".kg-chip.is-orange{border-color:transparent;background:var(--orange-soft);color:var(--orange)}",
  ".kg-stat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-elevated)}",
  ".kg-stat>span{color:var(--text-tertiary);font-size:12px}",
  ".kg-stat>b{color:var(--text);font:600 20px/1.2 var(--font-sans);font-variant-numeric:tabular-nums}",
  ".kg-legend{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--text-secondary);font-size:12px}",
  ".kg-dot{display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:50%;background:var(--accent)}",
  ".kg-bar{display:flex;width:100%;height:12px;overflow:hidden;border-radius:999px;background:var(--bg-subtle)}",
  ".kg-bar>*{flex:none;height:100%;background:var(--accent);transition:width .25s ease}",
  ".kg-dot.is-green,.kg-bar>.is-green{background:var(--green)}",
  ".kg-dot.is-orange,.kg-bar>.is-orange{background:var(--orange)}",
  ".kg-dot.is-muted,.kg-bar>.is-muted{background:var(--border-strong)}",
  ".kg-callout{padding:9px 12px;border-radius:var(--radius);background:var(--accent-soft);color:var(--text);font-size:13px}",
  ".kg-callout.is-warn{background:var(--orange-soft)}",
  ".kg-callout.is-ok{background:var(--green-soft)}",
  ".kg-table{width:100%;border-collapse:collapse;font-size:13px}",
  ".kg-table th,.kg-table td{padding:7px 10px;border-bottom:1px solid var(--border);text-align:left}",
  ".kg-table th{color:var(--text-secondary);font-size:12px;font-weight:500}",
  // SVG：节点、连线、标注；状态用 is-* 切换，颜色有过渡，逐个点亮时不会生硬地跳
  ".kg-node{fill:var(--bg-elevated);stroke:var(--border-strong);stroke-width:1.5;transition:fill .25s ease,stroke .25s ease}",
  ".kg-node.is-active{fill:var(--accent-soft);stroke:var(--accent)}",
  ".kg-node.is-done{fill:var(--green-soft);stroke:var(--green)}",
  ".kg-node.is-warn{fill:var(--orange-soft);stroke:var(--orange)}",
  ".kg-edge{fill:none;stroke:var(--border-strong);stroke-width:1.5;transition:stroke .25s ease}",
  ".kg-edge.is-active{stroke:var(--accent);stroke-width:2}",
  ".kg-label{fill:var(--text);font:500 12px var(--font-sans);text-anchor:middle;dominant-baseline:central}",
  ".kg-label.is-muted{fill:var(--text-tertiary)}",
  ".kg-label.is-accent{fill:var(--accent)}",
  ".kg-label.is-start{text-anchor:start}",
  ".kg-label.is-end{text-anchor:end}",
  // 时间线：竖排事件，圆点和连线都由 CSS 画，最后一项不画连线；状态只改圆点颜色
  ".kg-timeline{display:flex;flex-direction:column}",
  ".kg-event{position:relative;padding:0 0 14px 24px}",
  ".kg-event:last-child{padding-bottom:0}",
  ".kg-event::before{content:'';position:absolute;left:0;top:6px;width:10px;height:10px;border-radius:50%;background:var(--text-tertiary);transition:background-color .25s ease}",
  ".kg-event::after{content:'';position:absolute;left:4px;top:19px;bottom:-3px;width:2px;background:var(--border-strong)}",
  ".kg-event:last-child::after{display:none}",
  ".kg-event>b{display:block;color:var(--text);font-weight:600}",
  ".kg-event>span,.kg-event>p{display:block;margin:0;color:var(--text-secondary);font-size:13px}",
  ".kg-event.is-active::before{background:var(--accent)}",
  ".kg-event.is-done::before{background:var(--green)}",
  ".kg-event.is-warn::before{background:var(--orange)}",
  // 流程：方框横排可换行，相邻两个之间自动画箭头；换行后的行首箭头落在容器外，被 overflow 裁掉
  ".kg-flow{display:flex;flex-wrap:wrap;gap:10px 28px;overflow:hidden}",
  ".kg-box{position:relative;display:flex;flex-direction:column;justify-content:center;min-width:72px;padding:8px 12px;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--text);font-size:13px;font-weight:500;text-align:center;transition:background-color .25s ease,border-color .25s ease}",
  ".kg-box small{display:block;color:var(--text-secondary);font-size:12px;font-weight:400}",
  ".kg-flow>.kg-box+.kg-box::before{content:'';position:absolute;top:50%;left:-25px;width:21px;height:2px;margin-top:-1px;background:var(--text-tertiary)}",
  ".kg-flow>.kg-box+.kg-box::after{content:'';position:absolute;top:50%;left:-12px;width:7px;height:7px;margin-top:-3.5px;box-sizing:border-box;border:solid var(--text-tertiary);border-width:2px 2px 0 0;transform:rotate(45deg)}",
  // 数组格：等宽的一排，等宽字体；data-i 显示在格子下方（有它才留出位置），空格是虚线框
  // 占满整行再居中：放在 kg-stage 这类收缩容器里时，不占满的话格子会被压成一条细缝
  ".kg-cells{display:flex;justify-content:center;gap:4px;width:100%}",
  ".kg-cell{position:relative;display:flex;flex:0 1 56px;align-items:center;justify-content:center;min-width:28px;min-height:40px;padding:0 2px;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--text);font:500 14px var(--font-mono);transition:background-color .25s ease,border-color .25s ease}",
  ".kg-cell:empty{border-style:dashed;background:transparent}",
  ".kg-cell[data-i]{margin-bottom:20px}",
  ".kg-cell[data-i]::after{content:attr(data-i);position:absolute;top:100%;left:0;right:0;margin-top:4px;color:var(--text-tertiary);font:400 12px var(--font-mono);text-align:center}",
  ".kg-cell.is-active[data-i]::after{color:var(--accent-text)}",
  // 方框和数组格共用三种状态
  ".kg-box.is-active,.kg-cell.is-active{border-color:var(--accent);background:var(--accent-soft)}",
  ".kg-box.is-done,.kg-cell.is-done{border-color:var(--green);background:var(--green-soft)}",
  ".kg-box.is-warn,.kg-cell.is-warn{border-color:var(--orange);background:var(--orange-soft)}",
  // 图表（SVG）：坐标轴、网格、折线、数据点；折线和数据点用 --c 统一换色
  ".kg-axis{fill:none;stroke:var(--text-tertiary);stroke-width:1.5}",
  ".kg-gridline{fill:none;stroke:var(--border);stroke-width:1}",
  ".kg-plot,.kg-point{--c:var(--accent)}",
  ".kg-plot.is-green,.kg-point.is-green{--c:var(--green)}",
  ".kg-plot.is-orange,.kg-point.is-orange{--c:var(--orange)}",
  ".kg-plot.is-muted,.kg-point.is-muted{--c:var(--text-tertiary)}",
  ".kg-plot{fill:none;stroke:var(--c);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:stroke .25s ease}",
  ".kg-point{fill:var(--c);transition:fill .25s ease}",
  "@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}",
];

/** 沙箱组件样式里可用的类名，提示词和测试都以它为准 */
export const KIT_CLASSES: readonly string[] = [...new Set(KIT_RULES.join("").match(/\.kg-[a-z]+/g) ?? [])].sort();

const BASE_STYLE =
  // html 不出滚动条：滚动条会改宽度，和高度自适应互相触发
  "<style>html,body{margin:0;background:transparent;color:var(--text);font:14px/1.6 var(--font-sans)}html{overflow:hidden}*{box-sizing:border-box}"
  + KIT_RULES.join("") + "</style>";

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
  // 文档只解析到 head 时还没有内容，此刻的高度只有几像素；等 DOMContentLoaded 再开始上报，卡片才不会先缩成一小条
  var ready = false;
  function sendHeight() {
    if (!ready) return;
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
  document.addEventListener("DOMContentLoaded", function () {
    ready = true;
    sendHeight();
  });
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
