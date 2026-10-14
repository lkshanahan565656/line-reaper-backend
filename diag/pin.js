// Pinnacle guest feed: reachable? player props for NFL, CFB, NBA, NHL, MLB, WNBA?
const fs = require('fs');
const G = 'https://guest.api.arcadia.pinnacle.com/0.1';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: 'application/json', Origin: 'https://www.pinnacle.com', Referer: 'https://www.pinnacle.com/' };
const get = async (u, h = {}) => { try { const r = await fetch(u, { headers: { ...UA, ...h }, signal: AbortSignal.timeout(30000) }); const t = await r.text(); return { status: r.status, t }; } catch (e) { return { status: 'ERR ' + e.message, t: '' }; } };
(async () => {
  const out = {};
  const nokey = await get(`${G}/sports`);
  console.log('no key /sports', nokey.status, nokey.t.slice(0, 200));
  // the key the website itself sends
  let key = null;
  const home = await get('https://www.pinnacle.com/en/', { Accept: 'text/html' });
  console.log('home', home.status, home.t.length);
  const srcs = [...home.t.matchAll(/src="([^"]+\.js)"/g)].map(m => new URL(m[1], 'https://www.pinnacle.com/').href);
  console.log('scripts', srcs.length);
  for (const s of srcs.slice(0, 40)) {
    const j = await get(s, { Accept: '*/*' });
    const m = /x-api-key['"]?\s*[:=,]\s*['"]([A-Za-z0-9]{24,40})['"]/i.exec(j.t) || /apiKey['"]?\s*[:=]\s*['"]([A-Za-z0-9]{32})['"]/.exec(j.t);
    if (m) { key = m[1]; console.log('key found in', s); break; }
  }
  if (!key) { key = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R'; console.log('key not found in site scripts; trying the published guest key'); }
  const H = { 'X-API-Key': key };
  const sports = await get(`${G}/sports`, H);
  console.log('/sports with key', sports.status, sports.t.slice(0, 120));
  const leagues = { NFL: 889, CFB: 880, NBA: 487, WNBA: 578, NHL: 1456, MLB: 246 };
  for (const [k, id] of Object.entries(leagues)) {
    const mu = await get(`${G}/leagues/${id}/matchups`, H);
    let arr = []; try { arr = JSON.parse(mu.t); } catch {}
    const specials = Array.isArray(arr) ? arr.filter(m => m.type === 'special') : [];
    const props = specials.filter(m => /player/i.test(m.special?.category || '') || /\(.+\)/.test(m.special?.description || ''));
    const cats = {}; for (const s of specials) cats[s.special?.category] = (cats[s.special?.category] || 0) + 1;
    const mk = await get(`${G}/leagues/${id}/markets/straight`, H);
    let mks = []; try { mks = JSON.parse(mk.t); } catch {}
    const ids = new Set(props.map(p => p.id));
    const priced = Array.isArray(mks) ? mks.filter(m => ids.has(m.matchupId)) : [];
    console.log(k, 'matchups', mu.status, Array.isArray(arr) ? arr.length : '-', 'specials', specials.length, JSON.stringify(cats), 'player props', props.length, 'priced', priced.length, 'markets', mk.status);
    for (const p of props.slice(0, 4)) {
      const m = priced.find(x => x.matchupId === p.id);
      console.log('  ', p.special?.description, '|', (p.participants || []).map(x => `${x.name}:${x.id}`).join(','), '|', JSON.stringify(m?.prices));
    }
    out[k] = { props: props.slice(0, 50), priced: priced.slice(0, 80) };
  }
  fs.writeFileSync('out/pin.json', JSON.stringify(out));
})();
