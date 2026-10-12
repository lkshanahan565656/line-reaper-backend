const axios = require('axios');
const B = 'https://line-reaper-backend-production.up.railway.app';
(async () => {
  const st = await axios.get(B + '/api/status');
  console.log('date', st.headers.date, 'version', st.data.version, 'tracker', JSON.stringify(st.data.tracker), 'kalshiProps', JSON.stringify(st.data.kalshiProps));
  const picks = (await axios.get(B + '/api/tracker/picks')).data.picks;
  console.log(JSON.stringify(picks.reduce((a, p) => (a[p.status + ':' + p.sport] = (a[p.status + ':' + p.sport] || 0) + 1, a), {})));
  for (const p of picks.filter(p => p.gradedAt && p.gradedAt > '2026-10-12T22:3')) console.log(p.status, p.sport, p.player, p.stat, p.signalSide, p.signalLine, p.result, p.outcome, p.note);
  const s = (await axios.get(B + '/api/tracker/summary')).data;
  console.log('overall', JSON.stringify(s.overall), 'bySport', JSON.stringify(Object.fromEntries(Object.entries(s.bySport).map(([k, v]) => [k, [v.wins, v.losses, v.units]]))));
})().catch(e => console.log('FATAL', e.message));
