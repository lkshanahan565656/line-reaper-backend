const axios = require('axios');
const { createCsGrader, createLoLesportsGrader } = require('../graders');
const B = 'https://line-reaper-backend-production.up.railway.app';
const http = { get: async (u, o) => { try { const r = await axios.get(u, o); return r; } catch (e) { console.log(' ERR', u.slice(0, 90), e.response?.status); throw e; } } };
(async () => {
  const picks = (await axios.get(B + '/api/tracker/picks')).data.picks;
  const cs = createCsGrader(http, { pause: 100 }), lol = createLoLesportsGrader(http);
  for (const p of picks.filter(p => p.status === 'locked' && p.sport === 'CS' && p.startTime < '2026-10-12T20')) {
    let r; try { r = await cs(p); } catch (e) { r = 'threw ' + e.message; }
    console.log('CS', p.player, '|', p.team, '|', p.matchTitle, p.startTime, p.maps, JSON.stringify(r));
  }
  for (const p of picks.filter(p => p.sport === 'LOL' && p.status === 'review')) {
    let r; try { r = await lol(p); } catch (e) { r = 'threw ' + e.message; }
    console.log('LOL', p.player, p.team, JSON.stringify(r));
  }
})().catch(e => console.log('FATAL', e.message));
