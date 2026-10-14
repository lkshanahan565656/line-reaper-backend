// Logged study: Kalshi and Polymarket US game markets against Pinnacle's
// no-vig fair. Every TICK_S seconds: read Pinnacle, Kalshi game series and
// Polymarket US leagues, pair them (pingames.matchRows), price both sides of
// every paired contract at ask + taker fee. A side whose EV clears THR opens
// an episode: depth at the alerted price, the ask 1, 2 and 5 minutes later,
// Pinnacle's fair then, and Pinnacle's last pregame fair (the close).
// State carries across chained runs (STATE_IN → STATE_OUT).
const fs = require('fs');
const zlib = require('zlib');
const axios = require('axios');
const pin = require('../pingames');
const xarb = require('../xarb');
const pmusLib = require('../pmus');
const { kalshiFee } = require('../exchanges');
const { kalshiDepth, pmusDepth, KALSHI_BOOK_URL } = require('../execcheck');

const DUR_MIN = +process.env.DUR_MIN || 330, TICK_S = +process.env.TICK_S || 60, THR = +process.env.THR || 0.01;
const STATE_IN = process.env.STATE_IN || 'pinx-state.json', STATE_OUT = process.env.STATE_OUT || 'pinx-state.json';
const SAMPLE_EVERY = 10;   // ticks between full-board samples
const http = axios.create({ headers: { 'User-Agent': 'Mozilla/5.0' } });
const pmus = pmusLib.createPolymarketUs({ http, log: null, bookTtlMs: 5e3 });
const sleep = t => new Promise(r => setTimeout(r, t));
const r4 = x => (x == null ? null : Math.round(x * 1e4) / 1e4);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let state = { episodes: [], open: {}, ticks: 0, runs: 0 };
try { state = JSON.parse(fs.readFileSync(STATE_IN, 'utf8')); log('state in', state.episodes.length, 'episodes'); } catch { log('fresh state'); }
state.runs = (state.runs || 0) + 1;
const samples = fs.createWriteStream(`pinx-samples-${state.runs}.jsonl`);

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// ── Kalshi: discover game series with games Pinnacle prices, then read those each tick
let allSeries = [], active = [], lastDiscover = 0;
const kalshiRows = new Map();   // series → rows
async function readSeries(x) {
  const rows = [];
  for (let a = 0; a < 3; a++) {
    const r = await xarb.fetchKalshiEvents(http, { seriesTicker: x, maxPages: 3, onPage: p => rows.push(...xarb.parseKalshiBinaries(p)) });
    if (!r.errors.length) return rows;
    if (/429/.test(r.errors[0].message)) { await sleep(1500 * (a + 1)); rows.length = 0; continue; }
    return null;
  }
  return null;
}
async function discover(games) {
  try { allSeries = await xarb.fetchKalshiGameSeries(http); } catch (e) { log('series list failed', e.message); if (!allSeries.length) allSeries = xarb.SEED_GAME_SERIES; }
  const res = await pool(allSeries, 6, async x => [x, await readSeries(x)]);
  const keep = new Set();
  for (const [x, rows] of res) {
    if (!rows || !rows.length) continue;
    kalshiRows.set(x, rows);
    if (pin.matchRows(rows, games).length) keep.add(x);
  }
  // a GAME series' TOTAL / SPREAD siblings pair through it: keep a root's whole family
  const roots = new Set([...keep].map(x => x.replace(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/, '')));
  active = allSeries.filter(x => roots.has(x.replace(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/, '')) && kalshiRows.has(x));
  lastDiscover = Date.now();
  log(`discover: ${allSeries.length} series, ${active.length} active:`, active.join(' '));
}

const sideKey = (row, side) => `${row.exchange}:${row.id}:${side}`;
const feeOf = (row, p) => (row.exchange === 'kalshi' ? kalshiFee(p, 100) / 100 : pmusLib.fee(p, row.feeSchedule?.rate));
function sidesOf(m) {
  const out = [];
  for (const side of ['yes', 'no']) {
    const ask = side === 'yes' ? m.row.yesAsk : m.row.noAsk;
    if (!(ask > 0.02 && ask < 0.98) || !m.row.tradable) continue;
    const fair = side === 'yes' ? m.pYes : 1 - m.pYes;
    const cost = ask + feeOf(m.row, ask);
    out.push({ key: sideKey(m.row, side), side, ask, cost: r4(cost), fair: r4(fair), ev: r4(fair / cost - 1), m });
  }
  return out;
}

async function depthOf(s) {
  const row = s.m.row;
  try {
    if (row.exchange === 'kalshi') {
      const r = await http.get(KALSHI_BOOK_URL(row.id), { timeout: 8000 });
      return kalshiDepth(r.data, s.side, s.ask);
    }
    const b = await pmus.book(row.id);
    if (!b) return null;
    const buy = s.side === 'yes' ? row.yesSide : row.yesSide === 'long' ? 'short' : 'long';
    return { ...pmusDepth(b, buy, s.ask), bookAsk: buy === 'long' ? b.ask : b.bid != null ? r4(1 - b.bid) : null };
  } catch { return null; }
}

async function tick() {
  const t = Date.now();
  const P = await pin.fetchPinnacleGames(http, { now: t });
  if (P.errors.length) log('pinnacle errors', P.errors.join('; '));
  if (!P.games.length) { log('no pinnacle games'); return; }
  if (t - lastDiscover > 45 * 60e3) await discover(P.games);
  else await pool(active, 6, async x => { const rows = await readSeries(x); if (rows) kalshiRows.set(x, rows); });
  let pmRows = [];
  try { pmRows = await pmus.arbRows({ maxPages: 4 }); } catch (e) { log('pmus failed', e.message); }
  const rows = [...[...kalshiRows.entries()].filter(([x]) => active.includes(x)).flatMap(([, r]) => r), ...pmRows];
  const matched = pin.matchRows(rows, P.games);
  const sides = matched.flatMap(sidesOf).filter(s => Date.parse(s.m.game.start) - t > 60e3);
  const byKey = new Map(sides.map(s => [s.key, s]));

  // Polymarket US snapshot quotes can lag: candidates are re-read on the live book
  const cands = sides.filter(s => s.ev >= THR - 0.02 && s.m.row.exchange === 'polymarketus').slice(0, 60);
  await pool(cands, 6, async s => {
    const b = await pmus.book(s.m.row.id);
    if (!b || !b.open) { s.dead = true; return; }
    const buy = s.side === 'yes' ? s.m.row.yesSide : s.m.row.yesSide === 'long' ? 'short' : 'long';
    const ask = buy === 'long' ? b.ask : b.bid != null ? r4(1 - b.bid) : null;
    if (!(ask > 0.02 && ask < 0.98)) { s.dead = true; return; }
    s.ask = ask; s.cost = r4(ask + feeOf(s.m.row, ask)); s.ev = r4(s.fair / s.cost - 1);
  });

  // open episodes: follow-ups and Pinnacle's fair until the start
  for (const ep of state.episodes) {
    if (ep.closed) continue;
    const s = byKey.get(ep.key);
    const start = Date.parse(ep.start);
    if (t >= start - 60e3) { ep.closed = true; continue; }
    if (s && !s.dead) {
      ep.lastFair = s.fair; ep.lastFairAt = new Date(t).toISOString(); ep.lastAsk = s.ask; ep.lastCost = s.cost;
      for (const [k, lag] of [['p1', 60e3], ['p2', 120e3], ['p5', 300e3], ['p15', 900e3]]) {
        if (!ep[k] && t - Date.parse(ep.at) >= lag - 5e3) ep[k] = { ask: s.ask, cost: s.cost, fair: s.fair, dt: Math.round((t - Date.parse(ep.at)) / 1000) };
      }
    }
  }
  // new episodes
  const newEps = [];
  for (const s of sides) {
    if (s.dead) continue;
    const openIdx = state.open[s.key];
    if (s.ev >= THR) {
      if (openIdx != null) continue;
      if (s.ask < 0.05 || s.ask > 0.95) continue;
      const g = s.m.game, row = s.m.row;
      const ep = { key: s.key, venue: row.exchange, id: row.id, side: s.side, at: new Date(t).toISOString(), start: g.start, sport: g.sport,
        league: g.league, game: `${g.away} @ ${g.home}`, kind: s.m.kind, line: s.m.line, alt: s.m.alt, pinVig: s.m.vig, pinLimit: s.m.limit,
        label: row.outcomeLabel, ask: s.ask, cost: s.cost, fair: s.fair, ev: s.ev, liq: row.liquidity ?? null };
      state.open[s.key] = state.episodes.length;
      state.episodes.push(ep); newEps.push([ep, s]);
    } else if (openIdx != null && s.ev < THR - 0.005) {
      const ep = state.episodes[openIdx];
      if (ep && !ep.endedAt) ep.endedAt = new Date(t).toISOString();
      delete state.open[s.key];
    }
  }
  await pool(newEps.slice(0, 40), 6, async ([ep, s]) => { ep.depth = await depthOf(s); });

  state.ticks++;
  if (state.ticks % SAMPLE_EVERY === 1) {
    samples.write(JSON.stringify({ t: new Date(t).toISOString(), sides: sides.map(s => [s.key, s.m.game.sport, s.m.kind, s.ask, s.cost, s.fair, s.ev, s.m.vig, Math.round((Date.parse(s.m.game.start) - t) / 60e3)]) }) + '\n');
  }
  const kN = rows.filter(r => r.exchange === 'kalshi').length;
  log(`tick ${state.ticks}: pin ${P.games.length} games, kalshi ${kN} rows / pmus ${pmRows.length}, matched ${matched.length}, sides ${sides.length}, ev>=thr ${sides.filter(s => s.ev >= THR && !s.dead).length}, new ${newEps.length}, eps ${state.episodes.length}`);
}

(async () => {
  const end = Date.now() + DUR_MIN * 60e3;
  while (Date.now() < end) {
    const t0 = Date.now();
    try { await tick(); } catch (e) { log('tick failed', e.stack || e.message); }
    if (state.ticks % 5 === 0) fs.writeFileSync(STATE_OUT, JSON.stringify(state));
    await sleep(Math.max(1000, TICK_S * 1000 - (Date.now() - t0)));
  }
  fs.writeFileSync(STATE_OUT, JSON.stringify(state));
  samples.end();
  await new Promise(r => samples.on('finish', r));
  fs.writeFileSync(`pinx-samples-${state.runs}.jsonl.gz`, zlib.gzipSync(fs.readFileSync(`pinx-samples-${state.runs}.jsonl`)));
  fs.unlinkSync(`pinx-samples-${state.runs}.jsonl`);
  log('done', state.episodes.length, 'episodes');
})();
