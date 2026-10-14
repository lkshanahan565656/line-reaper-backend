// Calibration of Kalshi settled markets: buy YES at ask / NO at 1-bid at a
// fixed time before close, taker fee 0.07*mult*p(1-p), paid at settlement.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const dir = process.env.DATA || process.argv[2];
const rows = []; for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json.gz'))) rows.push(...JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f)))));
const H = (process.env.H || '0,60,180,360,1440').split(',').map(Number);
const ANCHOR = process.env.ANCHOR || 'start', GAMEH = Number(process.env.GAMEH || 3);
const MAXSPREAD = Number(process.env.MAXSPREAD || 5);
const feeOf = (r, p) => (/free/.test(r.ft || '') ? 0 : 0.07 * (r.fm ?? 1) * p * (1 - p));
const closes = rows.map(r => Date.parse(r.close)).sort((a, b) => a - b), MID = closes[Math.floor(closes.length / 2)];
console.log('markets', rows.length, 'events', new Set(rows.map(r => r.ev)).size, 'close range', new Date(closes[0]).toISOString(), new Date(closes.at(-1)).toISOString(), 'split', new Date(MID).toISOString());
const bets = [];
for (const r of rows) {
  if (!(r.pay === 0 || r.pay === 1)) continue;
  const ct = Date.parse(r.close);
  // anchor: scheduled start (expected expiration - GAMEH), independent of the outcome
  const anchor = ANCHOR === 'close' ? ct : Date.parse(r.exp) - GAMEH * 3600e3;
  if (!Number.isFinite(anchor)) continue;
  const c = r.c.map(x => [Math.round((anchor - (ct - x[0] * 60e3)) / 60e3), ...x.slice(1)]).sort((a, b) => a[0] - b[0]); // minutes before anchor
  for (const h of H) {
    if (ANCHOR !== 'close' && anchor - h * 60e3 >= ct) continue; // market already closed then
    const k = c.find(x => x[0] >= h && x[0] < h + 60 + (h >= 1440 ? 180 : 0)); if (!k) continue;
    const [mb, a, b, v] = k; if (a == null || b == null || a <= 0 || a >= 100 || b <= 0 || b >= 100 || a - b > MAXSPREAD) continue;
    for (const [side, pc, win] of [['yes', a, r.pay], ['no', 100 - b, 1 - r.pay]]) {
      const p = pc / 100, cost = p + feeOf(r, p);
      bets.push({ r, h, side, p, win, cost, pnl: win - cost, roi: (win - cost) / cost, half: Date.parse(r.close) >= MID ? 2 : 1, spread: a - b });
    }
  }
}
const bucket = p => p < 0.05 ? '01-05' : p < 0.1 ? '05-10' : p < 0.2 ? '10-20' : p < 0.35 ? '20-35' : p < 0.5 ? '35-50' : p < 0.65 ? '50-65' : p < 0.8 ? '65-80' : p < 0.9 ? '80-90' : p < 0.95 ? '90-95' : '95-99';
function agg(l) {
  const n = l.length; if (!n) return null;
  const cost = l.reduce((s, b) => s + b.cost, 0), pnl = l.reduce((s, b) => s + b.pnl, 0);
  const evs = new Map(); for (const b of l) { const e = evs.get(b.r.ev) || [0, 0]; e[0] += b.pnl; e[1] += b.cost; evs.set(b.r.ev, e); }
  const roi = pnl / cost; let v = 0; for (const [p, c] of evs.values()) v += (p - roi * c) ** 2; const se = Math.sqrt(v) / cost;
  const hr = h => { const x = l.filter(b => b.half === h); const c2 = x.reduce((s, b) => s + b.cost, 0); return c2 ? +(100 * x.reduce((s, b) => s + b.pnl, 0) / c2).toFixed(1) : null; };
  return { n, ev: evs.size, roi: +(100 * roi).toFixed(2), se: +(100 * se).toFixed(2), t: +(roi / (se || 1e-9)).toFixed(2), h1: hr(1), h2: hr(2), avgP: +(l.reduce((s, b) => s + b.p, 0) / n).toFixed(3), winRate: +(l.reduce((s, b) => s + b.win, 0) / n).toFixed(3) };
}
function table(title, keyOf, filter = () => true, min = 100) {
  const g = new Map(); for (const b of bets) { if (!filter(b)) continue; const k = keyOf(b); if (k == null) continue; (g.get(k) || g.set(k, []).get(k)).push(b); }
  const out = [...g].map(([k, l]) => ({ k, ...agg(l) })).filter(x => x.n >= min).sort((a, b) => b.roi - a.roi);
  console.log(`\n=== ${title} (${out.length} rows)`);
  for (const x of out) console.log(`${x.k.padEnd(48)} n=${String(x.n).padStart(6)} ev=${String(x.ev).padStart(5)} roi=${String(x.roi).padStart(7)}% se=${x.se} t=${x.t} h1=${x.h1} h2=${x.h2} p=${x.avgP} win=${x.winRate}`);
  return out;
}
module.exports = { rows, bets, agg, table, bucket };
if (require.main === module) {
  console.log('bets', bets.length);
  table('price bucket (all horizons, all cats)', b => bucket(b.p));
  table('price bucket x horizon', b => `${bucket(b.p)} h${b.h}`);
  table('cat x price bucket', b => `${b.r.cat} ${bucket(b.p)}`, () => true, 200);
  table('cat x side x bucket (p>=80 or <=20)', b => `${b.r.cat} ${b.side} ${bucket(b.p)}`, b => b.p >= 0.8 || b.p < 0.2, 200);
}
