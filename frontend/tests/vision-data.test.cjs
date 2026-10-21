// Pure logic behind the vision widgets: parsing, geometry, netlist validation and message markers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/components/chat/widgets/visionData.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const v = mod.exports;

const IMG = 'img_' + 'a'.repeat(24);
const NET = 'net_' + 'b'.repeat(24);

test('parseBox accepts 0-1000 and 0-1, reorders and clamps', () => {
  assert.deepEqual(v.parseBox([100, 200, 300, 400]), [100, 200, 300, 400]);
  assert.deepEqual(v.parseBox([0.1, 0.2, 0.3, 0.4]), [100, 200, 300, 400]);
  assert.deepEqual(v.parseBox([300, 400, 100, 200]), [100, 200, 300, 400]);
  assert.deepEqual(v.parseBox([-5, -5, 1500, 1200]), [0, 0, 1000, 1000]);
  assert.equal(v.parseBox([1, 2, 3]), null);
  assert.equal(v.parseBox([1, 2, 'x', 4]), null);
  assert.equal(v.parseBox('0,0,1,1'), null);
});

test('annotator data: image id, aspect from size, arrows by id, legacy fields', () => {
  const data = v.parseAnnotatorData({
    type: 'image_annotator', title: '错题批注', summary: '符号方向错误，后续结果受影响。', image_id: IMG, width: 1600, height: 800,
    annotations: [
      { id: 'r3', bbox: [100, 100, 200, 400], note: '漏了 1/2', arrow_to: 'r5' },
      { id: 'r5', bbox: [600, 100, 700, 400], shape: 'rect', label: '错误传导', color: 'javascript:alert(1)' },
      { id: 'r9', bbox: [1, 2, 3] },
      { id: 'self', bbox: [800, 800, 900, 900], arrow_to: 'self' },
    ],
    route: { effort: 'high', reason: '约需 5 步推导', source: 'auto' },
  });
  assert.equal(data.imageId, IMG);
  assert.equal(data.imageSrc, '');
  assert.equal(data.aspect, 2);
  assert.equal(data.summary, '符号方向错误，后续结果受影响。');
  assert.equal(data.annotations.length, 3);
  assert.equal(data.annotations[0].arrowTo, 1);
  assert.equal(data.annotations[1].shape, 'rect');
  assert.equal(data.annotations[1].text, '错误传导');
  assert.equal(data.annotations[1].color, v.DEFAULT_ANNOTATION_COLOR);
  assert.equal(data.annotations[2].arrowTo, null);
  assert.deepEqual(data.route, { effort: 'high', reason: '约需 5 步推导', source: 'auto' });

  const legacy = v.parseAnnotatorData({ imageUrl: 'data:image/png;base64,AAA', aspectRatio: 9, image_id: '../x',
    annotations: [{ bbox: [0.1, 0.1, 0.2, 0.2], label: '旧格式' }] });
  assert.equal(legacy.imageId, null);
  assert.equal(legacy.imageSrc, 'data:image/png;base64,AAA');
  assert.equal(legacy.aspect, 9);
  assert.equal(legacy.summary, '');
  assert.equal(v.parseAnnotatorData({ width: 11000, height: 1000 }).aspect, 11);
  assert.equal(v.parseAnnotatorData({ aspectRatio: 100 }).aspect, 20);
  assert.equal(v.parseAnnotatorData({ imageUrl: 'javascript:alert(1)' }).imageSrc, '');
  assert.equal(v.parseRoute({ effort: 'extreme' }), null);
});

test('ellipses stay round on wide images and arrows connect the outlines', () => {
  const wide = v.ellipseOf([0, 0, 1000, 1000], 500);
  assert.deepEqual([wide.cx, wide.cy], [500, 250]);
  const a = v.ellipseOf([100, 100, 200, 200], 1000);
  const b = v.ellipseOf([700, 100, 800, 200], 1000);
  const arrow = v.arrowBetween(a, b);
  assert.ok(arrow);
  assert.ok(arrow.y1 > a.cy && arrow.y2 < b.cy, 'arrow runs from the first outline toward the second');
  assert.equal(arrow.head.split(' ').length, 3);
  const overlap = v.ellipseOf([120, 120, 220, 220], 1000);
  assert.equal(v.arrowBetween(a, overlap), null);
});

test('netlist data accepts model shapes and keeps only known uncertain ids', () => {
  const data = v.parseNetlistData({
    netlist_id: NET, version: 2, image_id: IMG, imageUrl: 'https://ignored.example/circuit.png', confirmed: true,
    nodes: ['a', { id: 'b', note: '中间' }],
    branches: [
      { id: 'Us', type: '电压源', value: '12V', nodes: ['a', 'GND'], polarity: '+a' },
      { name: 'R1', component: 'resistor', value: '10Ω', from: 'a', to: 'b' },
      { id: 'H1', element: 'ccvs', value: '2I', from: 'b', to: 'GND', control: { ref: 'R1', quantity: 'i', direction: 'a→b' } },
      { id: 'X1', element: '变压器', from: 'a', to: 'b' },
    ],
    uncertain: ['H1', 'ZZ'],
    issues: [{ level: 'warning', code: 'dangling_node', message: '节点 b 只连了一条支路', ref: 'b' }, { level: 'error' }],
  });
  assert.equal(data.netlistId, NET);
  assert.equal(data.version, 2);
  assert.equal(data.confirmed, true);
  assert.equal(data.imageSrc, '');
  assert.deepEqual(data.nodes.map((n) => n.id), ['a', 'b', 'GND']);
  assert.deepEqual(data.branches.map((b) => [b.id, b.element]), [['Us', 'V'], ['R1', 'R'], ['H1', 'CCVS'], ['X1', 'OTHER']]);
  assert.equal(data.branches[3].value, '变压器');
  assert.deepEqual(data.branches[2].control, { ref: 'R1', quantity: 'I', direction: 'a→b' });
  assert.deepEqual(data.uncertain, ['H1']);
  assert.equal(data.issues.length, 1);
  assert.equal(v.parseNetlistData({ netlist_id: 'net_short', version: 0 }).netlistId, null);
  assert.equal(v.parseNetlistData({ imageUrl: 'https://cdn.example/circuit.png' }).imageSrc,
    'https://cdn.example/circuit.png');
  assert.equal(v.parseNetlistData({ imageUrl: 'javascript:alert(1)' }).imageSrc, '');
});

test('checkNetlist blocks the same errors as the backend', () => {
  const ok = [
    { id: 'Us', element: 'V', value: '', from: 'a', to: 'GND', polarity: '', control: null },
    { id: 'R1', element: 'R', value: '', from: 'a', to: 'GND', polarity: '', control: null },
  ];
  assert.deepEqual(v.checkNetlist(ok), []);
  const codes = v.checkNetlist([
    ...ok,
    { id: 'R1', element: 'R', value: '', from: 'a', to: 'b', polarity: '', control: null },
    { id: 'R2', element: 'R', value: '', from: 'b', to: 'b', polarity: '', control: null },
    { id: 'R3', element: 'R', value: '', from: '', to: 'b', polarity: '', control: null },
    { id: 'F1', element: 'CCCS', value: '', from: 'a', to: 'b', polarity: '', control: { ref: 'F1', quantity: 'I', direction: '' } },
    { id: 'E1', element: 'VCVS', value: '', from: 'a', to: 'b', polarity: '', control: { ref: 'R1', quantity: '', direction: '' } },
    { id: 'G1', element: 'VCCS', value: '', from: 'a', to: 'b', polarity: '', control: { ref: 'R1', quantity: 'I', direction: '' } },
    { id: '', element: 'R', value: '', from: 'a', to: 'b', polarity: '', control: null },
  ]).map((issue) => issue.code);
  assert.deepEqual(codes, ['duplicate_branch', 'self_loop', 'missing_end', 'missing_control', 'missing_control', 'bad_control_quantity', 'missing_id']);
  assert.deepEqual(v.checkNetlist([]).map((issue) => issue.code), ['empty']);
});

test('toWireNetlist matches the confirm endpoint and drops unused nodes', () => {
  const wire = v.toWireNetlist(
    [{ id: 'a', note: '正极' }, { id: 'old', note: '' }],
    [
      { id: 'Us', element: 'V', value: '12V', from: 'a', to: 'GND', polarity: '+a', control: null },
      { id: 'R1', element: 'R', value: '', from: 'a', to: 'GND', polarity: '', control: { ref: 'Us', quantity: 'U', direction: '' } },
      { id: 'E1', element: 'VCVS', value: '2U', from: 'a', to: 'GND', polarity: '', control: { ref: 'R1', quantity: '', direction: 'a→GND' } },
    ],
  );
  assert.deepEqual(wire.nodes, [{ id: 'a', note: '正极' }, { id: 'GND', note: '' }]);
  assert.equal(wire.branches[1].control, null, 'non-controlled elements never carry a control');
  assert.deepEqual(wire.branches[2].control, { ref: 'R1', quantity: null, direction: 'a→GND' });
  assert.deepEqual(wire.uncertain, []);
  assert.match(v.netlistText([], wire.branches.map((b) => ({ ...b, control: b.control && { ...b.control, quantity: 'U' } }))),
    /E1：压控电压源 2U，a → GND，受 R1 的电压控制（a→GND）/);
});

test('message markers split into text, image and netlist segments', () => {
  const text = `帮我看看哪里错了\n[[kg-image:${IMG}]]\n[[kg-netlist:${NET}@3]]\n电路拓扑已确认。[[kg-image:../../x]]`;
  assert.equal(v.hasVisionMarker(text), true);
  assert.equal(v.hasVisionMarker('纯文本'), false);
  assert.equal(v.hasVisionMarker(text), true, 'repeated checks give the same answer');
  // Regression: the shell calls hasVisionMarker() right before splitting; the first marker must survive.
  assert.deepEqual(v.splitVisionMarkers(text), [
    { kind: 'text', text: '帮我看看哪里错了\n' },
    { kind: 'image', imageId: IMG },
    { kind: 'text', text: '\n' },
    { kind: 'netlist', netlistId: NET, version: 3 },
    { kind: 'text', text: '\n电路拓扑已确认。[[kg-image:../../x]]' },
  ]);
  assert.equal(v.withImageMarker('', '[[m]]'), '[[m]]\n');
  assert.equal(v.withImageMarker('这道题  \n', '[[m]]'), '这道题\n[[m]]\n');
});
