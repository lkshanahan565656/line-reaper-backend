// Preload for the server: keeps the last two raw responses of every URL the
// server fetches through axios, and writes them out on SIGUSR2 (one file per host).
const fs = require('fs'); const zlib = require('zlib');
const axios = require('axios');
const store = new Map();
const keep = (cfg, status, data) => {
  try {
    const base = cfg.baseURL && !/^https?:/.test(cfg.url || '') ? cfg.baseURL.replace(/\/$/, '') + '/' + String(cfg.url || '').replace(/^\//, '') : cfg.url;
    let url = base;
    if (cfg.params) { const u = new URL(base); for (const [k, v] of Object.entries(cfg.params)) if (v != null) u.searchParams.set(k, Array.isArray(v) ? v.join(',') : v); url = u.toString(); }
    const key = (cfg.method || 'get').toUpperCase() + ' ' + url + (cfg.data && typeof cfg.data === 'string' ? ' BODY ' + cfg.data.slice(0, 300) : '');
    const list = store.get(key) || [];
    list.unshift({ at: new Date().toISOString(), status, data });
    store.set(key, list.slice(0, 2));
  } catch (e) { /* never break the server */ }
};
const hook = inst => inst.interceptors.response.use(r => { keep(r.config, r.status, r.data); return r; }, e => { if (e.config) keep(e.config, e.response?.status || 0, e.response?.data ?? { error: e.message }); return Promise.reject(e); });
hook(axios);
const create = axios.create.bind(axios);
axios.create = (...a) => { const i = create(...a); hook(i); return i; };
process.on('SIGUSR2', () => {
  const dir = process.env.REC_DIR || 'out/raw'; fs.mkdirSync(dir, { recursive: true });
  const byHost = {};
  for (const [k, v] of store) { let h = 'other'; try { h = new URL(k.split(' ')[1]).host; } catch {} (byHost[h] ||= {})[k] = v; }
  for (const [h, obj] of Object.entries(byHost)) fs.writeFileSync(`${dir}/${h}.json.gz`, zlib.gzipSync(JSON.stringify(obj)));
  fs.writeFileSync(`${dir}/_done`, new Date().toISOString());
});
