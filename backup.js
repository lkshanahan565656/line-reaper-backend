// ─── RESULTS BACKUP ───────────────────────────────────────────────────────────
// Railway's disk is wiped on every deploy, so without Postgres every track
// record started from zero. This keeps them with no database and no setting:
//
//   export   GET /api/results/backup hands out every registered store as one
//            gzipped JSON, encrypted (AES-256-GCM). The key comes from
//            RESULTS_BACKUP_KEY or, on Railway, from the project, service and
//            environment ids Railway gives every container, so nobody reading
//            the public repo can open it (open tail signals are Pro data).
//   keep     a GitHub Action (.github/workflows/results-backup.yml) fetches it
//            on a schedule and on every push to main (before the new deploy
//            boots) and force-pushes it as the only commit on the
//            results-data branch.
//   restore  each wrapped store's init() reads that file back and adds every
//            record it doesn't have, before the trackers load, so open bets
//            keep being graded across deploys.
//
// A restore only ever adds missing ids. Until the snapshot has been read (or
// is known not to exist) the export answers 503, so a container that couldn't
// read it never overwrites a fuller one. That includes a snapshot sealed with
// a key this container can't make: setting RESULTS_BACKUP_KEY, or a new
// Railway service (new ids), changes the key. The snapshot is read with every
// key the container can make (keysFromEnv: RESULTS_BACKUP_KEY, the Railway
// ids, RESULTS_BACKUP_OLD_KEYS) and the next export is sealed with the first.
// One it can't open keeps exports paused (state 'retrying', the note says
// what to set) instead of starting the record empty and overwriting it.
// The envelope's counts (plain numbers, no data) let the Action refuse a
// snapshot with fewer records than the last one under the same key.

const crypto = require('crypto');
const zlib = require('zlib');

const DEFAULT_REPO = 'lkshanahan565656/line-reaper-backend';
const BRANCH = 'results-data';
const FILE = 'results.json';

const keyOfSecret = secret => crypto.createHash('sha256').update(`line-reaper-results|${secret}`).digest();
// every key this container can make, the one new snapshots are sealed with
// first: RESULTS_BACKUP_KEY, the Railway ids, then RESULTS_BACKUP_OLD_KEYS
// (comma-separated earlier secrets: an old RESULTS_BACKUP_KEY, or old ids
// written project|service|environment)
function keysFromEnv(env = process.env) {
  const secrets = [
    env.RESULTS_BACKUP_KEY,
    env.RAILWAY_PROJECT_ID && env.RAILWAY_SERVICE_ID ? [env.RAILWAY_PROJECT_ID, env.RAILWAY_SERVICE_ID, env.RAILWAY_ENVIRONMENT_ID || ''].join('|') : null,
    ...String(env.RESULTS_BACKUP_OLD_KEYS || '').split(','),
  ].map(x => String(x || '').trim()).filter(Boolean);
  return [...new Set(secrets)].map(keyOfSecret);
}
const keyFromEnv = (env = process.env) => keysFromEnv(env)[0] || null;
const keyIdOf = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);

function sourcesFromEnv(env = process.env) {
  if (env.RESULTS_BACKUP_URL) return [env.RESULTS_BACKUP_URL];
  const repo = env.RESULTS_BACKUP_REPO ||
    (env.RAILWAY_GIT_REPO_OWNER && env.RAILWAY_GIT_REPO_NAME ? `${env.RAILWAY_GIT_REPO_OWNER}/${env.RAILWAY_GIT_REPO_NAME}` : DEFAULT_REPO);
  // the API is fresh; raw.githubusercontent.com is cached a few minutes but
  // has no 60-an-hour limit per IP
  return [`https://api.github.com/repos/${repo}/contents/${FILE}?ref=${BRANCH}`, `https://raw.githubusercontent.com/${repo}/${BRANCH}/${FILE}`];
}

function seal(key, payload) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(zlib.gzipSync(JSON.stringify(payload))), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function open(key, env) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()])).toString('utf8'));
}

// The same envelopes without holding the event loop: the snapshot is about
// 100 MB of JSON, and a gzipSync of it froze every request for seconds each
// time the backup Action pulled it (every 20 minutes). Here the JSON goes out
// a few hundred records at a time into a gzip stream (zlib runs off the main
// thread), and the read side gunzips off the main thread too.
const tick = () => new Promise(r => setImmediate(r));
function* payloadChunks(payload, rows = 300) {
  const stores = payload?.stores || {};
  const names = Object.keys(stores);
  yield '{"stores":{';
  for (let n = 0; n < names.length; n++) {
    const docs = stores[names[n]];
    yield `${n ? ',' : ''}${JSON.stringify(names[n])}:`;
    if (!Array.isArray(docs)) { yield JSON.stringify(docs ?? null); continue; }
    yield '[';
    for (let i = 0; i < docs.length; i += rows) {
      yield (i ? ',' : '') + docs.slice(i, i + rows).map(d => JSON.stringify(d === undefined ? null : d)).join(',');
    }
    yield ']';
  }
  yield '}';
  for (const [k, v] of Object.entries(payload || {})) if (k !== 'stores' && v !== undefined) yield `,${JSON.stringify(k)}:${JSON.stringify(v)}`;
  yield '}';
}
async function sealAsync(key, payload) {
  const gz = zlib.createGzip();
  const out = [];
  gz.on('data', b => out.push(b));
  const ended = new Promise((resolve, reject) => { gz.on('end', resolve); gz.on('error', reject); });
  for (const part of payloadChunks(payload)) {
    if (!gz.write(part)) await new Promise(r => gz.once('drain', r));
    else await tick();
  }
  gz.end();
  await ended;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(Buffer.concat(out)), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
async function openAsync(key, env) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  const gz = Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]);
  const raw = await new Promise((resolve, reject) => zlib.gunzip(gz, (e, b) => (e ? reject(e) : resolve(b))));
  return JSON.parse(raw.toString('utf8'));
}

// fetchJson(url) → parsed body, or null for "no such file"; throws otherwise.
function createBackup({ key, keys, sources = sourcesFromEnv(), fetchJson, log = console, retryMs = 5 * 60e3, bootRetryMs = 2000, now = () => Date.now() } = {}) {
  // bootRetryMs: the first boot retry waits this long, the second twice it
  keys = (keys || (key !== undefined ? [key] : keysFromEnv())).filter(Boolean);
  key = keys[0] || null;   // new snapshots are sealed with this one
  let readWith = null;     // 'current' | 'older' once a snapshot was opened
  let readCounts = null;   // records per store in the snapshot read at boot
  let refused = null;      // why the last export was refused, if it was
  const stores = new Map();   // name → { store, appendOnly }
  const restored = {};        // name → records added from the snapshot
  let state = key ? 'pending' : 'off';   // pending → ready | retrying; off without a key
  let snapshotAt = null, note = null, cached = null, loading = null, building = null, lastExportAt = null;

  async function fetchSnapshot() {
    let lastErr = null;
    for (const url of sources) {
      try { return { body: await fetchJson(url) }; }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no backup source');
  }

  // → { stores } to restore, or null when there is nothing usable
  // A snapshot this container can't open is never a reason to start empty:
  // it throws, so load() keeps exports paused and keeps trying.
  async function readOnce() {
    const { body } = await fetchSnapshot();
    if (!body) { note = 'no backup yet'; return null; }
    const tryKeys = body.keyId ? keys.filter(k => keyIdOf(k) === body.keyId) : keys;
    if (!tryKeys.length) {
      throw Object.assign(new Error(`the backup was sealed with another key (${body.keyId}), not one this server can make; `
        + 'exports are paused so it is not overwritten. Put the old secret in RESULTS_BACKUP_OLD_KEYS (DEPLOY.md), or undo the key change'), { keep: true });
    }
    let lastErr = null;
    for (const k of tryKeys) {
      try {
        const payload = await openAsync(k, body);
        snapshotAt = body.at || null;
        readWith = k === key ? 'current' : 'older';
        readCounts = Object.fromEntries(Object.entries(payload?.stores || {}).map(([n, d]) => [n, Array.isArray(d) ? d.length : 0]));
        note = readWith === 'older' ? 'read with an older key; the next snapshot is sealed with the current one' : null;
        return payload;
      } catch (e) { lastErr = e; }
    }
    throw Object.assign(new Error(`the backup can't be opened (${lastErr?.message || 'no key'}); exports are paused so it is not overwritten`), { keep: true });
  }

  async function addMissing(name, store, docs) {
    if (!Array.isArray(docs) || !docs.length) return 0;
    const have = new Set((await store.all()).map(d => d.id ?? d.wallet));
    const add = docs.filter(d => d && (d.id ?? d.wallet) != null && !have.has(d.id ?? d.wallet));
    if (!add.length) return 0;
    if (store.putMany) await store.putMany(add);
    else for (const d of add) await store.put(d);
    restored[name] = (restored[name] || 0) + add.length;
    return add.length;
  }

  // Boot: a few quick tries so trackers start with their records. After
  // that, keep trying in the background and merge late (the export stays shut
  // until then).
  function load() {
    if (state === 'off') return Promise.resolve(null);
    if (loading) return loading;
    loading = (async () => {
      for (let i = 0; i < 3; i++) {
        try { const p = await readOnce(); state = 'ready'; return p; }
        catch (e) { note = e.keep ? e.message : `could not read the backup: ${e.message}`; }
        if (i < 2) await new Promise(r => setTimeout(r, bootRetryMs * (i + 1)));
      }
      state = 'retrying';
      log.warn?.(`Results backup: ${note}; exports paused, retrying in the background`);
      const timer = setInterval(async () => {
        try {
          const p = await readOnce();
          clearInterval(timer);
          for (const [name, { store }] of stores) await addMissing(name, store, p?.stores?.[name]).catch(() => 0);
          state = 'ready';
          log.log?.('Results backup: read on retry; exports back on');
        } catch (e) { note = e.keep ? e.message : `could not read the backup: ${e.message}`; }
      }, retryMs);
      timer.unref?.();
      return null;
    })();
    return loading;
  }

  // The store, with an init() that restores before anyone reads it.
  function wrap(name, store, { appendOnly = true } = {}) {
    stores.set(name, { store, appendOnly });
    const w = Object.create(store);
    w.init = async () => {
      await store.init();
      const p = await load();
      const n = await addMissing(name, store, p?.stores?.[name]).catch(e => { log.warn?.(`Results backup: restoring ${name}: ${e.message}`); return 0; });
      if (n) log.log?.(`Results backup: restored ${n} ${name} records`);
    };
    return w;
  }

  async function exportSnapshot() {
    if (state === 'off') { const e = new Error('backup off: no RESULTS_BACKUP_KEY and not on Railway'); e.status = 404; throw e; }
    if (state !== 'ready') { const e = new Error(`backup not ready (${state})`); e.status = 503; throw e; }
    if (cached && now() - cached.t < 60e3) return cached.body;
    // one build at a time: a second request waits on the one in flight
    if (building) return building;
    building = build().finally(() => { building = null; });
    return building;
  }
  async function build() {
    const payload = { stores: {} }, counts = {}, other = {};
    for (const [name, { store, appendOnly }] of stores) {
      const docs = await store.all();
      payload.stores[name] = docs;
      (appendOnly ? counts : other)[name] = docs.length;
    }
    // the same guard as the Action's (.github/backup-guard.jq), here too: an
    // export with under half the append-only records the boot read is a
    // server that lost them, never one to keep
    if (readCounts) {
      const both = Object.keys(counts).filter(n => readCounts[n] != null);
      const had = both.reduce((a, n) => a + readCounts[n], 0), has = both.reduce((a, n) => a + counts[n], 0);
      if (had > 100 && has < 0.5 * had) {
        refused = `export refused at ${new Date(now()).toISOString()}: ${has} records against ${had} read at boot`;
        log.warn?.(`Results backup: ${refused}`);
        throw Object.assign(new Error(refused), { status: 503 });
      }
    }
    refused = null;
    const body = { v: 1, at: new Date(now()).toISOString(), keyId: keyIdOf(key), counts, other, ...(await sealAsync(key, payload)) };
    cached = { t: now(), body };
    lastExportAt = body.at;
    return body;
  }

  function status() {
    return { state, snapshotAt, note, readWith, keys: keys.length, refused, restored: { ...restored }, stores: [...stores.keys()], lastExportAt };
  }

  return { wrap, load, exportSnapshot, status };
}

// fetchJson over axios: 404 → null
function axiosFetchJson(axios) {
  return async url => {
    try {
      const res = await axios.get(url, {
        timeout: 15000, maxContentLength: 200e6, responseType: 'json',
        headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'line-reaper' },
      });
      return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    } catch (e) {
      if (e.response?.status === 404) return null;
      throw e;
    }
  };
}

module.exports = { createBackup, keyFromEnv, keysFromEnv, keyIdOf, sourcesFromEnv, axiosFetchJson, seal, open, sealAsync, openAsync, payloadChunks };
