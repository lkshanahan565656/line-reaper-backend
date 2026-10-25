// The live check every thread runs after its merge deploys, in one command:
//   npm run live-check -- 3.171.0
// It pushes a commit to the diag-e2e-smoke branch (a workflow there waits for
// the site to show that version, then runs e2e/smoke.js in a real browser on
// GitHub Actions), waits for the result on diag-e2e-smoke-out, prints it and
// exits 0 on a pass, 1 on a failure. The result also shows in /api/ops under
// liveCheck. No version: check whatever is live now.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) { if (i >= tries) throw e; await sleep(2000 * 2 ** i); }
  }
}

async function main() {
  const want = process.argv[2] || '';
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const remote = git(['remote', 'get-url', 'origin'], ROOT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-live-check-'));
  git(['init', '-q'], dir);
  git(['remote', 'add', 'origin', remote], dir);
  let parent = null;
  try { await retry(() => git(['fetch', '-q', 'origin', 'diag-e2e-smoke'], dir), 2); parent = git(['rev-parse', 'FETCH_HEAD'], dir); } catch { /* first run */ }
  git(['checkout', '-q', '--orphan', 'diag-e2e-smoke'], dir);
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'smoke-branch', 'smoke.yml'), path.join(dir, '.github', 'workflows', 'smoke.yml'));
  for (const f of ['crawl.js', 'page-helpers.js', 'smoke.js', 'live-safety.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, 'e2e', f));
  fs.writeFileSync(path.join(dir, 'WANT'), `${want}\n${nonce}\n`);
  git(['add', '-A'], dir);
  const tree = git(['write-tree'], dir);
  const msg = `live check ${want || 'now'} (${nonce})`;
  const commit = execFileSync('git', ['-c', 'user.name=live-check', '-c', 'user.email=live-check@line-reaper', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', msg], { cwd: dir, encoding: 'utf8' }).trim();
  await retry(() => git(['push', '-q', 'origin', `${commit}:refs/heads/diag-e2e-smoke`], dir));
  console.log(`pushed ${msg}; waiting for the smoke on GitHub Actions (deploy swap about 8 min, then about 3 min of clicking)`);
  const t0 = Date.now();
  while (Date.now() - t0 < 45 * 60e3) {
    await sleep(30e3);
    try {
      git(['fetch', '-q', 'origin', 'diag-e2e-smoke-out'], dir);
      const r = JSON.parse(git(['show', 'FETCH_HEAD:smoke.json'], dir));
      if (r.nonce !== nonce) continue;
      console.log(`live smoke v${r.version}: ${r.ok ? 'PASS' : 'FAIL'}, ${r.clicks || 0} clicks on ${r.tabs || 0} tabs, ${r.failures.length} failures, ${r.warnings} warnings`);
      for (const f of r.failures.slice(0, 40)) console.log(' - ' + f.summary);
      fs.rmSync(dir, { recursive: true, force: true });
      process.exit(r.ok ? 0 : 1);
    } catch { /* not there yet */ }
  }
  console.log('no smoke result after 45 minutes: check the live-smoke workflow on the diag-e2e-smoke branch');
  process.exit(2);
}

main().catch(e => { console.error(e.message); process.exit(2); });
