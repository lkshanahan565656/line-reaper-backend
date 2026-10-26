// Live read of the public API, widgets and /developers on v3.197.0. Makes one key, revokes it at the end.
const B = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
(async () => {
  for (let i = 0; i < 90; i++) {
    try { const h = await (await fetch(`${B}/api/health`)).json(); if (h.version === '3.197.0' && h.listening) break; log('waiting, live', h.version); } catch (e) { log('waiting', e.message); }
    await sleep(20000);
  }
  await sleep(60000);
  const dev = await fetch(`${B}/developers`); const dh = await dev.text();
  log('DEVELOPERS', dev.status, dh.length, 'examples:', (dh.match(/Live example/g) || []).length, 'h1', /Public API and widgets/.test(dh));
  const mk = await fetch(`${B}/api/v1/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'live check' }) });
  const kj = await mk.json(); log('MAKE KEY', mk.status, kj.id, kj.name, kj.key ? 'key ok' : JSON.stringify(kj));
  const H = { 'X-API-Key': kj.key };
  log('NO KEY', (await fetch(`${B}/api/v1/leagues`)).status);
  const show = async (u, f) => {
    const r = await fetch(`${B}${u}`, { headers: H }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    log(`\n=== ${u} ${r.status} etag=${r.headers.get('etag')} rem=${r.headers.get('x-ratelimit-remaining')} cors=${r.headers.get('access-control-allow-origin')} bytes=${t.length}`);
    if (j && f) try { log(f(j)); } catch (e) { log('shape error', e.message); }
    if (/polymarket\.com/i.test(t)) log('!! polymarket.com link in', u);
    return { r, j };
  };
  const bp = await show('/api/v1/best-prices?limit=5', j => JSON.stringify({ stale: j.stale, locked: j.locked, count: j.count, rows: j.rows.map(r => `${r.league} ${r.selection} ${r.venueName} ${r.price.american} fair ${r.fair.american} ev ${r.evPct}% fill ${JSON.stringify(r.fill)} ${r.label}`) }, null, 1));
  await show('/api/v1/best-prices?league=nfl&limit=3', j => j.rows.map(r => `${r.selection} ${r.venueName} ${r.price.american} ev ${r.evPct} ${r.label}`).join('\n') || `none (stale ${j.stale})`);
  const mv = await show('/api/v1/moves?limit=3', j => JSON.stringify({ total: j.total, rows: j.rows.map(r => `${r.event} ${r.side} ${r.venueName} ${r.from}->${r.to} ${r.move}`) }, null, 1));
  const gid = mv.j?.rows?.find(r => r.gameId)?.gameId;
  if (gid) await show(`/api/v1/moves/${encodeURIComponent(gid)}`, j => `${j.game?.event} series ${j.series.length} pts ${j.series.map(s => s.points.length).join(',')}`);
  const lg = await show('/api/v1/leagues', j => j.leagues.map(l => `${l.key}:${l.games}`).join(' '));
  const first = lg.j?.leagues?.[0]?.key;
  if (first) await show(`/api/v1/leagues/${first}`, j => `${j.count} games; first ${j.games[0]?.away} @ ${j.games[0]?.home} markets ${j.games[0]?.markets.length}`);
  const rec = await show('/api/v1/record', j => `proven ${j.proven}; ${j.rows.filter(r => r.label === 'proven').map(r => `${r.bookName} ${r.kindLabel} ${r.graded} clv ${r.clv} profitShown ${r.profitShown}`).join('; ')}; rows ${j.rows.length}`);
  await show('/api/v1/record/flags?limit=2', j => `total ${j.total}`);
  const dg = await show('/api/v1/digest', j => `current ${j.current} weeks ${j.weeks.length}`);
  if (dg.j?.current) await show(`/api/v1/digest/${dg.j.current}`, j => `frozen ${j.frozen}`);
  await show('/api/v1/status', j => `version ${j.version} feeds ${j.summary?.up}/${j.summary?.on}`);
  await show('/api/v1/key', j => JSON.stringify(j));
  const et = rec.r.headers.get('etag');
  const r304 = await fetch(`${B}/api/v1/record`, { headers: { ...H, 'If-None-Match': et } }); log('\nETAG REPEAT', r304.status);
  for (const u of ['/embed/best-price?league=nfl&n=3', '/embed/best-price', '/embed/line-move', '/embed/record', '/embed.js']) {
    const r = await fetch(`${B}${u}`); const t = await r.text();
    log(`\nWIDGET ${u} ${r.status} xfo=${r.headers.get('x-frame-options')} bytes ${t.length}`);
    log(t.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 700));
  }
  const del = await fetch(`${B}/api/v1/key`, { method: 'DELETE', headers: H }); log('\nREVOKE', del.status, 'after:', (await fetch(`${B}/api/v1/leagues`, { headers: H })).status);
})().catch(e => log('FAIL', e.stack));
