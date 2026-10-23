const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { verifyArtifacts } = require('../../scripts/verify-update-artifacts.cjs');

function fixture(t) {
  const approvedTemp = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : os.tmpdir();
  fs.mkdirSync(approvedTemp, { recursive: true });
  const dir = fs.mkdtempSync(path.join(approvedTemp, 'knowgap-release-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = Buffer.from('unit test only, NOT an executable');
  const sha512 = crypto.createHash('sha512').update(data).digest('base64');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
  const name = 'KnowGap-Setup-0.5.6.exe';
  const manifest = path.join(dir, 'latest.yml');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.5.6' }));
  fs.writeFileSync(path.join(dir, name), data);
  fs.writeFileSync(path.join(dir, `${name}.blockmap`), zlib.gzipSync(JSON.stringify({ version: '2', files: [{}] })));
  const text = `version: 0.5.6\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${data.length}\npath: ${name}\nsha512: ${sha512}\n`;
  fs.writeFileSync(manifest, text);
  return { dir, name, text, manifest, sha256, options: { packageFile: path.join(dir, 'package.json'), dist: dir, tag: 'v0.5.6' } };
}

test('release preflight validates three artifacts, exact names, size, SHA512 and independent SHA256', t => {
  const f = fixture(t);
  assert.equal(verifyArtifacts(f.options).sha256, f.sha256);
  assert.equal(verifyArtifacts({ ...f.options, expectedSha256: f.sha256 }).version, '0.5.6');
  assert.throws(() => verifyArtifacts({ ...f.options, expectedSha256: 'BAD' }), /SHA256/);
});

test('release preflight rejects wrong tags, metadata versions and renamed GitHub assets', t => {
  const f = fixture(t);
  for (const tag of ['0.5.6', 'v0.5.5', 'v0.5.6-beta.1']) assert.throws(() => verifyArtifacts({ ...f.options, tag }), /标签/);
  for (const text of [f.text.replace('version: 0.5.6', 'version: 0.5.7'),
    f.text.replaceAll(f.name, 'KnowGap.Setup.0.5.6.exe'), f.text.replaceAll(f.name, '../KnowGap-Setup-0.5.6.exe')]) {
    fs.writeFileSync(f.manifest, text);
    assert.throws(() => verifyArtifacts(f.options), /文件名/);
  }
});

test('release preflight fails closed when manifest, installer or blockmap is missing', t => {
  for (const kind of ['latest.yml', 'KnowGap-Setup-0.5.6.exe', 'KnowGap-Setup-0.5.6.exe.blockmap']) {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.dir, kind));
    assert.throws(() => verifyArtifacts(f.options));
  }
});

test('release preflight rejects tampered bytes, wrong size, wrong optional SHA256 and corrupt blockmap', t => {
  const f = fixture(t);
  fs.writeFileSync(f.manifest, f.text.replace(/size: \d+/, 'size: 1'));
  assert.throws(() => verifyArtifacts(f.options), /SHA512/);
  fs.writeFileSync(f.manifest, `${f.text}sha256: WRONG\n`);
  assert.throws(() => verifyArtifacts(f.options), /SHA256/);
  fs.writeFileSync(f.manifest, f.text);
  fs.writeFileSync(path.join(f.dir, `${f.name}.blockmap`), 'corrupted');
  assert.throws(() => verifyArtifacts(f.options));
  fs.appendFileSync(path.join(f.dir, f.name), 'tampered');
  assert.throws(() => verifyArtifacts(f.options), /SHA512/);
});

test('publish script requires confirmation and an existing remote tag; no build/push/tag side effects', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../scripts/publish-release.ps1'), 'utf8');
  assert.match(script, /Read-Host/);
  assert.match(script, /--verify-tag/);
  assert.match(script, /--notes-file \$notes/);
  assert.match(script, /if \(\$CheckOnly\)[^\n]*return/);
  assert.doesNotMatch(script, /git push|git tag|npm run|build-desktop\.ps1/);
});
