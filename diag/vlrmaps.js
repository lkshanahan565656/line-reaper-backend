// Valorant per-map player kills and rounds from vlr.gg match pages, newest first.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const axios = require(path.resolve('node_modules/axios'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const since = Date.parse(process.env.SINCE || '2025-09-01'), stopAt = Date.now() + Number(process.env.MINUTES || 110) * 60e3;
const res = JSON.parse(zlib.gunzipSync(fs.readFileSync('data/res-val.json.gz')));
const seen = new Set(), list = [];
for (const r of res.sort((a, b) => b.t - a.t)) if (r.t >= since && !seen.has(r.id)) { seen.add(r.id); list.push(r); }
log('matches', list.length);
const txt = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function parse(html) {
  const games = [];
  const parts = html.split(/<div class="vm-stats-game\s/).slice(1);
  for (const c of parts) {
    const gid = /data-game-id="(\d+)"/.exec(c.slice(0, 300))?.[1];
    if (!gid) continue;
    const head = c.split(/<table/)[0];
    const scores = [...head.matchAll(/<div class="score[^"]*"[^>]*>\s*(\d+)\s*</g)].map(m => +m[1]);
    const mapName = txt(/<div class="map"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<span/.exec(head)?.[1] || '');
    const teams = [...head.matchAll(/<div class="team-name"[^>]*>([\s\S]*?)<\/div>/g)].map(m => txt(m[1]));
    const p = [];
    for (const row of c.split(/<tr[\s>]/).slice(1)) {
      if (!/mod-player/.test(row)) continue;
      const name = txt(/<div class="text-of"[^>]*>([\s\S]*?)<\/div>/.exec(row)?.[1]);
      const tag = txt(/<div class="ge-text-light"[^>]*>([\s\S]*?)<\/div>/.exec(row)?.[1]);
      const k = /mod-vlr-kills[\s\S]*?mod-both[^>]*>\s*(\d+)/.exec(row)?.[1];
      const d = /mod-vlr-deaths[\s\S]*?mod-both[^>]*>\s*(\d+)/.exec(row)?.[1];
      const pid = /href="\/player\/(\d+)/.exec(row)?.[1];
      if (name && k != null) p.push([pid, name, tag, +k, d != null ? +d : null]);
    }
    if (scores.length >= 2 && p.length >= 8) games.push({ gid, map: mapName, teams, s: scores.slice(0, 2), rounds: scores[0] + scores[1], p });
  }
  return games;
}
(async () => {
  const out = []; let fails = 0, i = 0;
  for (const m of list) {
    if (Date.now() > stopAt) break;
    i++;
    try {
      const r = await axios.get(`https://www.vlr.gg/${m.id}`, { headers: { 'User-Agent': UA }, timeout: 20000 });
      if (i <= 2) { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(`data/vlr-raw-${i}.html`, r.data); }
      const g = parse(r.data);
      out.push({ id: m.id, t: m.t, a: m.a, b: m.b, games: g });
      if (i <= 3) log('sample', m.id, JSON.stringify(g[0] || null).slice(0, 600));
    } catch (e) { fails++; if (e.response?.status === 429) await sleep(30000); }
    if (i % 200 === 0) { log(i, 'done', out.filter(x => x.games.length).length, 'with maps', fails, 'fails'); fs.writeFileSync('data/vlrmaps.json.gz', zlib.gzipSync(JSON.stringify(out))); }
    await sleep(700);
  }
  fs.writeFileSync('data/vlrmaps.json.gz', zlib.gzipSync(JSON.stringify(out)));
  log('saved', out.length, 'fails', fails);
})();
