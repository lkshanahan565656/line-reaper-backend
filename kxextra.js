// ─── KALSHI FIGHT, RACE AND TENNIS MARKETS AS PICK'EM FAIRS ───────────────────
// Kalshi lists markets that are the same bets as pick'em legs with no player
// ladder behind them:
//   UFC: method of victory (KXUFCMOV) → Knockouts / Knockout Win, Submissions /
//   Submission Win, Finishes (KO + submission); round of victory
//   (KXUFCVICROUND) → 1st..5th Round Finish; goes the distance
//   (KXUFCDISTANCE) → Fight Time over 14.99 / 24.99 minutes.
//   NASCAR: top 3 / 5 / 10 / 20 and the winner → Finishing Position under
//   N + 0.5 (a lower number is a better finish).
//   Tennis: total games ladders (KXATPGTOTAL, KXWTAGTOTAL) → Games Played.
// A yes mid counts only where the book is tight (maxSpread), like kprops.js.
// Output is quotes in pinprops' shape with book 'kalshi' and `start` = the
// market's expected expiration (around the event's end), matched to a board
// row by player, stat, line and time (quoteAt).

const { canonName } = require('./ev');

const KALSHI_EVENTS = 'https://api.elections.kalshi.com/trade-api/v2/events';
const SERIES = {
  MMA: ['KXUFCMOV', 'KXUFCVICROUND', 'KXUFCDISTANCE'],
  MOTORSPORTS: ['KXNASCARRACE', 'KXNASCARTOP3', 'KXNASCARTOP5', 'KXNASCARTOP10', 'KXNASCARTOP20'],
  TENNIS: ['KXATPGTOTAL', 'KXWTAGTOTAL'],
};
const DEFAULTS = { maxSpread: 0.06, minProb: 0.01, windowMs: 14 * 3600e3 };
const num = x => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };
const ROUND_WORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };

// a market's yes mid, or null when the book is one-sided or wide
function mid(mk, o = DEFAULTS) {
  if (mk.status && !/^(active|open|initialized)$/.test(mk.status)) return null;
  const bid = num(mk.yes_bid_dollars), ask = num(mk.yes_ask_dollars);
  if (!(bid > 0) || !(ask < 1) || !(ask > bid) || ask - bid > o.maxSpread) return null;
  const p = (bid + ask) / 2;
  return p >= o.minProb && p <= 1 - o.minProb ? p : null;
}
const q = (sport, player, mkey, line, pOver, start, extra = {}) => ({
  sport, book: 'kalshi', player, mkey, key: `${sport}|${canonName(player)}|${mkey}`, line, pOver: +pOver.toFixed(4), start, ...extra,
});
// "Cody Chovancek vs Soyoung You: Method of Victory" → both fighters
const fighters = title => String(title || '').replace(/:.*$/, '').split(/\s+vs\.?\s+/i).map(s => s.trim()).filter(Boolean);

// One UFC event (any of the three series) → quotes
// fiveRounds: canonName pairs of fights with round 4 or 5 markets (main events)
const pairKey = names => names.map(canonName).sort().join('|');
function ufcQuotes(ev, series, o = DEFAULTS, now = Date.now(), fiveRounds = new Set()) {
  const out = [];
  const mks = ev.markets || [];
  const exp = mks.map(m => Date.parse(m.expected_expiration_time || '')).find(t => t > now);
  if (!exp) return out;
  const start = new Date(exp).toISOString();
  if (series === 'KXUFCDISTANCE') {
    const mk = mks[0];
    const p = mk ? mid(mk, o) : null;
    if (p == null) return out;
    // a five-round fight goes the distance at 25 minutes, the rest at 15
    const mins = fiveRounds.has(pairKey(fighters(ev.title))) ? 24.99 : 14.99;
    for (const f of fighters(ev.title)) out.push(q('MMA', f, 'fight_time', mins, p, start, { ticker: mk.ticker }));
    return out;
  }
  const per = new Map();   // fighter → { ko, sub, dec, r1..r5 }
  for (const mk of mks) {
    const p = mid(mk, o);
    if (p == null) continue;
    if (series === 'KXUFCMOV') {
      const m = /^(.+?)\s+wins by\s+(KO\/TKO\/DQ|Submission|Decision)/i.exec(mk.title || '');
      if (!m) continue;
      const f = m[1].trim(), kind = /^ko/i.test(m[2]) ? 'ko' : /^sub/i.test(m[2]) ? 'sub' : 'dec';
      if (!per.has(f)) per.set(f, {});
      per.get(f)[kind] = { p, ticker: mk.ticker };
    } else if (series === 'KXUFCVICROUND') {
      const m = /^(.+?)\s+to win in Round\s+(\d)/i.exec(mk.yes_sub_title || '');
      if (!m || !ROUND_WORD[m[2]]) continue;
      out.push(q('MMA', m[1].trim(), `${ROUND_WORD[m[2]]}_round_finish`, 0.5, p, start, { ticker: mk.ticker }));
    }
  }
  for (const [f, x] of per) {
    if (x.ko) out.push(q('MMA', f, 'knockouts', 0.5, x.ko.p, start, { ticker: x.ko.ticker }));
    if (x.sub) out.push(q('MMA', f, 'submissions', 0.5, x.sub.p, start, { ticker: x.sub.ticker }));
    if (x.ko && x.sub && x.ko.p + x.sub.p < 1) out.push(q('MMA', f, 'finishes', 0.5, x.ko.p + x.sub.p, start, { ticker: `${x.ko.ticker}+${x.sub.ticker}` }));
  }
  return out;
}

// NASCAR: "Cup Series: Brad Keselowski to finish in the top 5" / "... wins"
function nascarQuotes(ev, series, o = DEFAULTS, now = Date.now()) {
  const top = series === 'KXNASCARRACE' ? 1 : Number(/TOP(\d+)$/.exec(series)?.[1]);
  if (!top) return [];
  const out = [];
  for (const mk of ev.markets || []) {
    const exp = Date.parse(mk.expected_expiration_time || '');
    if (!(exp > now)) continue;
    const p = mid(mk, o);
    const name = String(mk.yes_sub_title || '').trim();
    if (p == null || !name) continue;
    const circuit = /^(.+?Series):/i.exec(mk.title || '')?.[1] || '';
    // Finishing Position over top + 0.5 = finishing outside the top N
    out.push(q('MOTORSPORTS', name, 'finishing_position', top + 0.5, 1 - p, new Date(exp).toISOString(), { ticker: mk.ticker, circuit }));
  }
  return out;
}

// Tennis total games: "Over 19.5 games" rungs for "A vs B: Total Games"
function tennisQuotes(ev, o = DEFAULTS, now = Date.now()) {
  const out = [];
  const players = fighters(ev.title);
  if (players.length !== 2) return out;
  for (const mk of ev.markets || []) {
    const exp = Date.parse(mk.expected_expiration_time || '');
    const line = num(mk.floor_strike);
    if (!(exp > now) || line == null || mk.strike_type !== 'greater') continue;
    const p = mid(mk, o);
    if (p == null) continue;
    for (const pl of players) out.push(q('TENNIS', pl, 'games_played', line, p, new Date(exp).toISOString(), { ticker: mk.ticker }));
  }
  return out;
}

function quotesFromEvents(events, o = DEFAULTS, now = Date.now()) {
  const out = [];
  const fiveRounds = new Set();
  for (const { ev, series } of events || []) {
    if (series === 'KXUFCVICROUND' && (ev.markets || []).some(m => /Round\s+[45]\b/i.test(m.yes_sub_title || ''))) fiveRounds.add(pairKey(fighters(ev.title)));
  }
  for (const { ev, series } of events || []) {
    if (/^KXUFC/.test(series)) out.push(...ufcQuotes(ev, series, o, now, fiveRounds));
    else if (/^KXNASCAR/.test(series)) out.push(...nascarQuotes(ev, series, o, now));
    else if (/GTOTAL$/.test(series)) out.push(...tennisQuotes(ev, o, now));
  }
  return out;
}

// key → [quotes]
function indexQuotes(quotes) {
  const idx = new Map();
  for (const x of quotes || []) { if (!idx.has(x.key)) idx.set(x.key, []); idx.get(x.key).push(x); }
  return idx;
}
// The quote for a board row at one line: the same line, settling within
// windowMs after the row starts (a fight card's markets expire at its end, a
// race's when it's run), the nearest such if several.
function quoteAt(idx, row, line, o = DEFAULTS) {
  const t = Date.parse(row?.startTime || '');
  if (!t) return null;
  let best = null;
  for (const x of idx?.get(row.key) || []) {
    if (Math.abs(x.line - line) > 1e-6) continue;
    const d = Date.parse(x.start) - t;
    if (d < -3600e3 || d > o.windowMs) continue;
    if (!best || Math.abs(d) < best.d) best = { x, d: Math.abs(d) };
  }
  return best ? best.x : null;
}

// Polite fetch of every series (Kalshi answers 429 to a quick run): [{ ev, series }]
async function fetchEvents(http, series = SERIES, { pause = 400, retryAfter = 3000 } = {}) {
  const out = [], errors = [];
  const wait = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : null);
  for (const tickers of Object.values(series)) {
    for (const t of tickers) {
      const params = { series_ticker: t, status: 'open', with_nested_markets: true, limit: 200 };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await http.get(KALSHI_EVENTS, { params, timeout: 20000 });
          for (const ev of res?.data?.events || []) out.push({ ev, series: t });
          break;
        } catch (e) {
          if (e.response?.status === 429 && attempt === 0) { await wait(retryAfter); continue; }
          errors.push(`${t}: ${e.response?.status || e.message}`);
          break;
        }
      }
      await wait(pause);
    }
  }
  return { events: out, errors };
}

module.exports = { SERIES, DEFAULTS, mid, ufcQuotes, nascarQuotes, tennisQuotes, quotesFromEvents, indexQuotes, quoteAt, fetchEvents };
