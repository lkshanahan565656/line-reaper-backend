// Live check of the Valorant grader and the Pinnacle totals scoreboard.
const fs = require('fs'), zlib = require('zlib');
const axios = require('axios');
const g = require('../graders');
const T = require('../pintotals');
const esbooks = require('../esbooks');
fs.mkdirSync('out', { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// independent parse (the rounds thread's vlrmaps.js parser): page order, tags, kills
function indep(html) {
  const games = [];
  for (const c of html.split(/<div class="vm-stats-game\s/).slice(1)) {
    const gid = /data-game-id="(\d+)"/.exec(c.slice(0, 300))?.[1];
    if (!gid) continue;
    const cut = c.search(/<table|class="ovw-/);
    const head = cut > 0 ? c.slice(0, cut) : c.slice(0, 20000);
    const scores = [...head.matchAll(/<div class="score[^"]*"[^>]*>\s*(\d+)\s*</g)].map(m => +m[1]);
    const p = [];
    for (const row of c.split(/class="ovw-row"|<tr[\s>]/).slice(1)) {
      if (!/mod-player/.test(row)) continue;
      const name = txt((/<div class="ovw-player-name[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(row) || /<div class="text-of"[^>]*>([\s\S]*?)<\/div>/.exec(row))?.[1]);
      const tag = txt((/<div class="ovw-player-tag[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(row) || /<div class="ge-text-light"[^>]*>([\s\S]*?)<\/div>/.exec(row))?.[1]);
      const k = (/data-col="kills"><span class="side mod-both[^"]*">\s*(\d+)/.exec(row) || /mod-vlr-kills[\s\S]*?mod-both[^>]*>\s*(\d+)/.exec(row))?.[1];
      if (name && k != null) p.push({ name, tag, k: +k });
    }
    // the map's number from the nav bar
    const n = new RegExp(`data-game-id="${gid}"[^>]*>[\\s\\S]*?<span[^>]*>\\s*(\\d+)\\s*</span>`).exec(html.slice(html.indexOf('vm-stats-gamesnav')))?.[1];
    if (scores.length >= 2 && p.length >= 10) games.push({ gid, n: n ? +n : null, s: scores.slice(0, 2), p });
  }
  return games;
}
async function valCheck() {
  const res = await axios.get('https://www.vlr.gg/matches/results', { headers: { 'User-Agent': UA }, responseType: 'text', timeout: 20000 });
  const list = g.vlrResultsList(res.data).slice(0, Number(process.env.VAL_MATCHES || 14));
  const grade = g.createValGrader(axios, { pause: 700 });
  const out = { matches: 0, picks: 0, graded: 0, agree: 0, disagree: [], ungradable: [], nothing: [], negatives: {}, perMatch: [] };
  for (const r of list) {
    const html = (await axios.get(`https://www.vlr.gg/${r.id}`, { headers: { 'User-Agent': UA }, responseType: 'text', timeout: 20000 })).data;
    await sleep(700);
    const utc = /data-utc-ts="([^"]+)"/.exec(html)?.[1];
    const start = Date.parse(utc.replace(' ', 'T') + 'Z');
    const games = indep(html).filter(x => x.n === 1 || x.n === 2);
    if (games.length < 2) { out.perMatch.push({ id: r.id, teams: r.teams, skipped: 'fewer than two maps with stats' }); continue; }
    out.matches++;
    const tags = [...new Set(games[0].p.map(p => p.tag))];
    let mg = 0;
    for (const p of games[0].p) {
      const want = games.reduce((s, x) => s + (x.p.find(q => q.name === p.name && q.tag === p.tag)?.k ?? NaN), 0);
      // the app lists the team by its tag or its full name, its start up to 40 min off
      const team = Math.random() < 0.5 ? p.tag : r.teams[tags.indexOf(p.tag)] || p.tag;
      const pick = { sport: 'VAL', player: p.name, team, matchTitle: r.teams.join(' vs '), stat: 'kills', market: 'MAPS 1-2 Kills', startTime: new Date(start + (Math.random() * 80 - 40) * 60e3).toISOString() };
      out.picks++;
      let got;
      try { got = await grade(pick); } catch (e) { got = { error: e.message }; }
      if (got?.maps && got.maps[1] != null && got.maps[2] != null) {
        out.graded++; mg++;
        const v = got.maps[1] + got.maps[2];
        if (v === want) out.agree++; else out.disagree.push({ id: r.id, player: p.name, team, got: got.maps, want });
      } else if (got?.unavailable) out.ungradable.push({ id: r.id, player: p.name, team, why: got.unavailable });
      else out.nothing.push({ id: r.id, player: p.name, team, got });
    }
    out.perMatch.push({ id: r.id, teams: r.teams, start: new Date(start).toISOString(), graded: mg });
    // negatives: a made-up player on the team, a real player put on the other team, the right player a day off
    const p0 = games[0].p[0], other = tags.find(t => t !== p0.tag);
    const neg = {
      ghost: await grade({ player: 'nobodyxyz', team: p0.tag, stat: 'kills', startTime: new Date(start).toISOString() }),
      wrongTeam: await grade({ player: p0.name, team: other, stat: 'kills', startTime: new Date(start).toISOString() }),
      dayOff: await grade({ player: p0.name, team: p0.tag, stat: 'kills', startTime: new Date(start + 24 * 3600e3).toISOString() }),
      headshots: await grade({ player: p0.name, team: p0.tag, stat: 'headshots', startTime: new Date(start).toISOString() }),
    };
    for (const [k, v] of Object.entries(neg)) (out.negatives[k] ||= []).push(v?.maps ? 'GRADED (bad)' : v?.unavailable ? 'ungradable' : 'nothing');
    log('val', r.id, r.teams.join(' vs '), mg);
  }
  fs.writeFileSync('out/val.json', JSON.stringify(out, null, 1));
  log('val done', out.matches, out.picks, out.graded, out.agree, out.disagree.length, out.ungradable.length, out.nothing.length);
}
// the espin log's compact snapshots → parsePinnacle's input
function expand(s) {
  const matchups = s.mu.map(m => ({ id: m.id, parentId: m.p, type: 'matchup', units: m.u, league: { name: m.lg }, startTime: m.st, isLive: m.live, participants: (m.ps || []).map(([alignment, name]) => ({ alignment, name })) }));
  const markets = s.mk.map(k => ({ matchupId: k.m, key: k.k, period: k.per, type: k.t, status: k.s, side: /;(home|away)$/.exec(k.k || '')?.[1] || null, limits: [{ amount: k.lim }],
    prices: (k.pr || []).map(([designation, points, price]) => ({ designation, points, price })) }));
  return { matchups, markets };
}
async function totalsCheck() {
  const rows = new Map();
  let snaps = 0;
  for (const line of zlib.gunzipSync(fs.readFileSync('data/espin.jsonl.gz')).toString().split('\n')) {
    if (!line.trim()) continue;
    const s = JSON.parse(line);
    if (!s.mu || !s.mk) continue;
    const { matchups, markets } = expand(s);
    T.observe(rows, esbooks.parsePinnacle(matchups, markets), Date.parse(s.at));
    snaps++;
  }
  const ps = JSON.parse(zlib.gunzipSync(fs.readFileSync('data/pinsnap.json.gz')));
  T.observe(rows, esbooks.parsePinnacle(ps.matchups, ps.markets), Date.parse(ps.at));
  try {
    const H = { 'User-Agent': UA, Accept: 'application/json' }, P = 'https://guest.api.arcadia.pinnacle.com/0.1/sports/12';
    const [mu, mk] = await Promise.all([axios.get(`${P}/matchups`, { headers: H }), axios.get(`${P}/markets/straight`, { headers: H })]);
    T.observe(rows, esbooks.parsePinnacle(mu.data, mk.data), Date.now());
    snaps++;
  } catch (e) { log('pin now failed', e.message); }
  log('snapshots', snaps + 1, 'rows', rows.size);
  const find = T.createSources(axios, { pause: 600 });
  const lastTry = new Map();
  let total = { looked: 0, graded: 0, notPlayed: 0, ungradable: 0, errors: 0 };
  for (let i = 0; i < 6; i++) {
    const r = await T.gradeDue([...rows.values()], find, { lastTry, retryMs: 0, limit: 200, now: Date.now() });
    for (const k of Object.keys(total)) total[k] += r[k];
    log('sweep', i, JSON.stringify({ ...r, changed: r.changed.length }));
    if (!r.looked) break;
    lastTry.clear();
    if (!r.graded && !r.notPlayed) break;
  }
  const all = [...rows.values()];
  const byStatus = {};
  for (const r of all) byStatus[`${r.game} ${r.status}`] = (byStatus[`${r.game} ${r.status}`] || 0) + 1;
  // matches that started and are not graded: why
  const missed = {};
  for (const r of all) if (r.status === 'open' && Date.parse(r.start) < Date.now() - 3 * 3600e3) missed[`${r.game}|${r.pinId}`] = `${r.teams.join(' vs ')} ${r.start} ${r.league}`;
  fs.writeFileSync('out/totals.json', JSON.stringify({ total, byStatus, close: T.scoreboard(all), signal: T.scoreboard(all, { snap: 'signal' }), fit: T.fitted(all), missed, rows: all.filter(r => r.status !== 'open') }, null, 1));
  log('totals done', JSON.stringify(byStatus));
}
(async () => {
  try { await totalsCheck(); } catch (e) { log('totals failed', e.stack); }
  try { await valCheck(); } catch (e) { log('val failed', e.stack); }
})();
