const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { resolveI18n } = require('./i18n-support.cjs');

const file = path.join(__dirname, '../src/components/MaterialPreviewPanel.tsx');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, name => {
  if (resolveI18n(name)) return resolveI18n(name);
  if (name.endsWith('.css')) return { default: {} };
  if (name === '@/lib/api/material-client') return { createMaterialClient: () => ({}) };
  if (name === '@/lib/api/errors') return { toApiError: error => ({ message: String(error) }) };
  if (name === '@/lib/cx') return { cx: (...parts) => parts.filter(Boolean).join(' ') };
  if (name === '@/lib/materials/pptx') return { loadPptxSlides: async () => ({ slides: [], truncated: false }) };
  if (name === './chat/Markdown') return { Markdown: () => null };
  return require(name);
});
const panel = mod.exports;

test('isLegacyOle 只认 OLE 魔数，ZIP（新版 Office）和空字节不算', () => {
  assert.equal(panel.isLegacyOle(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])), true);
  assert.equal(panel.isLegacyOle(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), false); // "PK.." ZIP
  assert.equal(panel.isLegacyOle(new Uint8Array([0xd0, 0xcf, 0x11])), false); // 不足 4 字节
  assert.equal(panel.isLegacyOle(new Uint8Array([])), false);
});

test('degradeThreshold：PDF 比 Office 格式的降级阈值更宽松', () => {
  assert.equal(panel.degradeThreshold('pdf'), 12 * 1024 * 1024);
  for (const kind of ['docx', 'pptx', 'xlsx']) {
    assert.equal(panel.degradeThreshold(kind), 8 * 1024 * 1024);
  }
});

test('previewMode：按文件类型和是否为旧版 OLE 字节选择渲染分支', () => {
  assert.equal(panel.previewMode('pdf', false), 'pdf');
  assert.equal(panel.previewMode('md', false), 'markdown');
  assert.equal(panel.previewMode('txt', false), 'text');
  assert.equal(panel.previewMode('csv', false), 'csv');
  // xlsx 不区分新旧：SheetJS 原生支持旧版 .xls（BIFF8）
  assert.equal(panel.previewMode('xlsx', false), 'xlsx');
  assert.equal(panel.previewMode('xlsx', true), 'xlsx');
  // 新版 .pptx 是 ZIP，可以读出文字版幻灯片；旧版 .ppt 是 OLE，只能看提取文字
  assert.equal(panel.previewMode('pptx', false), 'pptx');
  assert.equal(panel.previewMode('pptx', true), 'extracted');
  // docx：新版（ZIP）走真实渲染，旧版 .doc（OLE 字节）降级到提取文字
  assert.equal(panel.previewMode('docx', false), 'docx');
  assert.equal(panel.previewMode('docx', true), 'extracted');
});

test('normalizeInitialPage / pdfPagesToRender / worksheetIndex：页码从 1 起，非法值回到第一页', () => {
  assert.equal(panel.normalizeInitialPage(undefined), 1);
  assert.equal(panel.normalizeInitialPage(0), 1);
  assert.equal(panel.normalizeInitialPage(-3), 1);
  assert.equal(panel.normalizeInitialPage(2.5), 1);
  assert.equal(panel.normalizeInitialPage(4), 4);
  assert.deepEqual(panel.pdfPagesToRender(3, 2), [1, 2, 3]);
  assert.deepEqual(panel.pdfPagesToRender(0, 1), []);
  // 目标页超出前 100 页时也要补进渲染列表
  assert.equal(panel.pdfPagesToRender(150, 130).includes(130), true);
  assert.equal(panel.worksheetIndex(undefined, 3), 0);
  assert.equal(panel.worksheetIndex(2, 3), 1);
  assert.equal(panel.worksheetIndex(9, 3), 2);
  assert.equal(panel.worksheetIndex(1, 0), null);
});

test('parseCsv：引号内的逗号/换行/转义引号不被拆开，BOM 与空行被忽略', () => {
  assert.deepEqual(panel.parseCsv('姓名,"成绩,总分"\r\n张三,"90,100"\r\n\r\n'), [['姓名', '成绩,总分'], ['张三', '90,100']]);
  assert.deepEqual(panel.parseCsv('a,"他说""好""",c\n"x\ny",2'), [['a', '他说"好"', 'c'], ['x\ny', '2']]);
  assert.deepEqual(panel.parseCsv('a,,c\n'), [['a', '', 'c']]);
  assert.deepEqual(panel.parseCsv(''), []);
});

test('decodeText：优先 UTF-8（去 BOM），非法 UTF-8 回退 GB18030', () => {
  const utf8 = new TextEncoder().encode('﻿姓名');
  assert.equal(panel.decodeText(utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + utf8.byteLength)), '姓名');
  // "姓名" 的 GBK 编码：D0 D5 C3 FB
  const gbk = new Uint8Array([0xd0, 0xd5, 0xc3, 0xfb]);
  assert.equal(panel.decodeText(gbk.buffer), '姓名');
});
