// 排版与样式收敛：只读静态约束，不启动浏览器或业务服务。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const srcRoot = path.join(__dirname, '../src');
const component = (file) => path.join('components', file);
const read = (file) => fs.readFileSync(path.join(srcRoot, file), 'utf8');
const globals = read('app/globals.css');
const sandbox = read('lib/chat/visualSandbox.ts');
const normalize = (value) => value.trim().replace(/\s+/g, ' ');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function block(source, marker, fromIndex = 0) {
  const start = source.indexOf(marker, fromIndex);
  assert.notEqual(start, -1, `missing style block: ${marker}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `missing opening brace: ${marker}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth !== 0) continue;
    return {
      start,
      header: source.slice(start, open).trim(),
      body: source.slice(open + 1, index),
      text: source.slice(start, index + 1),
      end: index + 1,
    };
  }
  throw new Error(`unclosed style block: ${marker}`);
}

function declaration(source, name) {
  const pattern = new RegExp(`${escapeRegExp(name)}\\s*:\\s*([^;}]+);`, 'g');
  const values = [...source.matchAll(pattern)].map((match) => normalize(match[1]));
  assert.equal(values.length, 1, `${name} should have exactly one declaration in its scope`);
  return values[0];
}

function customDeclarations(source) {
  return [...source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map((match) => [match[1], normalize(match[2])]);
}

function assertGlobalAnimation(file, name, parameters) {
  const css = read(file);
  const pattern = new RegExp(`animation:\\s*global\\(${escapeRegExp(name)}\\)\\s+${escapeRegExp(parameters)}\\s*;`);
  assert.match(css, pattern, `${file} must use global(${name}) with ${parameters}`);
  return css;
}

function assertRemovedKeyframe(css, name, file) {
  const pattern = new RegExp(`@keyframes\\s+${escapeRegExp(name)}\\b`);
  assert.doesNotMatch(css, pattern, `${file} must not redefine ${name}`);
}

const spinModules = {
  [component('desktop/UpdateIndicator.module.css')]: ['update-spin', '900ms'],
  [component('chat/MemoryDrawer.module.css')]: ['spin', '1s'],
  [component('settings/MemorySettingsPane.module.css')]: ['memory-spin', '900ms'],
  [component('settings/ModelLibrary.module.css')]: ['spin', '0.9s'],
  [component('ui/Button.module.css')]: ['spin', '0.8s'],
  [component('quick/QuickAsk.module.css')]: ['spin', '900ms'],
  [component('chat/widgets/VisionWidgets.module.css')]: ['vision-spin', '0.9s'],
  [component('chat/widgets/ProblemSourceBadge.module.css')]: ['spin', '900ms'],
  [component('chat/widgets/CodePlaygroundWidget.module.css')]: ['spin', '900ms'],
  [component('chat/SubjectPage.module.css')]: ['spin', '0.8s'],
  [component('chat/PlanBar.module.css')]: ['spin', '900ms'],
  [component('chat/MessageList.module.css')]: ['spin', '2s'],
  [component('chat/LearningWidget.module.css')]: ['quiz-spin', '0.9s'],
  [component('chat/GeneratedFiles.module.css')]: ['generated-spin', '900ms'],
  [component('chat/FileCard.module.css')]: ['file-spin', '900ms'],
  [component('agenda/TaskComposer.module.css')]: ['spin', '1s'],
  [component('agenda/AiBreakdownDialog.module.css')]: ['spin', '1s'],
  [component('agenda/AgendaPage.module.css')]: ['spin', '1s'],
};

const fadeModules = {
  [component('settings/Settings.module.css')]: ['fade-in', 'var(--t-hover) var(--ease-out)'],
  [component('chat/CreateSpaceDialog.module.css')]: ['backdrop-fade', 'var(--t-ui) var(--ease-out)'],
  [component('settings/EditorDialog.module.css')]: ['backdrop-in', 'var(--t-hover) var(--ease-out)'],
  [component('chat/SubjectPage.module.css')]: ['tab-label-in', 'var(--t-enter) var(--ease) backwards'],
  [component('chat/PlanBar.module.css')]: ['fadeIn', 'var(--t-ui) var(--ease-out) both'],
  [component('chat/Composer.module.css')]: ['ghost-fade', 'var(--t-hover) var(--ease-out)'],
  [component('chat/CheatSheet.module.css')]: ['fade', 'var(--t-hover) var(--ease-out)'],
};

const slideModules = {
  [component('chat/ChatApp.module.css')]: ['drawer-in', '16px', 'var(--t-ui) var(--ease-out)'],
  [component('agenda/TaskInspector.module.css')]: ['slide-in', '12px', 'var(--t-ui) var(--ease)'],
  [component('MaterialPreviewPanel.module.css')]: ['slide-in', '8px', 'var(--t-hover) var(--ease)'],
  [component('chat/LearningWidget.module.css')]: ['stage-in', '8px', 'var(--t-ui) var(--ease-out)'],
};

const darkValues = {
  'bg-app-shell': '#121110',
  'bg-sidebar': '#151412',
  bg: '#1a1917',
  'bg-panel': '#1f1e1b',
  'bg-subtle': '#24221f',
  'bg-elevated': '#242320',
  'bg-hover': 'rgb(255 250 240 / 5%)',
  'bg-active': 'rgb(255 250 240 / 8%)',
  'bg-user-bubble': '#2a2824',
  border: 'rgb(255 250 240 / 8%)',
  'border-subtle': 'rgb(255 250 240 / 5%)',
  'border-strong': 'rgb(255 250 240 / 12%)',
  text: '#ecebe6',
  'text-secondary': '#a3a097',
  'text-tertiary': '#86837b',
  'ink-solid': '#ecebe6',
  'ink-solid-hover': '#d9d7d0',
  'on-ink': '#1a1917',
  accent: '#8aa6d6',
  'accent-hover': '#9db8e4',
  'accent-text': '#9db8e4',
  'accent-soft': 'rgb(138 166 214 / 13%)',
  'accent-soft-strong': 'rgb(138 166 214 / 22%)',
  'on-accent': '#ffffff',
  'accent-solid': '#46639c',
  'accent-solid-hover': '#3a5386',
  green: '#5fb98a',
  'green-soft': 'rgb(95 185 138 / 13%)',
  red: '#d4786a',
  'red-soft': 'rgb(212 120 106 / 13%)',
  amber: '#d4a24a',
  'amber-soft': 'rgb(212 162 74 / 13%)',
  'bg-media': '#ecebe6',
  grey: '#77746c',
  'shadow-card': '0 0 0 1px rgb(255 250 240 / 7%)',
  'shadow-elevated': '0 0 0 1px rgb(255 250 240 / 8%), 0 8px 24px rgb(0 0 0 / 35%)',
  'shadow-popover': '0 0 0 1px rgb(255 250 240 / 10%), 0 16px 40px rgb(0 0 0 / 50%)',
};

test('Markdown enables CJK typography only in reading content and excludes code, inputs and math', () => {
  const css = read('components/chat/Markdown.module.css');
  const markdown = block(css, '.markdown {');
  assert.equal(declaration(markdown.body, 'text-spacing-trim'), 'trim-all');
  assert.equal(declaration(markdown.body, 'text-autospace'), 'normal');

  const excluded = block(css, '.markdown .codeBlock,', markdown.end);
  for (const selector of [
    '.markdown .codeBlock', '.markdown .codeBlock *', '.markdown .pre', '.markdown .pre *',
    '.markdown code', '.markdown kbd', '.markdown samp', '.markdown input', '.markdown textarea',
    '.markdown select', '.markdown [contenteditable="true"]', '.markdown :global(.katex)',
    '.markdown :global(.katex) *',
  ]) {
    assert.ok(excluded.header.includes(selector), `missing typography exclusion: ${selector}`);
  }
  assert.equal(declaration(excluded.body, 'text-spacing-trim'), 'space-all');
  assert.equal(declaration(excluded.body, 'text-autospace'), 'no-autospace');
  assert.ok(markdown.end < excluded.start, 'exclusions must follow the reading rule');

  const body = block(globals, 'body {');
  assert.doesNotMatch(body.body, /text-spacing-trim|text-autospace/, 'global body must stay untouched');
});

test('37 dark tokens keep exact values, one source and literal-free activation mappings', () => {
  const lightRoot = block(globals, ':root {');
  const darkRoot = block(globals, ':root {', lightRoot.end);
  const darkDeclarations = customDeclarations(globals).filter(([name]) => name.startsWith('--dark-'));
  assert.equal(Object.keys(darkValues).length, 37);
  assert.equal(darkDeclarations.length, 37, 'each dark source token must be declared exactly once');
  assert.deepEqual(
    darkDeclarations.map(([name]) => name).sort(),
    Object.keys(darkValues).map((name) => `--dark-${name}`).sort(),
  );

  const system = block(globals, '@media (prefers-color-scheme: dark)', darkRoot.end);
  const explicit = block(globals, ':root[data-theme="dark"]', system.end);
  const colorLiteral = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i;
  for (const [name, value] of Object.entries(darkValues)) {
    assert.equal(declaration(darkRoot.body, `--dark-${name}`), value, `dark source changed: ${name}`);
    for (const [label, activation] of [['system', system], ['explicit', explicit]]) {
      assert.equal(
        declaration(activation.body, `--${name}`),
        `var(--dark-${name})`,
        `${label} dark mapping changed: ${name}`,
      );
    }
  }
  assert.match(system.text, /:root:not\(\[data-theme="light"\]\)/);
  assert.doesNotMatch(system.text, colorLiteral, 'system dark must not contain colour literals');
  assert.doesNotMatch(explicit.text, colorLiteral, 'explicit dark must not contain colour literals');
  assert.equal(declaration(system.body, 'color-scheme'), 'dark');
  assert.equal(declaration(explicit.body, 'color-scheme'), 'dark');
  assert.equal(declaration(lightRoot.body, '--orange'), 'var(--amber)');
  assert.equal(declaration(lightRoot.body, '--orange-soft'), 'var(--amber-soft)');
});

test('public motion tokens expose four durations and exactly two curves', () => {
  const root = block(globals, ':root {');
  const declarations = customDeclarations(root.body);
  const expectedDurations = {
    '--t-press': '100ms', '--t-hover': '160ms', '--t-ui': '220ms', '--t-enter': '360ms',
  };
  for (const [name, value] of Object.entries(expectedDurations)) {
    assert.equal(declaration(root.body, name), value);
  }
  assert.equal(declaration(root.body, '--duration-fast'), 'var(--t-hover)');
  assert.equal(declaration(root.body, '--duration'), 'var(--t-ui)');
  assert.equal(declaration(root.body, '--t-sidebar'), 'var(--t-ui)');
  assert.deepEqual(
    declarations.map(([name]) => name).filter((name) => /^--t-/.test(name)).sort(),
    ['--t-enter', '--t-hover', '--t-press', '--t-sidebar', '--t-ui'],
    'a fifth public t-* duration is not allowed',
  );
  assert.deepEqual(
    declarations.map(([name]) => name).filter((name) => /^--duration(?:-|$)/.test(name)).sort(),
    ['--duration', '--duration-fast'],
    'duration aliases must not introduce another scale',
  );

  const curves = declarations.filter(([name]) => /^--ease(?:-|$)/.test(name));
  assert.deepEqual(curves.map(([name]) => name).sort(), ['--ease', '--ease-out', '--ease-spring']);
  assert.equal(declaration(root.body, '--ease'), 'cubic-bezier(0.16, 1, 0.3, 1)');
  assert.equal(declaration(root.body, '--ease-out'), 'cubic-bezier(0.22, 1, 0.36, 1)');
  assert.equal(declaration(root.body, '--ease-spring'), 'var(--ease)');
  assert.equal(new Set(curves.filter(([, value]) => value.startsWith('cubic-bezier(')).map(([, value]) => value)).size, 2);
});

test('three shared keyframes are unique and preserve their common semantics', () => {
  const names = [...globals.matchAll(/@keyframes\s+(kg-[\w-]+)/g)].map((match) => match[1]);
  assert.deepEqual(names.sort(), ['kg-fade-in', 'kg-slide-in-right', 'kg-spin']);

  const spin = block(globals, '@keyframes kg-spin');
  assert.match(spin.body, /transform:\s*rotate\(360deg\)/);
  assert.doesNotMatch(spin.body, /translate|scale|opacity/);

  const fade = block(globals, '@keyframes kg-fade-in');
  assert.match(fade.body, /from\s*\{\s*opacity:\s*0;/);
  assert.match(fade.body, /to\s*\{\s*opacity:\s*1;/);
  assert.doesNotMatch(fade.body, /transform/);

  const slide = block(globals, '@keyframes kg-slide-in-right');
  assert.match(slide.body, /opacity:\s*0/);
  assert.match(slide.body, /translateX\(var\(--motion-slide-distance, 8px\)\)/);
  assert.match(slide.body, /opacity:\s*1/);
  assert.match(slide.body, /translateX\(0\)/);
});

test('all 18 spin modules use kg-spin without losing cycles or removing other keyframes', () => {
  assert.equal(Object.keys(spinModules).length, 18);
  for (const [file, [original, cycle]] of Object.entries(spinModules)) {
    const css = assertGlobalAnimation(file, 'kg-spin', `${cycle} linear infinite`);
    assertRemovedKeyframe(css, original, file);
  }
  const messageList = read(component('chat/MessageList.module.css'));
  assert.match(messageList, /animation:\s*global\(kg-spin\)\s+2s linear infinite/);
});

test('all 7 fade modules use kg-fade-in and remove only their old pure-fade definitions', () => {
  assert.equal(Object.keys(fadeModules).length, 7);
  for (const [file, [original, parameters]] of Object.entries(fadeModules)) {
    const css = assertGlobalAnimation(file, 'kg-fade-in', parameters);
    assertRemovedKeyframe(css, original, file);
  }
  assert.match(read(component('chat/PlanBar.module.css')), /global\(kg-fade-in\)[^;]*both/);
  assert.match(read(component('chat/SubjectPage.module.css')), /global\(kg-fade-in\)[^;]*backwards/);
});

test('all 4 slide modules use kg-slide-in-right with their original distances and timing', () => {
  assert.equal(Object.keys(slideModules).length, 4);
  for (const [file, [original, distance, parameters]] of Object.entries(slideModules)) {
    const css = assertGlobalAnimation(file, 'kg-slide-in-right', parameters);
    assertRemovedKeyframe(css, original, file);
    assert.equal(declaration(css, '--motion-slide-distance'), distance, `${file} slide distance changed`);
  }
});

test('specialized keyframes and non-spin loop periods remain intact', () => {
  const retained = {
    [component('chat/WorkingIndicator.module.css')]: ['working-orbit', 'working-morph', 'working-twinkle'],
    [component('ThemeToggle.module.css')]: ['spin-in'],
    [component('chat/widgets/VisualCard.module.css')]: ['building-sweep', 'pulse'],
    [component('chat/MemoryDrawer.module.css')]: ['drawer-in'],
    [component('settings/Settings.module.css')]: ['settings-pop', 'enter', 'blink', 'pane-enter'],
    [component('chat/CreateSpaceDialog.module.css')]: ['modal-spring', 'popover-spring', 'icon-pop'],
    [component('chat/PlanBar.module.css')]: ['barIn', 'rowFlash', 'pop'],
    [component('chat/SubjectPage.module.css')]: ['panel-view-in', 'breathe', 'subject-modal'],
    [component('chat/LearningWidget.module.css')]: ['live-sweep', 'part-in', 'icon-pop', 'quiz-shake'],
  };
  for (const [file, names] of Object.entries(retained)) {
    const css = read(file);
    for (const name of names) {
      assert.match(css, new RegExp(`@keyframes\\s+${escapeRegExp(name)}\\b`), `${file} lost ${name}`);
    }
  }

  const working = read(component('chat/WorkingIndicator.module.css'));
  assert.match(working, /animation:\s*working-orbit 16s ease-in-out infinite/);
  assert.match(working, /animation:\s*working-morph 16s cubic-bezier\(0\.45, 0, 0\.2, 1\) infinite/);
  assert.match(working, /animation:\s*working-twinkle 1\.8s ease-in-out var\(--delay\) infinite/);
  assert.match(block(working, '@keyframes working-orbit').body, /rotate\(720deg\)/);
  assert.match(block(read(component('ThemeToggle.module.css')), '@keyframes spin-in').body, /rotate\(-60deg\)/);

  const visual = read(component('chat/widgets/VisualCard.module.css'));
  assert.match(visual, /animation:\s*building-sweep 1\.5s var\(--ease\) infinite/);
  assert.match(visual, /animation:\s*pulse 1\.2s ease-in-out infinite/);
  assert.match(visual, /animation:\s*pulse 1\.8s ease-in-out infinite/);
});

test('host application and system reduced-motion rules still stop animation, transition and loops', () => {
  const application = block(globals, ':root[data-motion="reduced"],');
  for (const selector of [
    ':root[data-motion="reduced"]', ':root[data-motion="reduced"] *',
    ':root[data-motion="reduced"] *::before', ':root[data-motion="reduced"] *::after',
  ]) {
    assert.ok(application.header.includes(selector), `missing application reduced-motion selector: ${selector}`);
  }
  const system = block(globals, '@media (prefers-reduced-motion: reduce)', application.end);
  for (const rule of [application, system]) {
    assert.equal(declaration(rule.body, 'animation-duration'), '0.01ms !important');
    assert.equal(declaration(rule.body, 'animation-delay'), '0ms !important');
    assert.equal(declaration(rule.body, 'animation-iteration-count'), '1 !important');
    assert.equal(declaration(rule.body, 'transition-duration'), '0.01ms !important');
    assert.equal(declaration(rule.body, 'scroll-behavior'), 'auto !important');
  }
  assert.match(system.text, /\*::before,\s*\*::after/);

  for (const file of [
    component('chat/WorkingIndicator.module.css'), component('chat/widgets/VisualCard.module.css'),
    component('chat/LearningWidget.module.css'), component('agenda/AiBreakdownDialog.module.css'),
  ]) {
    assert.match(read(file), /@media \(prefers-reduced-motion: reduce\)/, `${file} lost system reduction`);
  }
  assert.match(read(component('chat/LearningWidget.module.css')), /:root\[data-motion="reduced"\]/);
  assert.match(read(component('chat/WorkingIndicator.module.css')), /:global\(:root\[data-motion="reduced"\]\)/);
});

test('sandbox disables animation and transition for both application and system reduction', () => {
  const applicationRule = ':root[data-motion=reduced] *,:root[data-motion=reduced] *::before,:root[data-motion=reduced] *::after{transition:none!important;animation:none!important}';
  const systemRule = '@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}';
  assert.ok(sandbox.includes(applicationRule), 'sandbox application reduction must cover elements and pseudo-elements');
  assert.ok(sandbox.includes(systemRule), 'sandbox system reduction must cover elements and pseudo-elements');
  assert.match(sandbox, /document\.documentElement\.dataset\.motion = e\.data\.motionReduced === true \? "reduced" : "normal"/);
});