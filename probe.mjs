// Gemini Predictions probe: what the public API gives a maker test (events, books, trade prints, settled events).
import fs from 'fs';
const A = 'https://api.gemini.com';
const out = {};
async function get(p) {
  try { const r = await fetch(A + p, { headers: { accept: 'application/json' } }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: r.status, j, txt: j ? null : txt.slice(0, 400) }; } catch (e) { return { status: 0, err: String(e) }; }
}
const save = (k, v) => { out[k] = v; fs.writeFileSync('out/probe.json', JSON.stringify(out, null, 1)); };
fs.mkdirSync('out', { recursive: true });
const ev = await get('/v1/prediction-markets/events?status=active&sport=hockey&sport=basketball&sport=american_football&sports_market_type=moneyline&sports_market_type=spread&sports_market_type=total&sports_market_scope=full_contest&limit=500');
const evs = ev.j?.data || ev.j?.events || (Array.isArray(ev.j) ? ev.j : []);
save('activeStatus', ev.status); save('activeKeys', ev.j && Object.keys(ev.j)); save('activeCount', evs.length); save('activeSample', evs.slice(0, 2));
for (const st of ['settled', 'closed', 'resolved', 'expired', 'inactive', 'finalized']) {
  const r = await get(`/v1/prediction-markets/events?status=${st}&sport=hockey&limit=5`);
  const d = r.j?.data || r.j?.events || (Array.isArray(r.j) ? r.j : []);
  save('status_' + st, { status: r.status, n: d.length, keys: r.j && Object.keys(r.j), sample: d.slice(0, 1), txt: r.txt });
}
const syms = evs.flatMap(e => (e.contracts || []).map(c => c.instrumentSymbol)).filter(Boolean);
save('symCount', syms.length);
const s = syms[0];
if (s) {
  save('book', await get(`/v1/book/${encodeURIComponent(s)}`));
  save('trades', await get(`/v1/trades/${encodeURIComponent(s)}?limit_trades=500`));
  save('tradesOld', await get(`/v1/trades/${encodeURIComponent(s)}?limit_trades=500&timestamp=${Math.floor(Date.now()/1000) - 86400 * 3}`));
  save('candles', await get(`/v2/candles/${encodeURIComponent(s)}/1m`));
  save('ticker', await get(`/v2/ticker/${encodeURIComponent(s)}`));
  save('symDetails', await get(`/v1/symbols/details/${encodeURIComponent(s)}`));
  save('pmTrades', await get(`/v1/prediction-markets/trades?symbol=${encodeURIComponent(s)}`));
}
const counts = [];
for (const x of syms.slice(0, 40)) { const r = await get(`/v1/trades/${encodeURIComponent(x)}?limit_trades=500`); counts.push([x, r.status, Array.isArray(r.j) ? r.j.length : null, Array.isArray(r.j) && r.j.length ? [r.j[0].timestampms, r.j[r.j.length - 1].timestampms] : null]); await new Promise(r => setTimeout(r, 250)); }
save('tradeCounts', counts);
save('symbolsList', await get('/v1/symbols').then(r => ({ status: r.status, n: Array.isArray(r.j) ? r.j.length : null, pm: Array.isArray(r.j) ? r.j.filter(x => /NHL|NBA|NFL|GEMI/i.test(x)).slice(0, 20) : null })));
console.log(JSON.stringify(out).slice(0, 3000));
