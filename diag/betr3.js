const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const base = { 'content-type': 'application/json', accept: '*/*', origin: 'https://picks.betr.app', referer: 'https://picks.betr.app/', 'user-agent': UA };
const Q = 'query AllLeaguesUpcomingEvents { getUpcomingEventsV2 { id league status } }';
const out = {};
async function post(label, headers, body) {
  try {
    const r = await fetch('https://api.fantasy.betr.app/graphql', { method: 'POST', headers: { ...base, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    out[label] = { status: r.status, len: t.length, body: t.slice(0, 300000) };
  } catch (e) { out[label] = { error: e.message }; }
  fs.writeFileSync('out/betr3.json', JSON.stringify(out, null, 1));
}
(async () => {
  const b = await (await fetch('https://picks.betr.app/betr-app.bundle.js', { headers: { 'user-agent': UA } })).text();
  const ctx = (pat, n, w) => [...b.matchAll(new RegExp(pat, 'g'))].slice(0, n).map(m => b.slice(Math.max(0, m.index - w), m.index + w));
  out.ctx = { channel: ctx('getChannel=', 3, 400), appver: ctx('getAppVersion=', 3, 400), league: ctx('t\\.League=|League=\\{', 3, 1500) };
  const V = { 'Fantasy-Api-Version': '16.0', 'Promotions-Api-Version': '6.0' };
  await post('v_noauth', V, { operationName: 'AllLeaguesUpcomingEvents', query: Q, variables: {} });
  await post('v_emptyauth', { ...V, Authorization: '', Channel: 'WEB', Jurisdiction: 'FANTASY' }, { operationName: 'AllLeaguesUpcomingEvents', query: Q, variables: {} });
  await post('v_web_lower', { ...V, Channel: 'web', Jurisdiction: 'FANTASY' }, { operationName: 'AllLeaguesUpcomingEvents', query: Q, variables: {} });
  await post('v_app', { ...V, 'Fantasy-Application-Version': '1.0.0', Channel: 'WEB', Jurisdiction: 'FANTASY' }, { operationName: 'AllLeaguesUpcomingEvents', query: Q, variables: {} });
})();
