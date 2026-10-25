// Boots server.js for the browser tests with every outbound call turned off
// (axios and fetch to anything but this server throw), its crons stopped and
// its record files in a temp folder. GETs under /api are answered from a
// recorded snapshot of the live API (e2e/fixtures/snapshot.json.gz, made by
// e2e/record.js), so the pages render real recorded data and never reach a
// venue. Anything the snapshot lacks falls through to the offline server and
// is listed in misses(), so the suite can say what the fixture is missing.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const FIXTURE = path.join(__dirname, 'fixtures', 'snapshot.json.gz');

function loadSnapshot(file = FIXTURE) {
  if (!fs.existsSync(file)) return { recordedAt: null, responses: {} };
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

// "/api/x?b=2&a=1" and "/api/x?a=1&b=2" are the same request
function keyOf(url) {
  const u = new URL(url, 'http://x');
  const q = [...u.searchParams.entries()].filter(([k]) => k !== 't' && k !== '_').sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  return u.pathname + (q.length ? '?' + new URLSearchParams(q).toString() : '');
}

const PERSONAL = /^\/api\/(auth|sync)(\/|$)/;

function offline() {
  const axios = require('axios');
  const no = async url => { throw Object.assign(new Error(`e2e offline: ${url}`), { code: 'ENOTFOUND', response: { status: 503 } }); };
  axios.get = no; axios.post = no; axios.request = no; axios.head = no;
  if (typeof axios.create === 'function') axios.create = () => axios;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const s = String(url && url.url ? url.url : url);
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(s)) return realFetch(url, opts);
    throw Object.assign(new Error(`e2e offline: ${s}`), { code: 'ENOTFOUND' });
  };
}

async function start({ port = 0, snapshot = loadSnapshot(), log = () => {} } = {}) {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-e2e-'));
  for (const k of Object.keys(process.env)) if (/^(DATABASE_URL|ODDS_API_KEY|OWLS_API_KEY|STRIPE_|TAIL_WEBHOOK|ALERT_WEBHOOK_URL|SHARP_WEBHOOK|VAPID_)/.test(k)) delete process.env[k];
  for (const k of Object.keys(process.env)) if (/^(RAILWAY_|LR_SYNC$|PAYWALL$)/.test(k)) delete process.env[k];
  // sign-in and account sync on, with the file store in the temp folder (no Postgres here)
  Object.assign(process.env, { LR_DATA_DIR: DIR, UPSTREAM_GAP_MS: '0', ALERT_STARTUP: 'off', NODE_ENV: 'test', AUTH_SECRET: process.env.E2E_AUTH_SECRET || 'e2e-auth-secret' });
  // E2E_SYNC=off: the page as the live site shows it before sync is switched on
  if (process.env.E2E_SYNC === 'off') process.env.LR_SYNC = 'off';
  for (const f of ['TRACKER_FILE', 'USERS_FILE', 'EV_TRACK_FILE', 'TAIL_TRACK_FILE', 'TAIL_TRADERS_FILE', 'FRESH_TRACK_FILE', 'ESPORTS_EDGE_TRACK_FILE']) process.env[f] = path.join(DIR, f.toLowerCase() + '.json');
  offline();
  const express = require('express');
  const S = require('../server');
  const cron = require('node-cron');
  for (const t of cron.getTasks().values()) t.stop();

  const responses = snapshot.responses || {};
  // the same path with other query strings, for a request the snapshot has no exact match for
  const byPath = {};
  for (const k of Object.keys(responses)) (byPath[k.split('?')[0]] ||= []).push(k);
  // no exact match: the recorded call to the same path sharing the most query parameters
  const closest = (k, list) => {
    if (!list) return null;
    const want = new URLSearchParams(k.split('?')[1] || '');
    let best = null, score = -1;
    for (const c of list) {
      const have = new URLSearchParams(c.split('?')[1] || '');
      let s = 0;
      for (const [a, b] of want) if (have.get(a) === b) s += 2; else if (have.has(a)) s += 1;
      for (const [a] of have) if (!want.has(a)) s -= 1;
      if (s > score) { score = s; best = c; }
    }
    return responses[best];
  };
  const misses = new Map();
  const served = new Set();
  const outer = express();
  outer.use((req, res, next) => {
    if (req.method !== 'GET' || !req.path.startsWith('/api/')) return next();
    // a viewer's own account and synced data: always this server, never the recording
    if (PERSONAL.test(req.path)) return next();
    if (/\/stream$/.test(req.path)) {
      // the live feeds: an open stream with nothing on it
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': e2e\n\n');
      return;
    }
    const k = keyOf(req.originalUrl);
    // a per-item path (a game's line history, a player page) the recording has no copy of:
    // a recorded sibling under the same parent path, so the view still renders real data
    const sibling = () => { const parent = req.path.replace(/\/[^/]+$/, '/'); const p = Object.keys(byPath).find(x => x.startsWith(parent) && !x.slice(parent.length).includes('/')); return p ? closest(k, byPath[p]) : null; };
    const hit = responses[k] || closest(k, byPath[req.path]) || (/\/(history|player|team|trader|matchups)\//.test(req.path) ? sibling() : null);
    if (!hit) { misses.set(k, (misses.get(k) || 0) + 1); log(`fixture miss ${k}`); return next(); }
    served.add(k);
    res.status(hit.status || 200).type(hit.type || 'application/json').send(hit.body);
  });
  outer.use(S.app);
  const srv = await new Promise((resolve, reject) => { const s = outer.listen(port, '127.0.0.1', () => resolve(s)); s.on('error', reject); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  return {
    base, recordedAt: snapshot.recordedAt, snapshot,
    misses: () => [...misses.entries()].map(([k, n]) => ({ key: k, n })),
    served: () => [...served],
    close: async () => {
      for (const t of cron.getTasks().values()) t.stop();
      srv.closeAllConnections?.();
      await new Promise(r => srv.close(() => r()));
      fs.rmSync(DIR, { recursive: true, force: true });
    },
  };
}

module.exports = { start, loadSnapshot, keyOf, FIXTURE, PERSONAL };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 3456, log: m => console.log(m) }).then(h => console.log(`e2e server on ${h.base}/app (snapshot ${h.recordedAt || 'none'})`));
}
