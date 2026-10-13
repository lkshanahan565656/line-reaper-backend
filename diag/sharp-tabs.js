// Snapshot of the live Sharp Tail tab data, summarized.
const U = 'https://line-reaper-backend-production.up.railway.app';
const get = async p => { try { const r = await fetch(U + p, { signal: AbortSignal.timeout(40000) }); return await r.json(); } catch (e) { return { error: e.message }; } };
const out = (n, v) => console.log(`==== ${n}\n${JSON.stringify(v)}\n`);
(async () => {
  const st = await get('/api/status');
  out('status', { version: st.version, tail: st.tail && { ...st.tail, jobs: undefined }, jobs: st.tail?.jobs });
  const sig = await get('/api/tail/signals?limit=500');
  const s = sig.signals || [];
  const cnt = (xs, f) => xs.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o; }, {});
  out('signals-counts', { n: s.length, locked: sig.locked, pro: sig.pro, byType: cnt(s, x => x.type), byGrade: cnt(s, x => x.grade), byCat: cnt(s, x => x.category),
    units: cnt(s, x => x.units > 0 ? 'sized' : 'zero'), venue: cnt(s, x => x.venue?.key || 'none'), limit: cnt(s, x => x.limit ? 'limit' : 'no'),
    reasons: cnt(s, x => x.reason || x.note || x.skip || '-'), last: s[0]?.seenAt || s[0]?.at, first: s[s.length - 1]?.seenAt });
  out('signals-sample', s.slice(0, 6));
  const tr = await get('/api/tail/traders?grade=graded&limit=200');
  out('traders', { state: tr.state, n: tr.traders?.length, byGrade: cnt(tr.traders || [], x => x.grade), byCat: cnt(tr.traders || [], x => x.category || x.bestCategory || '-'), sample: (tr.traders || []).slice(0, 3) });
  const bd = await get('/api/tail/board?limit=200');
  out('board', { n: bd.rows?.length, graded: bd.graded, withVenue: (bd.rows || []).filter(r => r.venues?.length).length, sample: (bd.rows || []).slice(0, 4) });
  for (const b of ['tail', 'fresh']) { const r = await get('/api/tail/record?limit=500&book=' + b); out('record-' + b, { ...r, signals: undefined, nSig: r.signals?.length, sample: (r.signals || []).slice(0, 4) }); }
  const ro = await get('/api/tail/record?status=open&limit=500');
  out('record-open', { n: ro.signals?.length, sample: (ro.signals || []).slice(0, 3) });
  const wh = await get('/api/whales?limit=200');
  out('whales', { keys: Object.keys(wh), n: wh.events?.length, byEx: cnt(wh.events || [], x => x.exchange), flow: (wh.flow || []).length, sample: (wh.events || []).slice(0, 3), freshRecord: wh.freshRecord });
  const sh = await get('/api/sharp');
  out('sharp-feed', { n: sh.events?.length, stale: sh.stale?.length, rlm: sh.rlm?.length, state: sh.state });
  const ts = await get('/api/tail/settings');
  out('tail-settings', ts);
})();
