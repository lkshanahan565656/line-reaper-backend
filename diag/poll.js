// Polls FanDuel's Odds Boosts page (several states) and BetRivers' House Specials,
// plus league pages for boosted runners (previousWinRunnerOdds / Kambi prevOdds).
// Pushes out/ to diag-boosts-out after each cycle.
const fs = require('fs');
const { execSync } = require('child_process');
const AK = 'FhMFpcPWXMeyZxOx';
const H = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', accept: 'application/json' };
const K = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
const fd = st => `https://sbapi.${st}.sportsbook.fanduel.com/api`;
const STATES = ['nj', 'pa', 'ny', 'il', 'az', 'mi'];
const LEAGUES = ['nfl', 'ncaaf', 'nba', 'nhl', 'mlb'];
const KL = ['american_football/nfl', 'american_football/ncaaf', 'basketball/nba', 'ice_hockey/nhl', 'baseball/mlb'];
const get = async url => { const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(25000) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync('out/snaps', { recursive: true });
const log = [];
function push() {
  fs.writeFileSync('out/log.json', JSON.stringify(log, null, 1));
  try {
    execSync('rm -rf /tmp/pub && mkdir -p /tmp/pub && cp -r out /tmp/pub/ && cd /tmp/pub && git init -q -b diag-boosts-out && git add -A && git -c user.name=diag-bot -c user.email=d@x commit -qm out && git push -qf "$(cd $GITHUB_WORKSPACE && git config --get remote.origin.url)" diag-boosts-out', { stdio: 'inherit', shell: '/bin/bash', env: { ...process.env } });
  } catch (e) { console.log('push failed', e.message); }
}
(async () => {
  const end = Date.now() + 5.3 * 3600e3;
  for (let cycle = 0; Date.now() < end; cycle++) {
    const t = new Date().toISOString(), rec = { t, fdPages: {}, fdEvents: {}, fdLeagueBoosted: {}, kHouse: null, kPrev: {} };
    for (const st of STATES) {
      try {
        const { status, json } = await get(`${fd(st)}/content-managed-page?page=CUSTOM&customPageId=oddsboosts&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`);
        const ms = Object.values(json?.attachments?.markets || {});
        const evIds = [...new Set(Object.values(json?.layout?.coupons || {}).map(c => c.eventId))];
        rec.fdPages[st] = { status, markets: ms.length, evIds };
        if (ms.length) fs.writeFileSync(`out/snaps/fd_page_${st}_${cycle}.json`, JSON.stringify(json));
        if (st === 'nj' || st === 'ny' || st === 'pa') for (const id of evIds) {
          if (rec.fdEvents[id]) continue;
          const r = await get(`${fd(st)}/event-page?_ak=${AK}&eventId=${id}`);
          const n = Object.keys(r.json?.attachments?.markets || {}).length;
          rec.fdEvents[id] = n;
          if (n) fs.writeFileSync(`out/snaps/fd_ev_${st}_${id}_${cycle}.json`, JSON.stringify(r.json));
          await sleep(400);
        }
      } catch (e) { rec.fdPages[st] = { error: String(e) }; }
      await sleep(500);
    }
    if (cycle % 3 === 0) for (const lg of LEAGUES) {
      try {
        const { json } = await get(`${fd('nj')}/content-managed-page?page=CUSTOM&customPageId=${lg}&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`);
        const ms = Object.values(json?.attachments?.markets || {});
        const hits = ms.filter(m => (m.runners || []).some(r => (r.previousWinRunnerOdds || []).length) || /BOOST/.test(m.marketType || ''));
        rec.fdLeagueBoosted[lg] = hits.length;
        if (hits.length) fs.writeFileSync(`out/snaps/fd_league_${lg}_${cycle}.json`, JSON.stringify({ hits, events: json.attachments.events }));
      } catch (e) { rec.fdLeagueBoosted[lg] = String(e); }
      await sleep(500);
    }
    try {
      const { json } = await get(`${K}/listView/sugar_house_specials/all/all/all/competitions.json?lang=en_US&market=US`);
      const ids = (json?.events || []).map(e => e.event.id);
      rec.kHouse = { events: ids.length, offers: 0 };
      for (const id of ids) {
        const r = await get(`${K}/betoffer/event/${id}.json?lang=en_US&market=US`);
        rec.kHouse.offers += (r.json?.betOffers || []).length;
        fs.writeFileSync(`out/snaps/k_house_${id}_${cycle}.json`, JSON.stringify(r.json));
        await sleep(300);
      }
    } catch (e) { rec.kHouse = String(e); }
    if (cycle % 3 === 0) for (const p of KL) {
      try {
        const { json } = await get(`${K}/listView/${p}/all/all/matches.json?lang=en_US&market=US`);
        const ids = (json?.events || []).filter(e => e.event.state === 'NOT_STARTED').map(e => e.event.id).slice(0, 12);
        let n = 0;
        for (const id of ids) {
          const r = await get(`${K}/betoffer/event/${id}.json?lang=en_US&market=US`);
          const hit = (r.json?.betOffers || []).filter(b => (b.outcomes || []).some(o => (o.prevOdds || []).length) || (b.tags || []).some(x => /BOOST|ENHANC/i.test(x)));
          n += hit.length;
          if (hit.length) fs.writeFileSync(`out/snaps/k_prev_${id}_${cycle}.json`, JSON.stringify({ hit, event: r.json.events }));
          await sleep(300);
        }
        rec.kPrev[p] = n;
      } catch (e) { rec.kPrev[p] = String(e); }
    }
    log.push(rec);
    push();
    await sleep(15 * 60e3);
  }
})();
