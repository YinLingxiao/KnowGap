const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { releasePlan, publicationPlan, compareVersions } = require('../../scripts/release-plan.cjs');

const sha = 'a'.repeat(40);
const plan = { version: '0.7.3', tag: 'v0.7.3', notes: 'docs/release-notes-v0.7.3.md' };
function remote(responses = {}) {
  return { repository: 'YinLingxiao/KnowGap', sha, request: async (url) => {
    const key = url.split('/YinLingxiao/KnowGap/')[1];
    const body = responses[key];
    const status = typeof body === 'number' ? body : body ? 200 : 404;
    return { status, ok: status === 200, json: async () => body };
  } };
}

test('release metadata requires matching stable versions and versioned notes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'desktop'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'desktop/package.json'), JSON.stringify({ version: plan.version }));
  fs.writeFileSync(path.join(root, 'desktop/package-lock.json'), JSON.stringify({ version: plan.version, packages: { '': { version: plan.version } } }));
  assert.throws(() => releasePlan(root), /notes/);
  fs.writeFileSync(path.join(root, plan.notes), '# Change log');
  assert.equal(releasePlan(root).tag, plan.tag);
  fs.writeFileSync(path.join(root, 'desktop/package.json'), JSON.stringify({ version: '0.7.3-preview.1' }));
  assert.throws(() => releasePlan(root), /stable/);
  fs.writeFileSync(path.join(root, 'desktop/package.json'), JSON.stringify({ version: '0.7.4' }));
  assert.throws(() => releasePlan(root), /disagree/);
  assert.equal(compareVersions('0.7.10', '0.7.9'), 1);
});

test('a new stable release is eligible, while an existing published release is immutable', async () => {
  assert.equal((await publicationPlan(plan, remote({ 'releases/latest': { tag_name: 'v0.7.2' } }))).shouldPublish, true);
  assert.equal((await publicationPlan(plan, remote({ [`releases/tags/${plan.tag}`]: { draft: false } }))).shouldPublish, false);
  await assert.rejects(publicationPlan(plan, remote({ 'releases/latest': { tag_name: 'v0.7.4' } })), /higher/);
  await assert.rejects(publicationPlan(plan, remote({ 'releases/latest': 403 })), /HTTP 403/);
});

test('draft retries and existing tags must belong to the exact workflow commit', async () => {
  const draft = { draft: true, target_commitish: sha };
  assert.equal((await publicationPlan(plan, remote({ [`releases/tags/${plan.tag}`]: draft }))).draftExists, true);
  await assert.rejects(publicationPlan(plan, remote({ [`releases/tags/${plan.tag}`]: { ...draft, target_commitish: 'main' } })), /different commit/);
  await assert.rejects(publicationPlan(plan, remote({ [`git/ref/tags/${plan.tag}`]: { object: { type: 'commit', sha: 'b'.repeat(40) } } })), /different commit/);
  assert.equal((await publicationPlan(plan, remote({ [`git/ref/tags/${plan.tag}`]: { object: { type: 'commit', sha } } }))).shouldPublish, true);
  await assert.rejects(publicationPlan(plan, { ...remote(), repository: 'fork/KnowGap' }), /official/);
});

test('PR builds cannot publish and only the protected release job receives write permission', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../../.github/workflows/desktop-release.yml'), 'utf8'));
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.jobs.build.permissions, undefined);
  assert.equal(workflow.jobs.publish.needs, 'build');
  assert.match(workflow.jobs.publish.if, /github\.repository == 'YinLingxiao\/KnowGap'/);
  assert.match(workflow.jobs.publish.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow.jobs.publish.if, /github\.event_name != 'pull_request'/);
  assert.equal(workflow.jobs.publish.permissions.contents, 'write');
  assert(workflow.jobs.build.steps.some(step => step.run?.includes('smoke-desktop.py')));
});
