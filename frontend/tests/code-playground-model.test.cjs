// 代码实验台的纯函数与接口映射：不需要浏览器，也不需要额外测试依赖。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-playground-'));
const files = [
  'lib/config.ts', 'lib/api/errors.ts', 'lib/api/http-client.ts', 'lib/api/sandbox-client.ts',
  'components/chat/widgets/codePlaygroundModel.ts',
];
for (const name of files) {
  const output = path.join(temp, name.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  let js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  js = js.replace(/require\("@\/([^\"]+)"\)/g, (_, specifier) => {
    const relative = path.relative(path.dirname(output), path.join(temp, specifier + '.js')).replace(/\\/g, '/');
    return `require("./${relative.startsWith('.') ? relative : './' + relative}")`;
  });
  fs.writeFileSync(output, js);
}
const model = require(path.join(temp, 'components/chat/widgets/codePlaygroundModel.js'));
const client = require(path.join(temp, 'lib/api/sandbox-client.js'));
const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; fs.rmSync(temp, { recursive: true, force: true }); });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ------------------------------------------------------------------ 解析

test('解析：语言别名、字段别名与默认值', () => {
  const parsed = model.parseCodePlaygroundSpec({
    type: 'code_playground', language: 'C++', starter_code: 'int main(){}\r\n// TODO: 补',
    test_cases: [{ input: 3, expected_output: 9 }, { stdin: 'x', output: 'y', name: '自定义' }, 'bad', null],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spec.language, 'cpp');
  assert.equal(parsed.spec.mode, 'scaffold');
  assert.equal(parsed.spec.title, '代码实验台');
  assert.equal(parsed.spec.starterCode, 'int main(){}\n// TODO: 补');
  assert.deepEqual(parsed.spec.testCases, [
    { name: '用例 1', input: '3', expected: '9' },
    { name: '自定义', input: 'x', expected: 'y' },
  ]);
});

test('解析：没有脚手架时退化成自由编写', () => {
  const parsed = model.parseCodePlaygroundSpec({ language: 'js', starter_code: '   ' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spec.language, 'javascript');
  assert.equal(parsed.spec.mode, 'free');
  assert.equal(model.parseCodePlaygroundSpec({ language: 'python', mode: 'free', starter_code: 'x' }).spec.mode, 'free');
});

test('解析：不支持的语言给出原因，不抛异常', () => {
  const parsed = model.parseCodePlaygroundSpec({ language: 'ruby' });
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /ruby/);
  assert.match(parsed.reason, /Python、JavaScript、C、C\+\+/);
  assert.equal(model.parseCodePlaygroundSpec({}).ok, false);
  assert.equal(model.parseCodePlaygroundSpec({ language: 42 }).ok, false);
});

test('解析：用例数量和长度被截断到后端上限', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ input: String(i), expected: 'x'.repeat(20_000) }));
  const parsed = model.parseCodePlaygroundSpec({ language: 'python', starter_code: 'x', test_cases: many });
  assert.equal(parsed.spec.testCases.length, 10);
  assert.equal(parsed.spec.testCases[0].expected.length, 10_000);
  const tooLong = model.parseCodePlaygroundSpec({ language: 'python', starter_code: 'x'.repeat(20_001) });
  assert.equal(tooLong.ok, false);
});

test('TODO 计数同时认 # 和 //', () => {
  assert.equal(model.countTodos('x = 1\n# TODO: a\n  // TODO b\nprint(1)  # todo 小写不算'), 2);
  assert.equal(model.countTodos('no todo here'), 0);
  assert.equal(model.countTodos('#TODO\n// TODOS 也算前缀匹配之外'), 1);
});

// ------------------------------------------------------------------ 诊断提示词

function failedResult(overrides = {}) {
  return client.mapSandboxResult({
    ok: false, status: 'compile_error', message: '编译失败。请根据下面的报错修改代码。', language: 'c',
    stdout: '', stderr: "main.c:3:5: error: expected ';'", exit_code: -1, blocked: [],
    compile: {
      ok: false, stdout: '', stderr: "main.c:3:5: error: expected ';'\n    3 | printf(\"hi\")", duration_ms: 12,
      diagnostics: [{ line: 3, column: 5, severity: 'error', message: "expected ';'" }],
    },
    test_results: [], passed: 0, total: 0, diagnostics: [], time_limit_seconds: 3, ...overrides,
  });
}

test('诊断提示词：同时包含代码、报错和行号，且不要求直接给答案', () => {
  const prompt = model.buildDiagnosisPrompt({
    title: '补全 printf', language: 'c', instructions: '输出 hi', code: '#include <stdio.h>\nint main(){printf("hi")}',
    result: failedResult(),
  });
  assert.match(prompt, /补全 printf/);
  assert.match(prompt, /我的代码/);
  assert.match(prompt, /printf\("hi"\)/);
  assert.match(prompt, /编译器报错/);
  assert.match(prompt, /main\.c:3:5: error/);
  assert.match(prompt, /不要直接给完整答案/);
  assert.ok(prompt.length <= model.MAX_PROMPT_CHARS);
});

test('诊断提示词：围栏比代码里最长的反引号串更长', () => {
  const code = 'const s = `a`;\n```\nnot a fence\n```';
  const prompt = model.buildDiagnosisPrompt({ title: 't', language: 'javascript', code, result: failedResult() });
  assert.ok(prompt.includes('````javascript\n' + code + '\n````'), prompt);
});

test('诊断提示词：超长代码和报错被截断到聊天输入框上限内', () => {
  const huge = 'x'.repeat(20_000);
  const prompt = model.buildDiagnosisPrompt({
    title: 't', language: 'c', code: huge,
    result: failedResult({ compile: { ok: false, stdout: '', stderr: huge, diagnostics: [], duration_ms: 1 } }),
  });
  assert.ok(prompt.length <= model.MAX_PROMPT_CHARS, prompt.length);
  assert.match(prompt, /已截断/);
  const backticks = model.buildDiagnosisPrompt({ title: 't', language: 'c', code: '`'.repeat(15_000), result: failedResult() });
  assert.ok(backticks.length <= model.MAX_PROMPT_CHARS);
});

test('诊断提示词：被黑名单拦截时说明规则，测试用例失败时带期望与实际', () => {
  const blocked = failedResult({
    status: 'blocked', message: '代码触发了安全黑名单，未执行。', compile: null,
    blocked: [{ rule_id: 'PROC-01', category: '进程与系统', description: '禁止启动子进程。', line: 2, excerpt: 'os.system("dir")' }],
  });
  const p1 = model.buildDiagnosisPrompt({ title: 't', language: 'python', code: 'import os', result: blocked });
  assert.match(p1, /安全黑名单/);
  assert.match(p1, /PROC-01（第 2 行）/);

  const mismatch = client.mapSandboxResult({
    ok: false, status: 'failed', message: '1/2 个测试用例通过。', language: 'python', stdout: '8', stderr: '',
    exit_code: 0, blocked: [], compile: { ok: true, stdout: '', stderr: '', diagnostics: [], duration_ms: 5 },
    test_results: [{
      index: 1, name: '用例2', input: '4', expected: '9', status: 'failed', passed: false, stdout: '8', stderr: '',
      exit_code: 0, exit_note: null, duration_ms: 20, truncated: false, timed_out: false, diagnostics: [],
    }],
    passed: 1, total: 2, diagnostics: [], time_limit_seconds: 3,
  });
  const p2 = model.buildDiagnosisPrompt({ title: 't', language: 'python', code: 'print(2*int(input()))', result: mismatch });
  assert.match(p2, /用例2/);
  assert.match(p2, /期望输出/);
  assert.match(p2, /实际输出/);
});

// ------------------------------------------------------------------ 接口映射

test('映射：snake_case 转 camelCase，缺字段时给安全默认值', () => {
  const mapped = client.mapSandboxResult({ ok: true, status: 'ok', message: 'done', language: 'python' });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.exitCode, -1);
  assert.deepEqual(mapped.testResults, []);
  assert.equal(mapped.compile, null);
  assert.equal(mapped.timeLimitSeconds, 3);

  const full = failedResult();
  assert.equal(full.compile.diagnostics[0].line, 3);
  assert.equal(full.compile.diagnostics[0].column, 5);
  assert.equal(full.compile.durationMs, 12);
});

test('runSandbox：请求体字段名与后端契约一致，错误保留后端中文说明', async () => {
  let seen;
  global.fetch = async (url, init) => {
    seen = { url: String(url), init, body: JSON.parse(init.body) };
    return json({ ok: true, status: 'ok', message: 'done', language: 'python', stdout: 'hi\n', exit_code: 0 });
  };
  const result = await client.runSandbox({
    language: 'python', code: 'print("hi")', stdin: 'in',
    testCases: [{ name: 'a', input: '1', expected: '2' }, { input: '3' }],
  });
  assert.match(seen.url, /\/api\/sandbox\/run$/);
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(seen.body, {
    language: 'python', code: 'print("hi")', stdin: 'in',
    test_cases: [{ name: 'a', input: '1', expected: '2' }, { input: '3', expected: null }],
  });
  assert.equal(result.stdout, 'hi\n');

  global.fetch = async () => json({ detail: '沙盒正忙，请稍后重试。' }, 429);
  await assert.rejects(() => client.runSandbox({ language: 'python', code: 'x' }), (error) => {
    assert.match(error.message, /沙盒正忙/);
    return true;
  });
  global.fetch = async () => json({ detail: '找不到 gcc，无法编译 C 代码。' }, 503);
  await assert.rejects(() => client.runSandbox({ language: 'c', code: 'x' }), /找不到 gcc/);
});
