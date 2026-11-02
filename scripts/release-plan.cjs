// Release metadata validation and read-only GitHub preflight. Never publishes.
const fs = require('node:fs');
const path = require('node:path');

const OFFICIAL_REPO = 'YinLingxiao/KnowGap';
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function compareVersions(a, b) {
  if (!STABLE.test(a) || !STABLE.test(b)) throw new Error('Expected a stable x.y.z version');
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

function releasePlan(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package-lock.json'), 'utf8'));
  if (!STABLE.test(pkg.version)) throw new Error('Desktop releases require a stable x.y.z version');
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('Desktop package and lockfile versions disagree');
  }
  const tag = `v${pkg.version}`;
  const notes = `docs/release-notes-${tag}.md`;
  if (!fs.existsSync(path.join(root, notes)) || !fs.readFileSync(path.join(root, notes), 'utf8').trim()) {
    throw new Error(`Missing release notes: ${notes}`);
  }
  return { version: pkg.version, tag, notes, shouldPublish: false };
}

async function publicationPlan(plan, { repository, sha, token, request = fetch }) {
  if (repository !== OFFICIAL_REPO || !/^[a-f0-9]{40}$/.test(sha || '')) {
    throw new Error('Publishing is restricted to an exact commit in the official repository');
  }
  const get = async (suffix) => {
    const response = await request(`https://api.github.com/repos/${repository}/${suffix}`, {
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub release preflight failed (HTTP ${response.status})`);
    return response.json();
  };
  const existing = await get(`releases/tags/${plan.tag}`);
  // A merged non-release PR or a repeated run must not replace a published asset.
  if (existing && !existing.draft) return { ...plan, shouldPublish: false };
  const latest = await get('releases/latest');
  if (latest) {
    const version = String(latest.tag_name).replace(/^v/, '');
    if (!STABLE.test(version) || compareVersions(plan.version, version) <= 0) {
      throw new Error('The new desktop version must be higher than the latest published stable release');
    }
  }
  if (existing && existing.target_commitish !== sha) throw new Error('A draft release belongs to a different commit');
  let ref = await get(`git/ref/tags/${plan.tag}`);
  let object = ref?.object;
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    const tag = await get(`git/tags/${object.sha}`);
    object = tag?.object;
  }
  if (ref && (object?.type !== 'commit' || object.sha !== sha)) throw new Error('The release tag points to a different commit');
  return { ...plan, shouldPublish: true, draftExists: Boolean(existing) };
}

module.exports = { releasePlan, publicationPlan, compareVersions };
if (require.main === module) {
  (async () => {
    const root = path.resolve(__dirname, '..');
    let plan = releasePlan(root);
    if (process.argv.includes('--github')) plan = await publicationPlan(plan, {
      repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA,
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    });
    console.log(JSON.stringify(plan));
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
