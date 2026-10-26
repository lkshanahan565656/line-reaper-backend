// Offshore reference pairs (offshoreref.js): offshore Polymarket markets paired
// with Kalshi and Polymarket US contracts that pay on the same outcome.
//   node scripts/offshore-pairs.js <dump dir>
// The dump dir holds kalshi-events, kalshi-series, poly-events and pmus-events
// (.json.gz), written by the discovery run on branch diag-offpoly (diag/disc.js).
// Families: race (office, state or district, party), control (chamber, party),
// fed (meeting, outcome). The repo matcher's exact-title pairs (TIME Person of
// the Year, Dancing with the Stars, IPOs) all sat under the $50k offshore bar
// on 10-26, so they are not built here. Everything rejected goes to the
// mismatch list with the reason. Writes seeds/offshore-pairs.json and
// seeds/offshore-mismatch.json.
const z = require('zlib'), fs = require('fs');
const path = require('path');
const xarb = require('../xarb');
const D = (process.argv[2] || '.') + '/';
const OUT = path.join(__dirname, '..', 'seeds');
const L = f => JSON.parse(z.gunzipSync(fs.readFileSync(D + f + '.json.gz')));
const kev = L('kalshi-events'), pev = L('poly-events'), uev = L('pmus-events'), ser = L('kalshi-series');
const MINVOL = 50000;
const ST = { alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy' };
const jl = s => { try { return Array.isArray(s) ? s : JSON.parse(s); } catch { return null; } };
const mismatch = [];
// ── offshore rows (one per Polymarket YES market) ──
const P = new Map();   // key → [{...}]
const pRows = [];
for (const e of pev) {
  if (e.closed) continue;
  for (const m of e.ms) {
    if (m.closed || m.active === false) continue;
    const out = jl(m.out), tok = jl(m.tok);
    if (!out || !tok || out.length !== 2 || !/^yes$/i.test(out[0])) continue;
    pRows.push({ ev: e, m, tok: tok[0], vol: Number(m.vol) || 0, liq: Number(m.liq) || 0, bb: m.bb, ba: m.ba });
  }
}
const add = (key, r) => (P.get(key) || P.set(key, []).get(key)).push(r);
// race keys via xarb.raceKey on the question; control; fed
for (const r of pRows) {
  const q = r.m.q || '', slug = r.ev.slug, git = r.m.git || '';
  const rk = xarb.raceKey({ title: q, exchange: 'polymarket', closeTime: r.m.end });
  if (rk && rk.year === 2026) {
    const [office, place, party, special] = rk.key.split('|');
    const st = ST[place] || place.toLowerCase();
    add(`race|${office}|${st}|${party}|${special}`, r);
    continue;
  }
  let mm;
  if ((mm = /which-party-will-win-the-(house|senate)-in-2026/.exec(slug)) && /^(Democratic|Republican) Party$/.test(git)) { add(`control|${mm[1]}|${git[0]}`, r); continue; }
  if ((mm = /^fed-decision-in-(october|december|january)-/.exec(slug))) {
    const mon = { october: '26OCT', december: '26DEC', january: '27JAN' }[mm[1]];
    const o = { '50+ bps decrease': 'cut50', '25 bps decrease': 'cut25', 'No change': 'hold', '25 bps increase': 'hike25', '50+ bps increase': 'hike50' }[git];
    if (o) add(`fed|${mon}|${o}`, r);
    continue;
  }
}
// ── Kalshi rows ──
const K = new Map();
const kRaw = [];
for (const e of kev) {
  if (e.status !== 'open') continue;
  for (const m of e.ms) {
    const row = { ev: e.ev, s: e.s, cat: e.cat, t: m.t, title: m.title, sub: m.sub, close: m.close, exp: m.exp, fm: e.fm ?? ser[e.s]?.fm, ft: e.ft ?? ser[e.s]?.ft, ya: m.ya, yb: m.yb, vol: Number(m.vol) || 0, rules: m.rules };
    kRaw.push(row);
    let mm;
    if ((mm = /^CONTROL([HS])-2026$/.exec(e.ev))) { const party = m.t.split('-').pop(); K.set(`control|${mm[1] === 'H' ? 'house' : 'senate'}|${party}`, row); continue; }
    if ((mm = /^KXFEDDECISION-(26OCT|26DEC|27JAN)$/.exec(e.ev))) { const o = { C26: 'cut50', C25: 'cut25', H0: 'hold', H25: 'hike25', H26: 'hike50' }[m.t.split('-').pop()]; if (o) K.set(`fed|${mm[1]}|${o}`, row); continue; }
    const rk = xarb.raceKey({ title: m.title, exchange: 'kalshi', eventKey: 'kalshi:' + e.ev });
    if (rk && (rk.year === 2026 || rk.year === 2027)) {
      const [office, place, party, special] = rk.key.split('|');
      const st = ST[place] || place.toLowerCase();
      const key = `race|${office}|${st}|${party}|${special}`;
      if (K.has(key)) mismatch.push({ key, why: 'two Kalshi markets for one race key', a: K.get(key).t, b: m.t });
      else K.set(key, row);
    }
  }
}
// ── Polymarket US rows ──
const U = new Map();
for (const e of uev) {
  for (const m of e.ms) {
    if (m.closed || m.active === false) continue;
    let mm;
    const row = { slug: m.slug, ev: e.slug, cat: e.cat, fee: m.fee, bb: m.bb?.value, ba: m.ba?.value, end: m.end, desc: m.desc };
    if ((mm = /^paccc-us(ho|se)-midterms-2026-11-03-(dem|rep)$/.exec(m.slug))) { U.set(`control|${mm[1] === 'ho' ? 'house' : 'senate'}|${mm[2] === 'dem' ? 'D' : 'R'}`, row); continue; }
    if ((mm = /^ewc-us(gub|se)-([a-z]{2})-2026-11-03-(dem|rep)$/.exec(m.slug))) { U.set(`race|${mm[1] === 'gub' ? 'governor' : 'senate'}|${mm[2]}|${mm[3] === 'dem' ? 'D' : 'R'}|`, row); continue; }
    if ((mm = /^rdc-usfed-fomc-(2026-10-28|2026-12-09|2027-01-27)-(nochng|hike25|hike50|cut25|cut50)$/.exec(m.slug))) {
      const mon = { '2026-10-28': '26OCT', '2026-12-09': '26DEC', '2027-01-27': '27JAN' }[mm[1]];
      U.set(`fed|${mon}|${mm[2] === 'nochng' ? 'hold' : mm[2]}`, row); continue;
    }
  }
}
// ── pick the offshore market per key: deepest by volume; thin duplicates noted ──
const pairs = [];
const now = Date.now(), FROM = now - 21 * 86400e3;   // the backtest window
const keys = new Set([...P.keys()]);
for (const key of keys) {
  const list = P.get(key).sort((a, b) => b.vol - a.vol);
  const best = list[0];
  for (const x of list.slice(1)) mismatch.push({ key, why: 'duplicate offshore market (thinner one dropped)', a: best.m.slug, b: x.m.slug, vol: Math.round(x.vol) });
  if (best.vol < MINVOL) { mismatch.push({ key, why: `offshore volume under $50k ($${Math.round(best.vol)})`, a: best.m.slug }); continue; }
  const k = K.get(key), u = U.get(key);
  if (!k && !u) continue;
  const fam = key.split('|')[0];
  const cat = fam === 'fed' ? 'Economics' : 'Elections';
  const risk = fam === 'control' && key.includes('senate') ? 'Kalshi settles on the President pro tempore on Feb 1 2027; offshore on seats won (VP breaks a 50-50). Same unless independents or a vacancy decide it.'
    : fam === 'control' ? 'Kalshi settles on the Speaker on Feb 1 2027; offshore on seats won. Same unless a coalition Speaker.'
    : fam === 'race' ? 'Party of the winner; both include runoffs. Kalshi may settle on certification, offshore on media calls: same winner, different settle dates.'
    : 'Same FOMC statement; Kalshi "Cut >25bps" equals offshore "50+ bps decrease" since the Fed moves in 25s.';
  pairs.push({ id: key, fam, cat, risk, p: { tok: best.tok, slug: best.m.slug, q: best.m.q, git: best.m.git, vol: Math.round(best.vol), liq: Math.round(best.liq), end: best.m.end, mid: best.bb != null && best.ba != null ? (Number(best.bb) + Number(best.ba)) / 2 : null },
    k: k ? { t: k.t, s: k.s, title: k.title, sub: k.sub, close: k.close, fm: k.fm, ft: k.ft, mid: k.ya != null && k.yb != null ? (Number(k.ya) + Number(k.yb)) / 2 : null, vol: Math.round(k.vol) } : null,
    u: u ? { slug: u.slug, fee: u.fee, mid: u.bb != null && u.ba != null ? (Number(u.bb) + Number(u.ba)) / 2 : null } : null,
    from: FROM, to: now });
}
// sanity: current mids must agree within 15c
const keep = [];
for (const x of pairs) {
  let bad = null;
  if (x.p.mid != null && x.k?.mid != null && Math.abs(x.p.mid - x.k.mid) > 0.15) bad = `Kalshi mid ${x.k.mid.toFixed(3)} vs offshore ${x.p.mid.toFixed(3)}`;
  if (x.p.mid != null && x.u?.mid != null && Math.abs(x.p.mid - x.u.mid) > 0.15) bad = `PM US mid ${x.u.mid.toFixed(3)} vs offshore ${x.p.mid.toFixed(3)}`;
  if (bad) { mismatch.push({ key: x.id, why: 'mids more than 15c apart: ' + bad }); continue; }
  keep.push(x);
}
// families left out on purpose
mismatch.push({ key: 'seat counts', why: 'Kalshi counts seats held after the midterms (incl. holdovers, exact or bands of 5); offshore counts by its own seat rules and brackets differ (≤47 vs Below 45/45/46/47). Not identical.' });
mismatch.push({ key: 'IPO before 2027', why: 'Kalshi pays on a company CONFIRMING an IPO; offshore pays on COMPLETING one. Different events.' });
mismatch.push({ key: 'crypto prices', why: 'Kalshi settles on CF Benchmarks at its own hour; offshore on Binance/Chainlink at another. Different numbers.' });
mismatch.push({ key: 'weather', why: 'Different stations and reports (NWS climate report vs Wunderground).' });
mismatch.push({ key: 'Iran head of state', why: 'Kalshi "next head of state" vs offshore "head of state at end of 2026". Different events.' });
mismatch.push({ key: 'CPI / jobs', why: 'Offshore books under $50k depth or brackets that do not line up with Kalshi strikes; dropped by the volume rule.' });
const by = {}; for (const x of keep) { const c = `${x.fam}:${x.k ? 'K' : ''}${x.u ? 'U' : ''}`; by[c] = (by[c] || 0) + 1; }
console.log('pairs', keep.length, by, 'mismatch', mismatch.length);
const slim = keep.map(x => ({ id: x.id, fam: x.fam, cat: x.cat, risk: x.risk, p: { tok: x.p.tok, slug: x.p.slug, q: x.p.q, outcome: x.p.git, vol: x.p.vol, end: x.p.end },
  k: x.k ? { t: x.k.t, title: x.k.title, sub: x.k.sub, close: x.k.close, fm: x.k.fm ?? null } : null, u: x.u ? { slug: x.u.slug, fee: x.u.fee ?? null } : null }));
const reasons = {}; for (const m of mismatch) { const w = m.why.replace(/ \(\$[\d,]+\)$/, '').replace(/: (Kalshi|PM US) mid .*/, ''); (reasons[w] ||= []).push(m.key); }
fs.writeFileSync(path.join(OUT, 'offshore-pairs.json'), JSON.stringify({ builtAt: new Date().toISOString(), minOffshoreVolume: MINVOL, pairs: slim }, null, 1));
fs.writeFileSync(path.join(OUT, 'offshore-mismatch.json'), JSON.stringify({ builtAt: new Date().toISOString(), reasons: Object.entries(reasons).map(([why, keys]) => ({ why, count: keys.length, examples: keys.slice(0, 8) })) }, null, 1));
