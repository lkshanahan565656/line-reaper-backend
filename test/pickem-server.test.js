// The esports board with a Sleeper line next to Underdog's: the Sleeper side
// gets its own EV at its own payout, a Sleeper-only line becomes a pick, and a
// Sleeper line with no known match is left out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-pickem-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL']) delete process.env[k];
Object.assign(process.env, { TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
test.after(() => { for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

test('Sleeper lines are priced on the esports board next to Underdog', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  srv.cache.prizepicks = { data: [], updated: null };
  srv.cache.underdog = { data: [{ book: 'underdog', sport: 'CS', player: 'NAF', team: 'Team Liquid', market: 'Kills on Maps 1+2', line: 30.5, startTime: start, matchTitle: 'Team Liquid vs NAVI',
    overMultiplier: 1, underMultiplier: 1, overOpen: true, underOpen: true }] };
  srv.cache.sleeper = { data: [
    { book: 'sleeper', sport: 'CS', player: 'NAF', team: 'Liquid', market: 'Kills Maps 1-2', line: 29.5, overMultiplier: 1.8, underMultiplier: 1.9, overOpen: true, underOpen: true },
    { book: 'sleeper', sport: 'CS', player: 'Twistzz', team: 'Liquid', market: 'Headshots Maps 1-2', line: 14.5, overMultiplier: 1.85, underMultiplier: 1.85, overOpen: true, underOpen: true },
    { book: 'sleeper', sport: 'CS', player: 'ghost', team: 'Unknown Five', market: 'Kills Maps 1-2', line: 20.5, overMultiplier: 1.85, underMultiplier: 1.85, overOpen: true, underOpen: true },
  ] };
  srv.esportsCache.manualPredictions = { 'NAF|Kills on Maps 1+2': 31.5, 'Twistzz|Headshots Maps 1-2': 16 };
  const picks = await srv.generateEsportsPicks();
  const naf = picks.find(p => p.player === 'NAF');
  assert.equal(naf.lineSource, 'ud');
  assert.equal(naf.sleeperLine, 29.5);
  assert.equal(naf.sleeperMultiplier, 1.8);
  assert.ok(naf.sleeperEv != null && naf.udEv != null);
  // a line a point lower on the over is worth more than the same price at 30.5
  assert.ok(naf.side === 'OVER');
  const tw = picks.find(p => p.player === 'Twistzz');
  assert.equal(tw.lineSource, 'sl');
  assert.equal(tw.startTime, start);
  assert.equal(tw.bestBook, 'SL');
  assert.ok(!picks.some(p => p.player === 'ghost'));
});
