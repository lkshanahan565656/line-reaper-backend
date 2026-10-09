// Player props on a mid-size Odds API plan (20K credits): paced to last the
// month, sharing the plan with game odds, the sports taking turns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-props-'));
for (const k of ['DATABASE_URL', 'OWLS_API_KEY', 'ODDS_API_BUDGET', 'ODDS_API_PROPS', 'ODDS_API_PROPS_SHARE', 'ODDS_API_PACE_MAX', 'PAYWALL']) delete process.env[k];
Object.assign(process.env, {
  ODDS_API_KEY: 'test-key', AUTH_SECRET: 'test-secret',
  TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  TAIL_TRACK_FILE: path.join(DIR, 'tail-signals.json'), TAIL_TRADERS_FILE: path.join(DIR, 'tail-traders.json'),
});
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

// a 20K plan with 1,000 used; each event-odds call bills one credit a market
let used = 1000;
const PLAN = 20000;
const calls = [];
const headers = () => ({ 'x-requests-remaining': String(PLAN - used), 'x-requests-used': String(used) });
const axios = require('axios');
axios.get = async (url, cfg = {}) => {
  const m = url.match(/^https:\/\/api\.the-odds-api\.com\/v4\/sports\/([^/]+)\/events(?:\/([^/]+)\/odds)?$/);
  if (!m) throw Object.assign(new Error(`offline: ${url}`), { code: 'ENOTFOUND' });
  const [, sport, event] = m;
  calls.push({ sport, event: event || null });
  if (!event) {
    return { status: 200, headers: headers(), data: Array.from({ length: 6 }, (_, i) => ({ id: `${sport}-${i}`, home_team: `Home ${i}`, away_team: `Away ${i}`, commence_time: new Date(Date.now() + (i + 1) * 3600e3).toISOString() })) };
  }
  const markets = String(cfg.params?.markets || '').split(',').filter(Boolean);
  used += markets.length;
  return {
    status: 200, headers: headers(),
    data: { bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: markets.map(key => ({ key, outcomes: [
      { name: 'Some Player', description: 'Over', point: 20.5, price: -110 }, { name: 'Some Player', description: 'Under', point: 20.5, price: -110 },
    ] })) }] },
  };
};
axios.post = async () => ({ status: 204, data: '' });

const S = require('../server');
const cron = require('node-cron');
for (const t of cron.getTasks().values()) t.stop();
test.after(() => { for (const t of cron.getTasks().values()) t.stop(); Date.now = realNow; });

const oddsCalls = () => calls.filter(c => c.event).length;

test('a 20K plan paces props: one pull up front, then the sports take turns as credits accrue', async () => {
  const season = Object.keys(S.SPORT_PROP_MARKETS).filter(s => S.inSeasonSports().includes(s));
  assert.ok(season.length >= 1);

  const first = await S.refreshOddsApiProps();
  assert.ok(season.includes(first));
  const markets = S.SPORT_PROP_MARKETS[first].length;
  assert.equal(oddsCalls(), markets > 4 ? 8 : 4, 'the next 4 games, in batches of 4 markets');
  assert.equal(used, 1000 + 4 * markets);
  assert.ok(S.cache.oddsApiProps[first].data.length === 4);

  const p = S.propsBudget.state(), o = S.oddsBudget.state();
  assert.deepEqual([p.paced, p.lowUsage, p.share], [true, false, 0.6], 'paced, not low-usage: props stay on');
  assert.deepEqual([o.paced, o.share], [true, 0.4], 'game odds get the rest');
  // 60% of what's left, less the 5% reserve, over the days to the reset
  const days = require('../quota').msUntilReset(Date.now()) / 86400e3;
  assert.ok(Math.abs(p.creditsPerDay - 0.6 * (PLAN - used - 0.05 * PLAN) / days) < 1, String(p.creditsPerDay));
  assert.ok(Math.abs(o.creditsPerDay - 0.4 * (PLAN - used - 0.05 * PLAN) / days) < 1, String(o.creditsPerDay));

  // straight away: the next sport's turn, but the credits haven't accrued
  const before = oddsCalls();
  const second = await S.refreshOddsApiProps();
  if (season.length > 1) assert.notEqual(second, first, 'the stalest sport is next');
  assert.equal(oddsCalls(), before, 'no billed calls until the budget allows');
  assert.ok(S.propsBudget.state().skippedCalls >= 1);

  // a day later there's room again, and it goes to a sport that hasn't had a turn
  skew += 86400e3;
  const third = await S.refreshOddsApiProps();
  assert.ok(oddsCalls() > before, 'pulled once the credits accrued');
  if (season.length > 1) assert.notEqual(third, first);
});
