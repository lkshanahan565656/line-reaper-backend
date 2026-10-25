// Kalshi maker backtest (checks/kalshi-maker-2026-10-25/PREREGISTERED.md).
// node scripts/kmaker-backtest.js <kmaker.json.gz> <changes.jsonl.gz>... [--out seeds/kalshi-maker-backtest.json]
// Inputs: the lead-lag recorder's change logs (Pinnacle raw and Kalshi asks,
// once a minute) and diag-kmaker-out's Kalshi markets with their trade prints.
// Replays each Kalshi side: post the bid kmaker.suggestBid gives at the first
// read 2 min to 24 h out, cancel when Pinnacle's fair falls through it, fill
// from the prints, close = Pinnacle's last read <= 20 min before the start,
// result = Kalshi's settlement.
const fs = require('fs');
const zlib = require('zlib');
const xarb = require('../xarb');
const pingames = require('../pingames');
const K = require('../kmaker');

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outFile = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
const [kmFile, ...changeFiles] = args;
const gz = f => zlib.gunzipSync(fs.readFileSync(f)).toString();

// ── change logs → per key time series ──
const pin = new Map(), kal = new Map(), meta = new Map(), baseOfTk = new Map();
const push = (m, k, t, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push([t, v]); };
for (const f of changeFiles) {
  for (const l of gz(f).split('\n')) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const sport = o.k.split('|')[0];
    if (!K.SPORTS.has(sport)) continue;
    if (o.s === 'pinnacle') { push(pin, o.k, o.t, o.gone ? null : o.v); if (o.m) meta.set(o.k.split('|').slice(0, 2).join('|'), o.m); }
    else if (o.s === 'kalshi') { push(kal, o.k, o.t, o.gone ? null : o.v); if (o.m?.tk) baseOfTk.set(o.m.tk, o.k.split('|').slice(0, 2).join('|')); }
  }
}
for (const s of [...pin.values(), ...kal.values()]) s.sort((a, b) => a[0] - b[0]);

// Pinnacle's fair for index i of a key at a point → { p, alt } | null
function pinFairOf(v, market, i) {
  if (!v) return null;
  const raw = market === 'h2h' ? v.slice(0, v[2] != null ? 3 : 2) : v.slice(0, 2);
  if (market === 'h2h' && v[2] != null) return null;       // three-way: not these leagues
  const f = pingames.devig(raw);
  return f ? { p: f[i], alt: market !== 'h2h' && v[2] === 1 } : null;
}

// ── Kalshi markets → sides keyed like the recorder ──
const km = JSON.parse(gz(kmFile));
const sides = [];
for (const g of km.games) {
  const base = baseOfTk.get(g.tk);
  if (!base) continue;
  const m = meta.get(base) || { home: g.home, away: g.away, st: g.st };
  const start = Date.parse(m.st || g.st);
  for (const ev of g.events) {
    const open = ev.markets.map(x => ({ ...x, status: 'active', result: '' }));
    const rows = xarb.parseKalshiBinaries({ events: [{ series_ticker: ev.series, event_ticker: ev.event_ticker, title: ev.markets[0]?.title || '', mutually_exclusive: /GAME$/.test(ev.series), markets: open }] });
    const byT = new Map(ev.markets.map(x => [x.ticker, x]));
    const home = l => (pingames.sameTeam(l, m.home) ? true : pingames.sameTeam(l, m.away) ? false : null);
    for (const r of rows) {
      const mk = byT.get(r.id);
      const one = (key, market, idx, buy, askIdx, label) => sides.push({ key, market, idx, buy, askIdx, label, ticker: r.id, sport: base.split('|')[0], event: `${m.away} @ ${m.home}`, start, mk });
      if (r.kind === 'teams') {
        const h = home(r.outcomeLabel);
        if (h == null) continue;
        one(`${base}|h2h|`, 'h2h', h ? 0 : 1, 'yes', h ? 3 : 4, r.outcomeLabel);
      } else if (r.kind === 'total' && Number.isFinite(r.line)) {
        one(`${base}|totals|${r.line}`, 'totals', 0, 'yes', 2, `Over ${r.line}`);
        one(`${base}|totals|${r.line}`, 'totals', 1, 'no', 3, `Under ${r.line}`);
      } else if (r.kind === 'spread' && Number.isFinite(r.line) && r.lineTeam) {
        const h = home(r.lineTeam);
        if (h == null) continue;
        const key = `${base}|spreads|${h ? -r.line : r.line}`;
        // recorder v: [home, away, homeAsk, awayAsk]; YES = lineTeam covers
        one(key, 'spreads', h ? 0 : 1, 'yes', h ? 2 : 3, `${r.lineTeam} -${r.line}`);
        one(key, 'spreads', h ? 1 : 0, 'no', h ? 3 : 2, `${h ? m.away : m.home} +${r.line}`);
      }
    }
  }
}

// ── replay ──
function replay(s, edge) {
  const ps = pin.get(s.key) || [], ks = kal.get(s.key) || [];
  if (!ps.length || !ks.length) return { skip: 'no series' };
  const series = (s.mk?.trades || []).map(x => x).sort((a, b) => a[0] - b[0]);
  const rate = K.makerRateOf(km.series[s.mk?.ticker?.split('-')[0]] || km.series[Object.keys(km.series).find(x => s.ticker.startsWith(x + '-'))]);
  const times = [...new Set([...ps.map(x => x[0]), ...ks.map(x => x[0])])].sort((a, b) => a - b);
  let pi = -1, ki = -1, bid = null;
  const at = (arr, i) => (i >= 0 ? arr[i][1] : null);
  let lastPin = null, lastPinAt = null, cancelAt = null, fairs = [];
  for (const t of times) {
    while (pi + 1 < ps.length && ps[pi + 1][0] <= t) pi++;
    while (ki + 1 < ks.length && ks[ki + 1][0] <= t) ki++;
    if (t > s.start) break;
    const pv = at(ps, pi), kv = at(ks, ki);
    const f = pinFairOf(pv, s.market, s.idx);
    if (f) { lastPin = f; lastPinAt = null; } else if (pv == null && pi >= 0 && lastPinAt == null) lastPinAt = ps[pi][0];   // gone: the time it went
    const mins = (s.start - t) / 60e3;
    if (!bid) {
      if (!f || f.alt || !kv || !(mins >= 2 && mins <= 1440)) continue;
      const ask = kv[s.askIdx];
      const b = K.suggestBid({ fair: f.p, ask, edge, rate });
      if (!b) continue;
      bid = { ...b, postedAt: t, fairAtPost: f.p, askAtPost: ask, minsBefore: Math.round(mins), rate };
      fairs.push([t, f.p]);
      continue;
    }
    if (f) { fairs.push([t, f.p]); if (!cancelAt && f.p / bid.cost - 1 < 0) cancelAt = t; }
  }
  if (!bid) return { skip: 'no bid' };
  const to = Math.min(cancelAt || s.start, s.start);
  const fill = K.fillOf(series, { buy: s.buy, bid: bid.bid, from: bid.postedAt, to });
  // a change log: the last value holds until the key goes; gone more than 20 min before the start → no close
  const closeFair = lastPin && !lastPin.alt && (lastPinAt == null || s.start - lastPinAt <= 20 * 60e3) ? lastPin.p : null;
  const res = String(s.mk?.result || '').toLowerCase();
  const b = { sport: s.sport, event: s.event, market: s.market, side: s.label, ticker: s.ticker, buy: s.buy, start: new Date(s.start).toISOString(),
    ...bid, cost: bid.cost, cancelAt, closeFair, result: res || null,
    filled: !!fill.through, filledAtBid: !fill.through && !!fill.atBid, fillAt: (fill.through || fill.atBid)?.t ?? null, printsInWindow: series.filter(x => x[0] > bid.postedAt && x[0] <= to).length };
  const first = fill.through || fill.atBid;
  if (first) b.fairAtFill = K.fairAt({ fairAtPost: bid.fairAtPost, fairs }, first.t);
  // where Kalshi traded 30 min after the fill (adverse selection on Kalshi's own tape)
  if (first) { const later = series.filter(x => x[0] > first.t && x[0] <= first.t + 30 * 60e3).pop(); if (later) b.kalshiAfter30 = s.buy === 'yes' ? later[1] : Math.round((1 - later[1]) * 100) / 100; }
  Object.assign(b, K.grade(b));
  b.status = b.outcome ? 'graded' : b.filled || b.filledAtBid ? 'filled' : 'unfilled';
  return { bid: b };
}

// Extra, not judged: a bid re-priced at every read (cancel and replace to the
// current fair), the first print through the bid in force at that moment fills it.
function requote(s, edge) {
  const ps = pin.get(s.key) || [], ks = kal.get(s.key) || [];
  if (!ps.length || !ks.length) return null;
  const prints = (s.mk?.trades || []).slice().sort((a, b) => a[0] - b[0]);
  const rate = K.makerRateOf(km.series[s.ticker.split('-')[0]]);
  const times = [...new Set([...ps.map(x => x[0]), ...ks.map(x => x[0])])].sort((a, b) => a - b);
  let pi = -1, ki = -1, cur = null, lastPin = null, goneAt = null, fill = null, firstAt = null;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t > s.start) break;
    while (pi + 1 < ps.length && ps[pi + 1][0] <= t) pi++;
    while (ki + 1 < ks.length && ks[ki + 1][0] <= t) ki++;
    const pv = pi >= 0 ? ps[pi][1] : null, kv = ki >= 0 ? ks[ki][1] : null;
    const f = pinFairOf(pv, s.market, s.idx);
    if (f) { lastPin = f; goneAt = null; } else if (pv == null && pi >= 0 && goneAt == null) goneAt = ps[pi][0];
    const mins = (s.start - t) / 60e3;
    cur = f && !f.alt && kv && mins >= 2 && mins <= 1440 ? K.suggestBid({ fair: f.p, ask: kv[s.askIdx], edge, rate }) : null;
    if (cur && firstAt == null) firstAt = t;
    if (!cur || fill) continue;
    const until = Math.min(times[i + 1] ?? s.start, s.start);
    const fl = K.fillOf(prints, { buy: s.buy, bid: cur.bid, from: t, to: until });
    if (fl.through) fill = { ...cur, t: fl.through.t, fairAtPost: f.p };
  }
  if (firstAt == null) return null;
  const closeFair = lastPin && !lastPin.alt && (goneAt == null || s.start - goneAt <= 20 * 60e3) ? lastPin.p : null;
  if (!fill) return { sport: s.sport, market: s.market, start: new Date(s.start).toISOString(), filled: false };
  const b = { sport: s.sport, market: s.market, start: new Date(s.start).toISOString(), buy: s.buy, bid: fill.bid, cost: fill.cost, fairAtPost: fill.fairAtPost, fairAtFill: fill.fairAtPost, closeFair, result: String(s.mk?.result || '').toLowerCase() || null, filled: true };
  Object.assign(b, K.grade(b));
  b.status = b.outcome ? 'graded' : 'filled';
  return b;
}
const report = { at: new Date().toISOString(), data: { changeFiles: changeFiles.length, kalshiPulledAt: km.at, games: km.games.length, sides: sides.length,
  from: null, to: null, fees: km.series }, byEdge: {} };
const allT = [...pin.values()].flat().map(x => x[0]);
report.data.from = new Date(Math.min(...allT)).toISOString(); report.data.to = new Date(Math.max(...allT)).toISOString();
for (const edge of K.EDGES) {
  const bids = [], skips = {};
  for (const s of sides) { const r = replay(s, edge); if (r.bid) bids.push(r.bid); else skips[r.skip] = (skips[r.skip] || 0) + 1; }
  // only games that started before the prints were pulled: their fill windows are complete
  const started = bids.filter(b => Date.parse(b.start) < Date.parse(km.at) && Date.parse(b.start) <= Date.parse(report.data.to) + 20 * 60e3);
  report.byEdge[edge] = {
    skips, all: K.summarize(started), atBid: K.summarize(started, { fill: 'atBid' }),
    bySport: K.summarizeBy(started, b => b.sport), byMarket: K.summarizeBy(started, b => b.market),
    unfilledCloseDrift: (() => { const u = started.filter(b => !b.filled && !b.filledAtBid && b.closeFair); return u.length ? Math.round(u.reduce((s, b) => s + b.closeFair - b.fairAtPost, 0) / u.length * 1e4) / 1e4 : null; })(),
    kalshiAfter30: (() => { const f = started.filter(b => b.filled && b.kalshiAfter30 != null); return f.length ? Math.round(f.reduce((s, b) => s + b.kalshiAfter30 - b.bid, 0) / f.length * 1e4) / 1e4 : null; })(),
    requote: (() => { const rq = sides.map(s => requote(s, edge)).filter(b => b && Date.parse(b.start) < Date.parse(km.at) && Date.parse(b.start) <= Date.parse(report.data.to) + 20 * 60e3); return K.summarize(rq); })(),
    ...(edge === K.EDGE ? { bids: started.filter(b => b.filled || b.filledAtBid).map(({ rate, ...b }) => b) } : {}),
  };
}
const main = report.byEdge[K.EDGE].all;
report.verdict = main.verdict;
report.summary = `Backtest ${report.data.from.slice(0, 16)}Z to ${report.data.to.slice(0, 16)}Z: ${main.posted} bids posted at 2% under Pinnacle's fair after the maker fee, ${main.filled} filled through the bid (${main.fillRate == null ? '—' : Math.round(main.fillRate * 100)}%), ${main.graded} graded vs Pinnacle's close, mean CLV ${main.clv == null ? '—' : (main.clv * 100).toFixed(1) + '%'} (t ${main.clvT ?? '—'}), results ${main.won}-${main.lost}.`;
console.log(JSON.stringify({ summary: report.summary, data: { ...report.data, fees: undefined }, edges: Object.fromEntries(Object.entries(report.byEdge).map(([e, x]) => [e, { all: x.all, atBid: x.atBid, skips: x.skips, bySport: x.bySport, byMarket: x.byMarket, unfilledCloseDrift: x.unfilledCloseDrift, kalshiAfter30: x.kalshiAfter30, requote: x.requote }])) }, null, 1));
if (outFile) fs.writeFileSync(outFile, JSON.stringify(report));
