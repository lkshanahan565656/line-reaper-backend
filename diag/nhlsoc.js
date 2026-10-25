// Probe 10-25: NHL and soccer prop coverage. Prod board rows, Pinnacle specials,
// Kambi soccer and NHL bet offers, FanDuel soccer pages, Kalshi series, ESPN boxes.
const fs = require('fs');
const P = 'https://line-reaper-backend-production.up.railway.app';
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const KAL = 'https://api.elections.kalshi.com/trade-api/v2';
const KB = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
const FDK = '_ak=FhMFpcPWXMeyZxOx';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: 'application/json' };
const PINH = UA;
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async (u, h = UA) => { try { const r = await fetch(u, { headers: h, signal: AbortSignal.timeout(90000) }); if (!r.ok) return { error: r.status }; return await r.json(); } catch (e) { return { error: e.message }; } };
const L = []; const say = s => { L.push(s); console.log(s); };
const save = (f, d) => fs.writeFileSync('out/' + f, JSON.stringify(d));
const cnt = (arr, f) => { const o = {}; for (const x of arr) { const k = f(x); if (k != null) o[k] = (o[k] || 0) + 1; } return Object.entries(o).sort((a, b) => b[1] - a[1]); };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const st = await get(P + '/api/status');
  say(`prod ${st.version} ${new Date().toISOString()}`);
  // prod board
  const rows = [];
  for (let off = 0; off < 40000; off += 500) {
    const d = await get(`${P}/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`);
    rows.push(...(d.rows || []));
    if (!d.rows || d.rows.length < 500) { if (d.error) say('board error ' + d.error); break; }
  }
  const mine = rows.filter(r => r.sport === 'NHL' || r.sport === 'SOCCER');
  save('board-nhlsoc.json', mine);
  say(`board rows ${rows.length}, NHL ${mine.filter(r => r.sport === 'NHL').length}, SOCCER ${mine.filter(r => r.sport === 'SOCCER').length}`);
  if (mine[0]) say('sample row keys ' + Object.keys(mine[0]).join(',') + ' | cell keys ' + Object.keys(Object.values(mine[0].books || {})[0] || {}).join(','));
  const legs = mine.flatMap(r => Object.entries(r.books || {}).map(([b, c]) => ({ sp: r.sport, b, m: r.market, mkey: r.mkey, cons: !!r.consensus, pin: !!r.pinnacle, bf: !!r.bookFair, kal: c.fair != null })));
  for (const [k, n] of cnt(legs, x => `${x.sp} ${x.b} ${x.m}`)) if (n >= 3) say(`  ${k}: ${n}`);
  say('consensus/pin/bookFair by sport: ' + JSON.stringify(cnt(legs, x => `${x.sp} cons${+x.cons} pin${+x.pin} bf${+x.bf}`)));
  save('coverage.json', await get(P + '/api/props/coverage'));
  // Pinnacle
  for (const [sp, id] of [['hockey', 19], ['soccer', 29]]) {
    const mu = await get(`${PIN}/sports/${id}/matchups?withSpecials=true`, PINH);
    if (!Array.isArray(mu)) { say(`pin ${sp} error ${JSON.stringify(mu).slice(0, 200)}`); continue; }
    save(`pin-${sp}-matchups.json`, mu.filter(m => m.type === 'special' || /NHL|Premier League|La Liga|Serie A|Bundesliga|Ligue 1|Major League Soccer|Champions/i.test(m.league?.name || '')));
    const sp2 = mu.filter(m => m.type === 'special');
    say(`pin ${sp}: ${mu.length} matchups, specials by league/category: ` + JSON.stringify(cnt(sp2, m => `${m.league?.name}|${m.special?.category}`).slice(0, 30)));
    say(`pin ${sp} special descs (player-ish): ` + JSON.stringify(cnt(sp2.filter(m => !/^(Team|Game) Props$|Futures/.test(m.special?.category || '')), m => String(m.special?.description || '').replace(/^.+?\((.+)\)$/, '$1')).slice(0, 40)));
    say(`pin ${sp} sample descs: ` + JSON.stringify(sp2.filter(m => /NHL|Premier/.test(m.league?.name || '')).slice(0, 25).map(m => `${m.special?.category}::${m.special?.description}`)));
  }
  // Kambi
  for (const path of ['football/england/premier_league', 'football/spain/la_liga', 'football/italy/serie_a', 'football/germany/bundesliga', 'football/usa/mls', 'football/france/ligue_1', 'ice_hockey/nhl']) {
    const lv = await get(`${KB}/listView/${path}/all/matches.json?lang=en_US&market=US`);
    const evs = (lv.events || []).map(x => x.event).filter(e => e && e.state === 'NOT_STARTED');
    say(`kambi ${path}: ${lv.error || ''} ${evs.length} not started: ${evs.slice(0, 4).map(e => `${e.id} ${e.englishName} ${e.start}`).join('; ')}`);
    for (const e of evs.slice(0, 2)) {
      const bo = await get(`${KB}/betoffer/event/${e.id}.json?lang=en_US&market=US&includeParticipants=true`);
      save(`kambi-${path.replace(/\//g, '_')}-${e.id}.json`, bo);
      say(`  ${e.englishName}: ${(bo.betOffers || []).length} offers; labels ` + JSON.stringify(cnt(bo.betOffers || [], b => `${b.criterion?.englishLabel}${b.outcomes?.[0]?.participant ? ' [P]' : ''} {${[...new Set((b.outcomes || []).map(o => o.type))].join('/')}}`).slice(0, 60)));
      await wait(800);
    }
  }
  // FanDuel soccer
  for (const page of ['soccer', 'epl', 'english-premier-league', 'premier-league', 'mls', 'la-liga', 'nhl']) {
    const d = await get(`https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=${page}&pbHorizontal=false&${FDK}&timezone=America%2FNew_York`);
    const evs = Object.values(d?.attachments?.events || {});
    say(`fanduel page ${page}: ${d.error || ''} events ${evs.length} ${evs.slice(0, 3).map(e => `${e.eventId} ${e.name}`).join('; ')}`);
    if (evs.length && page !== 'nhl') {
      const e = evs.find(x => / v /.test(x.name)) || evs[0];
      for (const tab of ['', 'player-props', 'shots', 'goal-scorer', 'player-shots', 'popular']) {
        const ep = await get(`https://sbapi.nj.sportsbook.fanduel.com/api/event-page?${FDK}&eventId=${e.eventId}${tab ? `&tab=${tab}` : ''}`);
        const ms = Object.values(ep?.attachments?.markets || {});
        say(`  fd event ${e.name} tab ${tab || '-'}: ${ep.error || ''} markets ${ms.length} types ${JSON.stringify(cnt(ms, m => `${m.marketType}/${m.bettingType}`).slice(0, 25))}`);
        if (tab === '' && ep.layout) say('  tabs: ' + JSON.stringify((ep.layout?.tabs ? Object.values(ep.layout.tabs) : []).map(t => t.title)));
        if (ms.length) save(`fd-${page}-${tab || 'main'}.json`, ep);
        await wait(500);
      }
      break;
    }
    await wait(500);
  }
  // Kalshi series
  const ser = await get(`${KAL}/series?category=Sports`);
  const list = (ser.series || []).filter(s => /NHL|GOAL|SOT|SHOT|SOCCER|EPL|ASSIST|SAVE|MLS|LALIGA|UCL/i.test(s.ticker));
  say(`kalshi series matching: ${list.length}: ${list.map(s => s.ticker).join(' ')}`);
  for (const s of list.filter(s => /GOAL|PTS|SOG|SHOT|SOT|AST|SAVE/i.test(s.ticker)).slice(0, 40)) {
    const ev = await get(`${KAL}/events?series_ticker=${s.ticker}&status=open&limit=50`);
    say(`  ${s.ticker} (${s.title}): open events ${(ev.events || []).length} ${(ev.events || []).slice(0, 2).map(e => e.event_ticker + ' ' + e.title).join('; ')}`);
    await wait(250);
  }
  // ESPN soccer + NHL boxes
  for (const [lg, d] of [['soccer/eng.1', '20261024'], ['soccer/usa.1', '20261018'], ['hockey/nhl', '20261024']]) {
    const sb = await get(`https://site.api.espn.com/apis/site/v2/sports/${lg}/scoreboard?dates=${d}`);
    const ev = (sb.events || []).find(e => e.status?.type?.completed);
    say(`espn ${lg} ${d}: ${sb.error || ''} events ${(sb.events || []).length}, completed one ${ev?.id} ${ev?.name}`);
    if (!ev) continue;
    const sm = await get(`https://site.api.espn.com/apis/site/v2/sports/${lg}/summary?event=${ev.id}`);
    save(`espn-${lg.replace('/', '_')}-${ev.id}.json`, sm);
    say(`  summary keys ${Object.keys(sm).join(',')}`);
    const ro = sm.rosters?.[0]?.roster?.[0];
    if (ro) say(`  roster[0] stats: ${JSON.stringify((ro.stats || []).map(s => `${s.name}=${s.value ?? s.displayValue}`))}`);
    const bx = sm.boxscore?.players?.[0]?.statistics?.[0];
    if (bx) say(`  boxscore labels: ${JSON.stringify(bx.labels || bx.keys)}`);
  }
  fs.writeFileSync('out/report.txt', L.join('\n'));
})();
