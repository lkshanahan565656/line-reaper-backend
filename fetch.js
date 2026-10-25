// UFC probe: the site's MMA board and record, Pinnacle MMA (sport, league,
// related/specials), ESPN UFC scoreboards and a summary, FanDuel's and Kambi's UFC pages.
const fs = require('fs');
const U = 'https://line-reaper-backend-production.up.railway.app';
const H = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
const PH = { ...H, Referer: 'https://www.pinnacle.com/', Origin: 'https://www.pinnacle.com' };
const j = async (url, headers = H) => { try { const r = await fetch(url, { headers }); const t = await r.text(); if (!r.ok) return { _err: r.status, body: t.slice(0, 300) }; try { return JSON.parse(t); } catch { return { _text: t.slice(0, 2000) }; } } catch (e) { return { _err: String(e.message) }; } };
const w = (f, o) => fs.writeFileSync('out/' + f, JSON.stringify(o));
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
(async () => {
  fs.mkdirSync('out', { recursive: true });
  w('status.json', await j(U + '/api/status'));
  w('board-mma.json', await j(U + '/api/props/board?sport=MMA&limit=5000'));
  w('coverage.json', await j(U + '/api/props/coverage'));
  const picks = [];
  for (const st of ['graded', 'locked', 'open']) {
    let before = '';
    for (let i = 0; i < 40; i++) {
      const r = await j(`${U}/api/props/record/picks?status=${st}&limit=1000${before ? '&before=' + encodeURIComponent(before) : ''}`);
      const l = r.picks || [];
      picks.push(...l);
      if (l.length < 1000) break;
      before = l[l.length - 1].signalAt;
    }
  }
  w('picks-mma.json', picks.filter(p => p.sport === 'MMA'));
  w('picks-count.json', { all: picks.length, mma: picks.filter(p => p.sport === 'MMA').length });
  // Pinnacle
  const mu = await j(`${PIN}/sports/22/matchups`, PH), mk = await j(`${PIN}/sports/22/markets/straight`, PH);
  w('pin-sport22.json', { matchups: mu, markets: mk });
  const leagues = [...new Set((Array.isArray(mu) ? mu : []).map(m => m.league?.id))];
  const lg = {};
  for (const id of leagues) lg[id] = { matchups: await j(`${PIN}/leagues/${id}/matchups`, PH), markets: await j(`${PIN}/leagues/${id}/markets/straight`, PH) };
  w('pin-leagues.json', lg);
  const ufc = (Array.isArray(mu) ? mu : []).filter(m => /^UFC/.test(m.league?.name || '') && !m.parentId).slice(0, 6);
  const rel = {};
  for (const m of ufc) rel[m.id] = { related: await j(`${PIN}/matchups/${m.id}/related`, PH), markets: await j(`${PIN}/matchups/${m.id}/markets/related/straight`, PH) };
  w('pin-related.json', rel);
  // ESPN
  const espn = {};
  for (const d of ['20261017', '20261018', '20261024', '20261025', '20261031', '20261101']) espn[d] = await j(`https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${d}`);
  w('espn-boards.json', espn);
  const ev = Object.values(espn).flatMap(b => b.events || []).find(e => e.status?.type?.completed || /final/i.test(e.status?.type?.name || ''));
  if (ev) w('espn-summary.json', await j(`https://site.api.espn.com/apis/site/v2/sports/mma/ufc/summary?event=${ev.id}`));
  // FanDuel and Kambi
  w('fd-ufc.json', await j('https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=ufc&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York'));
  w('fd-mma.json', await j('https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=SPORT&eventTypeId=26420387&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York'));
  w('kambi-ufc.json', await j('https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj/listView/ufc_mma.json?lang=en_US&market=US-NJ&useCombined=true'));
  // Greco1899's mirror last commit (how fresh results are)
  w('greco-commits.json', await j('https://api.github.com/repos/Greco1899/scrape_ufc_stats/commits?per_page=5'));
})();
