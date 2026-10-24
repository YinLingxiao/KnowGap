#!/usr/bin/env node
/**
 * 资料预览面板需要三份浏览器可直接 <script> 加载的静态资源，拷进 public/vendor/。
 *
 * 为什么不直接 import：
 * - pdf.js 的 worker 必须是一个独立可 fetch 的文件，不能内联进主 bundle。
 * - docx-preview 要在沙箱 iframe 的 srcdoc 里用普通 <script> 标签加载（不能用 ESM，
 *   因为 iframe 内容没有打包器帮忙解析 "jszip" 这个裸模块说明符），所以用 UMD 版
 *   docx-preview.min.js + jszip.min.js（全局 window.JSZip）这一对。
 *
 * `npm install` 后自动跑一次（见 package.json 的 postinstall），避免升级这三个包
 * 版本后忘记手动同步 public/vendor/ 里的旧文件。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "public", "vendor");
mkdirSync(outDir, { recursive: true });

const files = [
  ["pdfjs-dist/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["jszip/dist/jszip.min.js", "jszip.min.js"],
  ["docx-preview/dist/docx-preview.min.js", "docx-preview.min.js"],
];

for (const [from, to] of files) {
  const source = join(root, "node_modules", from);
  const target = join(outDir, to);
  copyFileSync(source, target);
  console.log(`已同步 ${from} -> public/vendor/${to}`);
}
