// ESPN tennis scoreboard pulls (diag-tennis*/data/espn.json.gz) → seeds/tennis-matches.json.gz
//   node scripts/tennis-seed.js out.json.gz espn1.json.gz espn2.json.gz ...
// Singles only; walkovers, cancelled, unplayed and TBD rows dropped; one row a match.
const fs = require('fs'), zlib = require('zlib');
const { compactMatches, matchFromEspn } = require('../tennisdata');

const [out, ...files] = process.argv.slice(2);
// ESPN lists combined events (Slams, Indian Wells, Brisbane...) in both its
// ATP and WTA feeds under one competition id: one row a competition, and each
// player's tour is the feed they appear in alone more often.
const byId = new Map(), feeds = new Map();
for (const f of files) {
  for (const r of JSON.parse(zlib.gunzipSync(fs.readFileSync(f)))) {
    const m = matchFromEspn(r);
    if (!m) continue;
    const prev = byId.get(m.id);
    const set = feeds.get(m.id) || new Set(); set.add(r.tour); feeds.set(m.id, set);
    byId.set(m.id, prev ? { ...prev, ev: prev.ev.length >= m.ev.length ? prev.ev : m.ev } : m);
  }
}
const gender = new Map();
for (const [id, set] of feeds) {
  if (set.size !== 1) continue;
  const tour = [...set][0], m = byId.get(id);
  for (const p of [m.a, m.b]) { const g = gender.get(p) || { atp: 0, wta: 0 }; g[tour]++; gender.set(p, g); }
}
const tourOf = p => { const g = gender.get(p); return g && g.wta > g.atp ? 'wta' : 'atp'; };
const list = [...byId.values()].map(m => {
  const tour = tourOf(m.a) === 'wta' || tourOf(m.b) === 'wta' ? 'wta' : 'atp';
  return { ...m, tour, bo: tour === 'wta' ? 3 : m.bo };
}).sort((a, b) => a.t - b.t);
const seed = compactMatches(list);
fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(seed)));
console.log('matches', list.length, 'players', seed.players.length, 'from', new Date(list[0]?.t).toISOString(), 'to', new Date(list[list.length - 1]?.t).toISOString(), 'bytes', fs.statSync(out).size);
