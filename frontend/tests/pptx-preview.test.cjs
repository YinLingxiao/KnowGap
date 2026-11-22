const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const JSZip = require('jszip');

const file = path.join(__dirname, '../src/lib/materials/pptx.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const pptx = mod.exports;

const SLIDE = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>第一章 &amp; 绪论</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody>
      <a:p><a:r><a:t>要点一</a:t></a:r><a:r><a:t>（续）</a:t></a:r></a:p>
      <a:p><a:r><a:t>要点二</a:t></a:r></a:p>
      <a:p/>
    </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

test('decodeXmlEntities：常见实体和数字引用', () => {
  assert.equal(pptx.decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), `a & b <c> "d" 'e'`);
  assert.equal(pptx.decodeXmlEntities('&#65;&#x4e2d;'), 'A中');
  assert.equal(pptx.decodeXmlEntities('&unknown;'), '&unknown;');
  assert.equal(pptx.decodeXmlEntities('&#xD800;'), '&#xD800;');
});

test('parseSlideXml：标题占位符优先，段落合并同一段里的多个 a:t', () => {
  const slide = pptx.parseSlideXml(SLIDE);
  assert.equal(slide.title, '第一章 & 绪论');
  assert.deepEqual(slide.lines, ['要点一（续）', '要点二']);
});

test('parseSlideXml：没有标题占位符时把第一段当标题', () => {
  const slide = pptx.parseSlideXml(`<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:t>第一段</a:t></a:p><a:p><a:t>第二段</a:t></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`);
  assert.equal(slide.title, '第一段');
  assert.deepEqual(slide.lines, ['第二段']);
});

test('slidePaths：按 presentation.xml 的 sldIdLst 顺序解析 rels 目标', () => {
  const presentation = `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>
    <p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/>
  </p:sldIdLst></p:presentation>`;
  const rels = `<Relationships xmlns="rels">
    <Relationship Id="rId2" Type="slide" Target="slides/slide1.xml"/>
    <Relationship Id="rId3" Type="slide" Target="slides/slide2.xml"/>
    <Relationship Id="rId4" Type="notes" Target="../notesSlides/notesSlide1.xml"/>
  </Relationships>`;
  assert.deepEqual(pptx.slidePaths(presentation, rels), ['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml']);
});

test('loadPptxSlides：读 zip 内幻灯片，rels 缺失时按页码排序', async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p"><p:sldIdLst/></p:presentation>');
  zip.file('ppt/slides/slide10.xml', `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:t>第十页</a:t></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  zip.file('ppt/slides/slide2.xml', `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:t>第二页</a:t></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const result = await pptx.loadPptxSlides(bytes);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.slides.map((slide) => slide.title), ['第二页', '第十页']);
});

test('loadPptxSlides：不是 PPTX 时抛错，交给预览面板降级', async () => {
  const zip = new JSZip();
  zip.file('readme.txt', 'not a deck');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  await assert.rejects(() => pptx.loadPptxSlides(bytes));
});
