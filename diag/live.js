// Live check for PR 233: shopper exchange prices carry book size, minSize works, arbs sized.
const fs = require('fs');
fs.mkdirSync('out', { recursive: true });
const B = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
async function get(p) { const t0 = Date.now(); try { const r = await fetch(B + p, { signal: AbortSignal.timeout(90000) }); const j = await r.json(); return { status: r.status, ms: Date.now() - t0, j }; } catch (e) { return { error: e.message, ms: Date.now() - t0 }; } }
(async () => {
  let st;
  for (let i = 0; i < 50; i++) { st = await get('/api/status'); if (st.j?.shopDepth?.budget?.polymarketus === 0) break; await wait(30000); }
  const out = { version: st.j?.version, deployedSeenAt: new Date().toISOString() };
  await wait(10 * 60e3);
  st = await get('/api/status');
  out.shopDepth = st.j?.shopDepth; out.exchangeSize = { scans: st.j?.exchangeSize?.scans, errors: st.j?.exchangeSize?.errors, reads: st.j?.exchangeSize?.reads };
  const sum = v => {
    const cells = v.j?.markets?.flatMap(m => m.sides.flatMap(s => s.prices)) || [];
    const ex = cells.filter(c => ['kalshi', 'gemini', 'polymarketus'].includes(c.provider));
    const sized = ex.filter(c => c.size && !c.size.unread);
    return { status: v.status, ms: v.ms, markets: v.j?.counts, exchangeCells: ex.length, sized: sized.length, unread: ex.filter(c => c.size?.unread).length,
      byVenue: Object.fromEntries(['kalshi', 'gemini', 'polymarketus'].map(k => [k, { cells: ex.filter(c => c.provider === k).length, sized: sized.filter(c => c.provider === k).length }])),
      sample: sized.slice(0, 5).map(c => ({ provider: c.provider, effective: c.effective, listed: c.listed, sizedAt: c.sizedAt, ev: c.ev, size: c.size })),
      opps: (v.j?.opportunities || []).slice(0, 8).map(o => ({ sel: o.selection, provider: o.provider, ev: o.ev, sizedAt: o.sizedAt, size: o.size && { unread: o.size.unread, tiers: o.size.tiers, topUsd: o.size.topUsd, ageSec: o.size.ageSec } })),
      arbs: (v.j?.arbs || []).slice(0, 5).map(m => ({ event: m.event, profit: m.arb.profit, size: m.arb.size })) };
  };
  out.all = sum(await get('/api/shopper?limit=1000'));
  out.tx = sum(await get('/api/shopper?state=TX&limit=1000'));
  out.tx200 = sum(await get('/api/shopper?state=TX&minSize=200&limit=1000'));
  out.arbs = sum(await get('/api/shopper?arbs=1&limit=200'));
  out.page = (await fetch(B + '/app').then(r => r.text()).catch(() => '')).includes('MIN BET SIZE');
  fs.writeFileSync('out/result.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out).slice(0, 3000));
})();
