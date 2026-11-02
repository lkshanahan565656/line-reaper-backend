// /esports/research and its JSON: the board's esports players, our records'
// past lines, and the map log from Leaguepedia (stubbed here; every other
// outbound call fails). Test fixtures, not real results.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-esr-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PUBLIC_URL']) delete process.env[k];
const T = Date.now();
const iso = h => new Date(T + h * 3600e3).toISOString();
// a graded record row a day ago and one five days ago
fs.writeFileSync(path.join(DIR, 'picks.json'), JSON.stringify([
  { id: 'LOL|faker|k|1-2|d:a', sport: 'LOL', player: 'Faker', team: 'T1', matchTitle: 'T1 vs Gen.G', market: 'Kills on Maps 1+2', startTime: iso(-24), status: 'graded', result: 9, signalBook: 'UD', signalLine: 7.5, closeLine: 8.5, signalLines: { UD: 7.5 }, closeLines: { UD: 8.5 } },
  { id: 'LOL|faker|k|1-2|d:b', sport: 'LOL', player: 'Faker', team: 'T1', matchTitle: 'BLG vs T1', market: 'Kills on Maps 1+2', startTime: iso(-120), status: 'graded', result: 5, signalBook: 'UD', signalLine: 7.5, closeLine: 7.5, signalLines: { UD: 7.5, PP: 7.5 }, closeLines: { UD: 7.5, PP: 7.5 } },
  { id: 'CS|zywoo|k|1-2|d:c', sport: 'CS', player: 'ZywOo', team: 'Vitality', matchTitle: 'Vitality vs MOUZ', market: 'Kills on Maps 1+2', startTime: iso(-30), status: 'graded', result: 41, signalBook: 'UD', signalLine: 38.5, closeLine: 38.5, signalLines: { UD: 38.5 }, closeLines: { UD: 38.5 } },
]));
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
let lpCalls = 0;
axios.get = async (url, opts = {}) => {
  if (String(url).startsWith('https://lol.fandom.com/api.php') && /Faker/.test(opts.params?.where || '')) {
    lpCalls++;
    const g = (mid, n, h, k, a, win, opp) => ({ title: { Link: 'Faker', Team: 'T1', Kills: String(k), Deaths: '1', Assists: String(a), Champion: 'Azir', Win: win ? 'Yes' : 'No', Team1: 'T1', Team2: opp, MatchId: mid, GameN: String(n), DateTime: new Date(T + h * 3600e3).toISOString().slice(0, 19).replace('T', ' '), Tournament: 'Worlds 2026' } });
    return { data: { cargoquery: [g('A', 1, -24, 4, 6, true, 'Gen.G'), g('A', 2, -23, 5, 7, true, 'Gen.G'), g('B', 1, -120, 2, 3, false, 'BLG'), g('B', 2, -119, 3, 2, false, 'BLG')] } };
  }
  throw Object.assign(new Error('offline'), { response: { status: 503 } });
};
axios.post = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => {
  srv.cache.underdog.data = [
    { book: 'underdog', sport: 'LOL', player: 'Faker', team: 'T1', market: 'Kills on Maps 1+2', line: 7.5, overMultiplier: 1, underMultiplier: 1, startTime: iso(20), matchTitle: 'T1 vs Gen.G', gameId: 'g1' },
    { book: 'underdog', sport: 'CS2', player: 'ZywOo', team: 'Vitality', market: 'Kills on Maps 1+2', line: 39.5, overMultiplier: 1, underMultiplier: 1, startTime: iso(22), matchTitle: 'Vitality vs G2', gameId: 'g2' },
  ];
  server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

// the props board builds in slices: ask until it lists both players
async function listWhenBuilt() {
  for (let i = 0; i < 40; i++) {
    const d = await (await fetch(`${base}/api/esports/research`)).json();
    if (d.players.length >= 2) return d;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('board never built');
}

test('the list: each esports player on the apps, with records counted and the sources named', async () => {
  const d = await listWhenBuilt();
  const f = d.players.find(p => p.player === 'Faker');
  assert.equal(f.game, 'LOL');
  assert.equal(f.records, 2);
  assert.equal(f.url, '/esports/research/LOL/Faker');
  assert.deepEqual(f.markets[0].lines, [{ app: 'UD', line: 7.5, overOpen: true, underOpen: true }]);
  assert.equal(d.sources.CS, 'our records only');
  assert.match(d.note, /Research, not a bet/);
  const lol = await (await fetch(`${base}/api/esports/research?game=lol`)).json();
  assert.deepEqual(lol.players.map(p => p.player), ['Faker']);
  const page = await fetch(`${base}/esports/research`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /RESEARCH · NOT A BET/);
  assert.match(html, /href="\/esports\/research\/CS\/ZywOo"/);
});

test('a LoL player: hit rate from Leaguepedia\'s maps, line history from our records', async () => {
  await listWhenBuilt();
  const d = await (await fetch(`${base}/api/esports/research/LOL/Faker`)).json();
  assert.equal(d.source.status, 'ok');
  assert.equal(d.hitFrom, 'maps');
  assert.deepEqual(d.series.map(s => s.value), [9, 5]);
  assert.deepEqual(d.hit[0].windows.find(w => w.window == null).over, 1);
  assert.equal(d.records.length, 2);
  assert.deepEqual(d.records[0].last, { UD: 8.5 });
  const html = await (await fetch(`${base}/esports/research/LOL/Faker`)).text();
  assert.match(html, /Recent maps/);
  assert.match(html, /App line history/);
  await fetch(`${base}/esports/research/LOL/Faker`);
  assert.equal(lpCalls, 1, 'Leaguepedia is read once and cached');
});

test('a CS2 player: our records only, said in words', async () => {
  await listWhenBuilt();
  const d = await (await fetch(`${base}/api/esports/research/CS/ZywOo`)).json();
  assert.equal(d.source.maps, null);
  assert.equal(d.hitFrom, 'records');
  assert.deepEqual(d.hit[0].windows.find(w => w.window == null), { window: null, n: 1, full: true, over: 1, under: 0, push: 0, avg: 41, median: 41, });
  const html = await (await fetch(`${base}/esports/research/CS/ZywOo`)).text();
  assert.match(html, /CS2 has no free per-map stats source/);
});

test('an unknown player or game is a 404, and nothing is fetched for it', async () => {
  const before = lpCalls;
  assert.equal((await fetch(`${base}/esports/research/LOL/Nobody`)).status, 404);
  assert.equal((await fetch(`${base}/api/esports/research/XYZ/Faker`)).status, 404);
  assert.equal(lpCalls, before);
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /Allow: \/esports\/research/);
});
