const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const file = path.join(__dirname, '../src/lib/materials/pptx.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const pptx = mod.exports;

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/sample-deck.pptx'));
const fixtureBytes = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);

test('clampPptxScale：按面板宽度缩放，限制在 0.2–1.6', () => {
  assert.equal(pptx.clampPptxScale(0, 960), 1);
  assert.equal(pptx.clampPptxScale(Number.NaN, 960), 1);
  assert.equal(pptx.clampPptxScale(8, 960), 0.2);
  assert.ok(Math.abs(pptx.clampPptxScale(392, 960) - 0.4) < 1e-9);
  assert.equal(pptx.clampPptxScale(1400, 960), 1.45);
  assert.equal(pptx.clampPptxScale(5000, 960), 1.6);
  // 16:9 的 1280 宽要按自身宽度算
  assert.ok(Math.abs(pptx.clampPptxScale(648, 1280) - 0.5) < 1e-9);
});

test('pptxFrameDocument：CSP 禁脚本/外链，只保留 data 图片和内联样式', () => {
  const doc = pptx.pptxFrameDocument('<div class="slide">x</div>', 0.5);
  assert.ok(doc.startsWith('<!doctype html>'));
  assert.ok(doc.includes("default-src 'none'"));
  assert.ok(doc.includes("img-src data: blob:"));
  assert.ok(doc.includes("script-src") === false, '默认 default-src none 已覆盖脚本');
  assert.ok(doc.includes('zoom:0.5'));
  assert.ok(doc.includes('<div class="slide">x</div>'));
  // 非法缩放值回退到 1
  assert.ok(pptx.pptxFrameDocument('<div></div>', Number.NaN).includes('zoom:1'));
});

test('renderPptxDocument：解析真实 PPTX，按 presentation 顺序返回 3 页', async () => {
  const result = await pptx.renderPptxDocument(fixtureBytes);
  assert.equal(result.slideCount, 3);
  assert.equal(result.width, 960);
  assert.equal(result.height, 720);
  assert.ok(result.html.includes('第一章 绪论'));
  assert.ok(result.html.includes('第三章 栈与队列'));
  assert.ok(/<svg/i.test(result.html), '形状/文字应渲染为 SVG 或 HTML');
  assert.ok(!/<script/i.test(result.html), '渲染结果不应包含脚本');
});

test('renderPptxDocument：slides 选项只渲染引用页', async () => {
  const result = await pptx.renderPptxDocument(fixtureBytes, { slides: [2] });
  assert.equal(result.slideCount, 1);
  assert.ok(result.html.includes('第二章 线性表'));
  assert.ok(!result.html.includes('第一章 绪论'));
});

test('renderPptxDocument：不是 PPTX 时抛错，交给预览面板降级', async () => {
  const bytes = new TextEncoder().encode('not a pptx').buffer;
  await assert.rejects(() => pptx.renderPptxDocument(bytes));
});
