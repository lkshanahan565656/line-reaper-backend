// Lead-lag grader: every game in diag-leadlag-out-* → ESPN final score → results.json
// { key: [winA, winB] } (1 win, 0 loss, 0.5 push; soccer regulation result). Run in Actions.
const fs = require('fs'), zlib = require('zlib');
const { execSync } = require('child_process');
const axios = require('axios');
const SG = require('../sportgrade');
const SPORT = { nfl: 'NFL', ncaaf: 'CFB', nba: 'NBA', nhl: 'NHL', mlb: 'MLB', ncaab: 'CBB', epl: 'EPL', laliga: 'LALIGA', bundesliga: 'BUNDESLIGA', seriea: 'SERIEA',
  ligue1: 'LIGUE1', mls: 'MLS', ligamx: 'LIGAMX', eredivisie: 'EREDIVISIE', brasileirao: 'BRASILEIRAO', ucl: 'UCL', uel: 'UEL' };
const sh = c => execSync(c, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 }).toString();
(async () => {
  sh('git fetch -q origin "+refs/heads/diag-leadlag-out-*:refs/remotes/origin/diag-leadlag-out-*"');
  const refs = sh(`git for-each-ref --format='%(refname:short)' "refs/remotes/origin/diag-leadlag-out-*"`).split('\n').filter(Boolean);
  const games = new Map();   // sport|pin-id → { home, away, st, keys:Set }
  for (const r of refs) {
    let txt; try { txt = zlib.gunzipSync(execSync(`git show ${r}:changes.jsonl.gz`, { maxBuffer: 1 << 30 })).toString(); } catch { continue; }
    for (const l of txt.split('\n')) {
      if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
      const [sp, id] = o.k.split('|'); const g = `${sp}|${id}`;
      if (!games.has(g)) games.set(g, { sp, keys: new Set() });
      const G = games.get(g); G.keys.add(o.k);
      if (o.m && !G.home) Object.assign(G, { home: o.m.home, away: o.m.away, st: o.m.st });
    }
  }
  console.log('games', games.size);
  const boards = new Map();
  const events = async (sp, d) => {
    const k = `${sp}|${d}`;
    if (!boards.has(k)) {
      let evs = [];
      try { evs = (await axios.get(`https://site.api.espn.com/apis/site/v2/sports/${SG.LEAGUES[sp]}/scoreboard`, { params: { dates: d, ...(sp === 'CFB' ? { groups: 80, limit: 400 } : { limit: 400 }) }, timeout: 20000 })).data?.events || []; }
      catch (e) { console.log('board', k, e.message); }
      boards.set(k, evs);
    }
    return boards.get(k);
  };
  const out = {}, why = {};
  for (const [g, G] of games) {
    const sp = SPORT[G.sp];
    if (!sp || !G.home || !G.st) { why.nosport = (why.nosport || 0) + 1; continue; }
    const t = Date.parse(G.st);
    let score = null;
    for (const dt of [t, t - 86400e3, t + 86400e3]) {
      for (const ev of await events(sp, SG.ymd(dt))) {
        if (!ev.status?.type?.completed || Math.abs(Date.parse(ev.date) - t) > 4 * 3600e3) continue;
        const s = SG.scoreOf(ev, { home: G.home, away: G.away });
        if (s) { score = s; break; }
      }
      if (score) break;
    }
    if (!score) { why.nofinal = (why.nofinal || 0) + 1; continue; }
    why.graded = (why.graded || 0) + 1;
    for (const k of G.keys) {
      const [, , mk, pt] = k.split('|');
      const diff = score.home - score.away, tot = score.home + score.away;
      let a, b;
      if (mk === 'h2h') { a = diff > 0 ? 1 : 0; b = diff < 0 ? 1 : 0; if (diff === 0 && !/^(epl|laliga|bundesliga|seriea|ligue1|mls|ligamx|eredivisie|brasileirao|ucl|uel)$/.test(G.sp)) a = b = 0.5; }
      else if (mk === 'spreads') { const m = diff + Number(pt); a = m > 0 ? 1 : m < 0 ? 0 : 0.5; b = 1 - a; }
      else if (mk === 'totals') { const m = tot - Number(pt); a = m > 0 ? 1 : m < 0 ? 0 : 0.5; b = 1 - a; }
      else continue;
      out[k] = [a, b];
    }
  }
  console.log(JSON.stringify(why));
  fs.mkdirSync('res', { recursive: true });
  fs.writeFileSync('res/results.json', JSON.stringify(out));
  fs.writeFileSync('res/why.json', JSON.stringify({ ...why, games: games.size, at: new Date().toISOString() }));
})();
