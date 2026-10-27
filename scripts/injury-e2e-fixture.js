// Adds the INJURY NEWS view's answer to the browser-test recording
// (e2e/fixtures/snapshot.json.gz): one teammate prop rebuilt from the
// 2026-10-24 backtest (seeds/injury-stale-backtest.json, checks/injury-stale-2026-10-25),
// in the server's response shape, labelled as an e2e fixture. Its start is
// moved after the recording's clock so the view shows it as open.
//   node scripts/injury-e2e-fixture.js
const fs = require('fs'), zlib = require('zlib');
const I = require('../injurynews');
const FILE = 'e2e/fixtures/snapshot.json.gz';
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)));
const now = Date.parse(snap.recordedAt);
const bt = JSON.parse(fs.readFileSync('seeds/injury-stale-backtest.json', 'utf8'));
const newsAt = now - 40 * 60e3, start = now + 50 * 60e3;
// Matas Buzelis points after Patrick Williams was ruled out (backtest leg, 2026-10-24)
const app = { line: 14.5, over: null, under: null, overOpen: true, underOpen: true };
const books = { prizepicks: { line: 14.5, overOpen: true, underOpen: true }, underdog: { line: 14.5, over: 1, under: 1, overOpen: true, underOpen: true }, sleeper: { line: 14.5, over: 1.78, under: 1.78, overOpen: true, underOpen: true }, pick6: { line: 14.5, over: 1, under: 1, overOpen: true, underOpen: true } };
const legs = {};
for (const a of I.APPS) {
  const c = books[a];
  const l = I.checkLeg({ app: a, mkey: 'points', appPre: { ...app, over: c.over ?? null, under: c.under ?? null }, appNow: { ...app, over: c.over ?? null, under: c.under ?? null }, pinPre: { line: 14.5, pOver: 0.479 }, pinNow: { line: 14.5, pOver: 0.533 } });
  if (l) legs[a] = l;
}
const row = { key: 'NBA|matasbuzelis|points|e2e', sport: 'NBA', player: 'Matas Buzelis', team: 'CHI', market: 'Points', mkey: 'points', startTime: new Date(start).toISOString(), matchTitle: 'WAS @ CHI',
  books, out: 'Patrick Williams', outTeam: 'CHI', newsAt: new Date(newsAt).toISOString(), mins: 40, mateMpg: 30.4, legs };
const kinds = Object.fromEntries([...I.KINDS].map(k => [k, null]));
snap.responses['/api/props/injury'] = { status: 200, type: 'application/json', body: JSON.stringify({ on: true, pro: true, label: 'research, not a bet', note: 'e2e fixture: one leg rebuilt from the 2026-10-24 backtest', bar: I.BAR,
  rule: { minMpg: I.MIN_MPG, minPts: I.MIN_PTS, preMin: I.PRE_MS / 60e3, windowMin: I.WINDOW_MS / 60e3 },
  watch: { reads: 3, listed: 82, out: 55, lastRead: new Date(now - 60e3).toISOString(), events: 1, readAt: new Date(now - 60e3).toISOString(), errors: [] },
  events: [{ name: 'Patrick Williams', team: 'CHI', status: 'Out', from: 'Day-To-Day', newsAt: new Date(newsAt).toISOString(), mins: 40, mpg: 31.6, rotation: true, open: true, comment: '' }],
  rows: [row], total: 1, record: kinds, clears: Object.fromEntries([...I.KINDS].map(k => [k, { logged: 0, graded: 0, wins: 0, losses: 0, units: 0 }])), backtest: bt, logged: [] }) };
fs.writeFileSync(FILE, zlib.gzipSync(JSON.stringify(snap)));
console.log('legs', Object.keys(legs));
