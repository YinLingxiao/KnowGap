// 资料上传队列：后台并发上传、取消（断开请求并删掉已存的）、失败重试。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const file = path.join(__dirname, '../src/lib/materials/uploads.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const { createUploadQueue, sizeText, sameFile } = mod.exports;

const tick = () => new Promise((resolve) => setImmediate(resolve));
const fakeFile = (name, size = 1000) => ({ name, size });

/** 每次上传返回一个可以从外面完成或失败的 promise，并记录收到的取消信号 */
function controlledUploader() {
  const calls = [];
  const upload = (file, subjectId, signal) => new Promise((resolve, reject) => {
    calls.push({ file, subjectId, signal, resolve, reject });
  });
  return { calls, upload };
}

test('uploads run in the background two at a time and leave the queue when done', async () => {
  const { calls, upload } = controlledUploader();
  const queue = createUploadQueue(upload, { concurrency: 2 });
  const done = [];
  queue.watch((event) => done.push(event));
  queue.enqueue(['a.pdf', 'b.pptx', 'c.docx', 'd.md', 'e.xlsx'].map((name) => fakeFile(name)), 'space-1');

  assert.equal(queue.snapshot().length, 5, 'no file is dropped, however many are picked');
  assert.deepEqual(queue.snapshot().map((job) => job.state), ['uploading', 'uploading', 'queued', 'queued', 'queued']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].subjectId, 'space-1');

  calls[0].resolve({ id: 'material-a', title: 'a.pdf' });
  await tick();
  assert.equal(calls.length, 3, 'the next file starts as soon as one finishes');
  assert.deepEqual(queue.snapshot().map((job) => job.name), ['b.pptx', 'c.docx', 'd.md', 'e.xlsx']);
  assert.equal(done[0].type, 'done');
  assert.equal(done[0].material.id, 'material-a');

  for (const call of calls.slice(1)) call.resolve({ id: `material-${call.file.name}` });
  await tick();
  for (const call of calls.slice(3)) call.resolve({ id: `material-${call.file.name}` });
  await tick();
  assert.equal(calls.length, 5);
  assert.deepEqual(queue.snapshot(), []);
  assert.equal(done.filter((event) => event.type === 'done').length, 5);
});

test('cancelling aborts the request, drops the job and starts the next one', async () => {
  const { calls, upload } = controlledUploader();
  const discarded = [];
  const queue = createUploadQueue(upload, { concurrency: 1, discard: async (material) => { discarded.push(material.id); } });
  const [first, second, third] = queue.enqueue([fakeFile('wrong.pptx'), fakeFile('right.pdf'), fakeFile('later.md')], 'space-1');

  queue.cancel(third.id);
  assert.deepEqual(queue.snapshot().map((job) => job.name), ['wrong.pptx', 'right.pdf'], 'a queued file can be taken back');

  queue.cancel(first.id);
  assert.equal(calls[0].signal.aborted, true, 'the request is cut, so the backend stops reading it');
  assert.deepEqual(queue.snapshot().map((job) => [job.name, job.state]), [['right.pdf', 'uploading']]);
  assert.equal(calls[1].file.name, 'right.pdf');

  // 后端在断开前刚好存好了：结果回来时删掉，不留下撤回的资料
  calls[0].resolve({ id: 'material-wrong' });
  await tick();
  assert.deepEqual(discarded, ['material-wrong']);
  assert.equal(second.name, 'right.pdf');
});

test('a failed upload stays with its reason and can be retried or removed', async () => {
  const { calls, upload } = controlledUploader();
  const queue = createUploadQueue(upload, { concurrency: 2 });
  const events = [];
  queue.watch((event) => events.push(event.type));
  const [job] = queue.enqueue([fakeFile('scan.pdf')], null);

  calls[0].reject(new Error('没有提取到文字，请选择包含文字的资料。'));
  await tick();
  assert.deepEqual(queue.snapshot().map((item) => [item.state, item.error]), [['failed', '没有提取到文字，请选择包含文字的资料。']]);
  assert.deepEqual(events, ['failed']);

  queue.retry(job.id);
  assert.equal(queue.snapshot()[0].state, 'uploading');
  assert.equal(calls.length, 2);
  calls[1].reject(new Error('again'));
  await tick();

  queue.cancel(job.id);
  assert.deepEqual(queue.snapshot(), []);
});

test('listeners hear every change and can unsubscribe', () => {
  const { upload } = controlledUploader();
  const queue = createUploadQueue(upload);
  let heard = 0;
  const stop = queue.subscribe(() => { heard += 1; });
  queue.enqueue([fakeFile('a.md')], null);
  assert.ok(heard > 0);
  const before = heard;
  stop();
  queue.enqueue([fakeFile('b.md')], null);
  assert.equal(heard, before);
});

test('size text and duplicate check', () => {
  assert.equal(sizeText(512), '512 B');
  assert.equal(sizeText(300 * 1024), '300 KB');
  assert.equal(sizeText(3.44 * 1024 * 1024), '3.4 MB');
  assert.equal(sizeText(42 * 1024 * 1024), '42 MB');
  assert.equal(sameFile({ name: 'a.pdf', size: 1 }, { name: 'a.pdf', size: 1 }), true);
  assert.equal(sameFile({ name: 'a.pdf', size: 1 }, { name: 'a.pdf', size: 2 }), false);
});

test('long names keep their ending visible', () => {
  const { splitName } = mod.exports;
  assert.deepEqual(splitName('第六章.md'), ['第六章.md', '']);
  const [head, tail] = splitName('Making_Suggestions_Socializing_Business_Edition_Arial_Topic_Quiz_Final.pptx');
  assert.equal(tail, 'c_Quiz_Final.pptx'.slice(-16));
  assert.equal(head + tail, 'Making_Suggestions_Socializing_Business_Edition_Arial_Topic_Quiz_Final.pptx');
});
