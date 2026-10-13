const get = async u => { try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(90000) }); const t = await r.text(); return { status: r.status, len: t.length, j: (() => { try { return JSON.parse(t); } catch { return null; } })() }; } catch (e) { return { error: e.message }; } };
(async () => {
  const raw = (await get('https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control')).j || [];
  const ids = {};
  for (const r of raw) (ids[r.sport] = ids[r.sport] || new Set()).add(r.subject_id);
  for (const s of Object.keys(ids)) {
    const p = await get('https://api.sleeper.app/players/' + encodeURIComponent(s));
    const j = p.j || {};
    const have = [...ids[s]].filter(i => j[i]).length;
    const one = j[[...ids[s]].find(i => j[i])] || null;
    console.log(s, JSON.stringify({ status: p.status, len: p.len, n: Object.keys(j).length, ids: ids[s].size, have, sample: one && { full_name: one.full_name, first_name: one.first_name, last_name: one.last_name, team: one.team, username: one.metadata?.username, keys: Object.keys(one).slice(0, 30) } }));
  }
  // PP period leagues sample
  const pp = (await get('https://line-reaper-backend-production.up.railway.app/api/prizepicks')).j?.data || [];
  for (const s of ['NBA', 'NBAP', 'NBASZN', 'NHL1P', 'MLBLIVE']) console.log('pp', s, JSON.stringify(pp.filter(x => x.sport === s).slice(0, 2)));
})();
