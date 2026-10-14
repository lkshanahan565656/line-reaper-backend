// Dumps BetRivers' and FanDuel's total markets for two NFL games, raw
const fs = require('fs'); const axios = require('axios');
const fb = require('../freebooks');
const H = { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 20000 };
const KAMBI = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const out = { kambi: [], fd: [] };
  try {
    const lv = (await axios.get(`${KAMBI}/listView/${fb.LEAGUES.nfl.kambi}/all/all/matches.json?lang=en_US&market=US`, H)).data;
    const ids = fb.kambiEventIds(lv).slice(0, 3);
    for (const id of ids) {
      const ev = (await axios.get(`${KAMBI}/betoffer/event/${id}.json?lang=en_US&market=US`, H)).data;
      const offers = (ev.betOffers || []).filter(b => /total/i.test(b.criterion?.englishLabel || '') && !/player/i.test(b.criterion?.englishLabel || '')).map(b => ({ label: b.criterion?.englishLabel, crit: b.criterion?.id, betOfferType: b.betOfferType?.englishName, outs: (b.outcomes || []).map(o => [o.type, o.line, o.oddsAmerican, o.participant, o.label, o.status]) }));
      out.kambi.push({ name: ev.events?.[0]?.englishName, offers, parsed: fb.parseKambiEvent ? fb.parseKambiEvent(ev)?.totals : null });
    }
  } catch (e) { out.kambiErr = e.message; }
  try {
    const page = (await axios.get(`https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=${fb.LEAGUES.nfl.fd}&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York`, H)).data;
    const evs = Object.values(page?.attachments?.events || {}).slice(0, 2);
    for (const e of evs) {
      const p = (await axios.get(`https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=FhMFpcPWXMeyZxOx&eventId=${e.eventId}&tab=popular`, H)).data;
      const ms = Object.values(p?.attachments?.markets || {}).filter(m => /TOTAL/i.test(m.marketType || '') && !/PLAYER/.test(m.marketType)).map(m => ({ type: m.marketType, name: m.marketName, runners: (m.runners || []).map(r => [r.runnerName, r.result?.type, r.handicap, r.winRunnerOdds?.americanDisplayOdds?.americanOdds]) }));
      out.fd.push({ name: e.name, ms, alts: fb.parseFanDuelLadders ? fb.parseFanDuelLadders(p).alts.filter(a => a.kind === 'totals') : null });
    }
  } catch (e) { out.fdErr = e.message; }
  fs.writeFileSync('out/probe.json', JSON.stringify(out, null, 1));
})();
