// ESPN college football: how many games a Saturday board lists with and without groups=80
(async () => {
  const E = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
  for (const q of ['dates=20261024', 'dates=20261024&groups=80', 'dates=20261024&groups=80&limit=300', 'dates=20261024&limit=300']) {
    const j = await (await fetch(`${E}?${q}`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
    const ids = (j.events || []).map(e => e.id);
    console.log(q, ids.length);
    if (q === 'dates=20261024') global.a = new Set(ids);
    if (q === 'dates=20261024&groups=80&limit=300') console.log('in default but not groups=80:', [...global.a].filter(x => !ids.includes(x)).length);
  }
})();
