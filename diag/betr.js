const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const out = {};
const H = { 'content-type': 'application/json', accept: '*/*', origin: 'https://picks.betr.app', referer: 'https://picks.betr.app/', 'user-agent': UA };
async function gql(name, query, variables, extra = {}) {
  try {
    const r = await fetch('https://api.fantasy.betr.app/graphql', { method: 'POST', headers: { ...H, ...extra }, body: JSON.stringify({ operationName: name, query, variables }), signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    return { status: r.status, len: t.length, headers: Object.fromEntries([...r.headers].filter(([k]) => /rate|retry|limit|cf-|server/.test(k))), body: t.slice(0, 400000) };
  } catch (e) { return { error: e.message }; }
}
(async () => {
  const b = await (await fetch('https://picks.betr.app/betr-app.bundle.js', { headers: { 'user-agent': UA } })).text();
  const ctx = (pat, n = 4, w = 600) => [...b.matchAll(new RegExp(pat, 'g'))].slice(0, n).map(m => b.slice(Math.max(0, m.index - w), m.index + w));
  out.ctx = { headers: ctx('fantasy\\.betr\\.app/graphql', 3, 800), auth: ctx('[Aa]uthorization', 8, 300), anon: ctx('anonymous|Anonymous', 6, 300), league: ctx('CS2|COUNTER_STRIKE|LEAGUE_OF_LEGENDS', 6, 400) };
  out.all = await gql('AllLeaguesUpcomingEvents', 'query AllLeaguesUpcomingEvents { getUpcomingEventsV2 { id league status } }', {});
  out.allNoOrigin = await gql('AllLeaguesUpcomingEvents', 'query AllLeaguesUpcomingEvents { getUpcomingEventsV2 { id league status } }', {}, { origin: '', referer: '' });
  fs.writeFileSync('out/betr.json', JSON.stringify(out, null, 1));
  let leagues = [];
  try { leagues = [...new Set(JSON.parse(out.all.body).data.getUpcomingEventsV2.map(e => e.league))]; } catch {}
  const Q = `query LeagueUpcomingEvents($league: League!) { getUpcomingEventsV2(league: $league) { id date status sport league competitionType name
    ... on TeamVersusEvent { teams { id name league players { id firstName lastName position attributes { key value } projections { marketId marketStatus isLive type label name key order value nonRegularPercentage nonRegularValue allowedOptions { marketOptionId outcome } } } } }
    ... on TeamTournamentEvent { teams { id name players { id firstName lastName projections { marketId marketStatus type label name key value nonRegularPercentage nonRegularValue allowedOptions { outcome } } } } }
    ... on IndividualVersusEvent { players { id firstName lastName projections { marketId marketStatus type label name key value nonRegularPercentage nonRegularValue allowedOptions { outcome } } } }
    ... on IndividualTournamentEvent { players { id firstName lastName projections { marketId marketStatus type label name key value nonRegularPercentage nonRegularValue allowedOptions { outcome } } } } } }`;
  out.leagues = {};
  for (const lg of (leagues.length ? leagues : ['NFL', 'MLB', 'NBA', 'CS2', 'LOL'])) {
    out.leagues[lg] = await gql('LeagueUpcomingEvents', Q, { league: lg });
    fs.writeFileSync('out/betr.json', JSON.stringify(out, null, 1));
  }
})();
