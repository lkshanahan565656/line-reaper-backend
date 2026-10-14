(async () => {
  const U = 'https://line-reaper-backend-production.up.railway.app';
  for (let i = 0; i < 12; i++) {
    const s = await fetch(`${U}/api/status`).then(r => r.json()).catch(e => ({ error: e.message }));
    console.log(new Date().toISOString(), s.version, JSON.stringify(s.freeBooks));
    if (s.freeBooks?.updated) {
      const ev = await fetch(`${U}/api/ev?limit=1000`).then(r => r.json()).catch(e => ({ error: e.message }));
      const lines = (ev.rows || []).filter(r => !r.dfs);
      const by = {}; for (const r of lines) by[r.book] = (by[r.book] || 0) + 1;
      console.log('ev rows', ev.count, 'game lines by book', JSON.stringify(by), 'feeds', JSON.stringify(ev.feeds));
      console.log(JSON.stringify(await fetch(`${U}/api/ev/record`).then(r => r.json()).catch(e => ({ error: e.message }))).slice(0, 600));
      break;
    }
    await new Promise(r => setTimeout(r, 60e3));
  }
})();
