// Depth add-on to the lead-lag recorder (diag/llrec.js, DEPTH=on). Each tick,
// every Kalshi, Gemini and Polymarket US side whose top-of-book cost (fee in)
// is at or better than Pinnacle's no-vig fair for the same line gets its order
// book read and walked for $50, $200 and $1,000 (depthfill.js). A changed fill
// is logged to out/depth.jsonl; a side whose whole tier fills at +1% or better
// (the pre-registered flag) is re-read every 5 s (Polymarket US every 15 s)
// for 3 minutes into out/watch.jsonl, which is how long a human has.
//
// depth.jsonl: { t, s, k, i, st, fair, pin, alt, lim, top, f: [[usd, cost, ev, full] × tiers], edge$ }
// watch.jsonl: { t, s, k, i, w: flag t, f }
const fs = require('fs');
const D = require('../depthfill');
const pingames = require('../pingames');
const execcheck = require('../execcheck');
const pmus = require('../pmus');

const prob = a => (a == null || !Number.isFinite(+a) || +a === 0 ? null : +a < 0 ? -a / (-a + 100) : 100 / (+a + 100));
const MAX = { kalshi: 80, gemini: 50, polymarketus: 12 };
const WATCH_MS = 180e3, WATCH_EVERY = { kalshi: 5e3, gemini: 5e3, polymarketus: 15e3 }, MAX_WATCH = { kalshi: 6, gemini: 3, polymarketus: 1 };

function createDepth({ http, kget = http.get, stats, now = () => Date.now() }) {
  const dlog = fs.createWriteStream('out/depth.jsonl', { flags: 'a' });
  const wlog = fs.createWriteStream('out/watch.jsonl', { flags: 'a' });
  const lastLine = new Map(), watching = new Map(), watchedAt = new Map(), hold = {};
  const st = (stats.depth = { reads: {}, errors: {}, flags: {}, watches: {}, cands: {}, lines: 0 });

  async function readBook(ref) {
    if (now() < (hold[ref.venue] || 0)) return null;
    try {
      if (ref.venue === 'kalshi') return { asks: execcheck.kalshiAsks((await kget(execcheck.KALSHI_BOOK_URL(ref.id), { timeout: 8000 }))?.data, ref.buy), fee: D.VENUES.kalshi };
      if (ref.venue === 'gemini') return { asks: D.geminiAsks((await http.get(D.GEMINI_BOOK_URL(ref.id), { timeout: 8000 }))?.data, ref.buy), fee: D.VENUES.gemini };
      const b = pmus.parseBook((await http.get(`${pmus.GATEWAY}/v1/markets/${encodeURIComponent(ref.id)}/book`, { timeout: 8000 }))?.data);
      if (!b || b.open === false) return null;
      return { asks: execcheck.pmusAsks(b, ref.buy), fee: { rate: ref.rate ?? D.VENUES.polymarketus.rate, roundCent: false } };
    } catch (e) {
      const s = e.response?.status;
      st.errors[ref.venue] = `${s || ''} ${e.message}`.slice(0, 160);
      if (s === 403 || s === 429) hold[ref.venue] = now() + 10 * 60e3;
      return null;
    } finally { st.reads[ref.venue] = (st.reads[ref.venue] || 0) + 1; }
  }
  const pack = f => D.TIERS.map(t => { const x = f.tiers[t]; return x ? [x.usd, x.cost, x.ev, x.full ? 1 : 0] : null; });

  async function watch(c, flagT) {
    const id = `${c.s}|${c.k}|${c.i}`;
    watching.set(id, true); watchedAt.set(id, flagT);
    st.watches[c.s] = (st.watches[c.s] || 0) + 1;
    try {
      while (now() - flagT < WATCH_MS) {
        await new Promise(r => setTimeout(r, WATCH_EVERY[c.s]));
        const b = await readBook(c.ref);
        if (!b) continue;
        const f = D.fillsOf(b.asks, c.fair, b.fee);
        wlog.write(JSON.stringify({ t: now(), s: c.s, k: c.k, i: c.i, w: flagT, f: pack(f), top: f.top?.cost ?? null }) + '\n');
      }
    } finally { watching.delete(id); }
  }

  // pinE: Map key → { v, m } (Pinnacle raw); venues: { kalshi|gemini|polymarketus: Map key → { v, m, r } }
  async function scan(t, pinE, venues) {
    const cands = [];
    for (const [s, entries] of Object.entries(venues)) {
      for (const [k, e] of entries) {
        const p = pinE.get(k);
        if (!p || !e.r) continue;
        const start = Date.parse(p.m?.st || e.m?.st || '');
        const mins = (start - t) / 60e3;
        if (!(mins >= 2 && mins <= 24 * 60)) continue;
        const three = k.includes('|h2h|') && p.v[2] != null;
        const raw = three ? p.v.slice(0, 3) : p.v.slice(0, 2);
        const fair = pingames.devig(raw);
        if (!fair) continue;
        const alt = k.includes('|h2h|') ? 0 : p.v[2] ? 1 : 0, lim = k.includes('|h2h|') ? p.v[3] : p.v[3];
        for (let i = 0; i < raw.length; i++) {
          const ref = e.r[i], cost = prob(e.v[i]);
          if (!ref || !cost) continue;
          const ev = fair[i] / cost - 1;
          if (ev < 0) continue;
          cands.push({ s, k, i, ref, fair: Math.round(fair[i] * 1e4) / 1e4, ev, st: start, mins, pin: raw, alt, lim });
        }
      }
    }
    const by = {};
    for (const c of cands.sort((a, b) => b.ev - a.ev)) (by[c.s] ||= []).length < MAX[c.s] && by[c.s].push(c);
    for (const [s, cs] of Object.entries(by)) st.cands[s] = cs.length;
    const todo = Object.values(by).flat();
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < todo.length) {
        const c = todo[i++];
        const b = await readBook(c.ref);
        if (!b) continue;
        const f = D.fillsOf(b.asks, c.fair, b.fee);
        const id = `${c.s}|${c.k}|${c.i}`;
        const line = { st: c.st, fair: c.fair, pin: c.pin, alt: c.alt, lim: c.lim, top: f.top?.cost ?? null, f: pack(f), edge$: f.atEdge };
        const j = JSON.stringify([line.fair, line.top, line.f]);
        if (lastLine.get(id) !== j) { lastLine.set(id, j); dlog.write(JSON.stringify({ t, s: c.s, k: c.k, i: c.i, ...line }) + '\n'); st.lines++; }
        const hit = D.TIERS.some(tier => D.flagged(f.tiers[tier]));
        if (hit) {
          st.flags[c.s] = (st.flags[c.s] || 0) + 1;
          const live = [...watching.keys()].filter(x => x.startsWith(`${c.s}|`)).length;
          if (!watching.has(id) && now() - (watchedAt.get(id) || 0) > 10 * 60e3 && live < MAX_WATCH[c.s]) watch(c, t).catch(() => {});
        }
      }
    }));
  }
  const end = () => Promise.all([new Promise(r => dlog.end(r)), new Promise(r => wlog.end(r))]);
  return { scan, end };
}

module.exports = { createDepth, prob };
