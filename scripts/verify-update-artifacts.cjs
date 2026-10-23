// Shared by the release preflight and its tests. No network or build side effects.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const yaml = require(require.resolve('js-yaml', { paths: [path.join(__dirname, '../desktop')] }));

function verifyArtifacts({ packageFile, dist, tag, expectedSha256 }) {
  const { version } = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}`) throw new Error('标签必须为 v<desktop/package.json 版本>，且必须是正式版本。');
  const name = `KnowGap-Setup-${version}.exe`;
  const manifest = path.resolve(dist, 'latest.yml');
  const installer = path.resolve(dist, name);
  const blockmap = `${installer}.blockmap`;
  for (const file of [manifest, installer, blockmap]) {
    if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error(`缺少或为空的产物：${path.basename(file)}`);
  }
  const info = yaml.load(fs.readFileSync(manifest, 'utf8'));
  if (info?.version !== version || info.path !== name || info.files?.length !== 1 || info.files[0].url !== name) {
    throw new Error('latest.yml 的版本、path 和 files.url 必须与无空格的安装包文件名完全一致。禁止手动重命名。');
  }
  const data = fs.readFileSync(installer);
  const sha512 = crypto.createHash('sha512').update(data).digest('base64');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
  if (info.sha512 !== sha512 || info.files[0].sha512 !== sha512 || info.files[0].size !== data.length) {
    throw new Error('安装包大小或 SHA512 与 latest.yml 不一致，请重新构建，不要手工修改校验值。');
  }
  // electron-builder's standard latest.yml has SHA512, not SHA256. Verify optional
  // SHA256 if supplied; always print the independently computed SHA256 for review.
  for (const value of [info.sha256, info.files[0].sha256, expectedSha256].filter((value) => value !== undefined)) {
    if (typeof value !== 'string' || value.toUpperCase() !== sha256) throw new Error('SHA256 不一致。');
  }
  const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(blockmap)));
  if (!map.version || !Array.isArray(map.files) || !map.files.length) throw new Error('blockmap 格式无效。');
  return { version, tag, manifest, installer, blockmap, size: data.length, sha512, sha256 };
}

module.exports = { verifyArtifacts };
if (require.main === module) {
  try {
    const [packageFile, dist, tag, expectedSha256] = process.argv.slice(2);
    const result = verifyArtifacts({ packageFile, dist, tag, expectedSha256: expectedSha256 || undefined });
    // Windows PowerShell 5.1 may decode native stdout with an ANSI code page.
    // ASCII JSON escapes preserve Chinese workspace paths without mutating console settings.
    console.log(JSON.stringify(result).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
  } catch (error) {
    console.error(`发布校验失败：${error.message}`);
    process.exitCode = 1;
  }
}
