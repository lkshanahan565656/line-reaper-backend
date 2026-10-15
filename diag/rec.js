// Preload for the server: keeps the last raw response of every URL the server
// fetches through axios (as a string), and writes them out on SIGUSR2 as one
// gzipped JSON-lines file per host: {key, at, status, body}.
const fs = require('fs'); const zlib = require('zlib');
const axios = require('axios');
const store = new Map();
const keep = (cfg, status, data) => {
  try {
    const base = cfg.baseURL && !/^https?:/.test(cfg.url || '') ? cfg.baseURL.replace(/\/$/, '') + '/' + String(cfg.url || '').replace(/^\//, '') : cfg.url;
    let url = base;
    if (cfg.params) { const u = new URL(base); for (const [k, v] of Object.entries(cfg.params)) if (v != null) u.searchParams.set(k, Array.isArray(v) ? v.join(',') : v); url = u.toString(); }
    const key = (cfg.method || 'get').toUpperCase() + ' ' + url + (cfg.data && typeof cfg.data === 'string' ? ' BODY ' + cfg.data.slice(0, 300) : '');
    let body = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : JSON.stringify(data);
    if (body && body.length > 60e6) body = body.slice(0, 1000) + '...TRUNCATED';
    store.set(key, { at: new Date().toISOString(), status, body });
  } catch (e) { /* never break the server */ }
};
const hook = inst => inst.interceptors.response.use(r => { keep(r.config, r.status, r.data); return r; }, e => { if (e.config) keep(e.config, e.response?.status || 0, e.response?.data ?? { error: e.message }); return Promise.reject(e); });
hook(axios);
const create = axios.create.bind(axios);
axios.create = (...a) => { const i = create(...a); hook(i); return i; };
process.on('SIGUSR2', () => {
  const dir = process.env.REC_DIR || 'out/raw'; fs.mkdirSync(dir, { recursive: true });
  const byHost = {};
  for (const [k, v] of store) { let h = 'other'; try { h = new URL(k.split(' ')[1]).host; } catch {} (byHost[h] ||= []).push([k, v]); }
  for (const [h, list] of Object.entries(byHost)) {
    try {
      const z = zlib.createGzip(); const ws = fs.createWriteStream(`${dir}/${h}.jsonl.gz`); z.pipe(ws);
      for (const [k, v] of list) z.write(JSON.stringify({ key: k, at: v.at, status: v.status }).slice(0, -1) + ',"body":' + JSON.stringify(v.body) + '}\n');
      z.end();
    } catch (e) { fs.appendFileSync(`${dir}/_errors`, `${h}: ${e.message}\n`); }
  }
  setTimeout(() => fs.writeFileSync(`${dir}/_done`, new Date().toISOString() + ' ' + [...store.keys()].length + ' urls'), 8000);
});
