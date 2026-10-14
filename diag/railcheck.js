(async () => {
  const U = 'https://line-reaper-backend-production.up.railway.app';
  for (let i = 0; i < 25; i++) {
    const s = await fetch(`${U}/api/status`).then(r => r.json()).catch(e => ({ error: e.message }));
    const props = Object.fromEntries(Object.entries(s.freeBooks?.counts || {}).map(([k, v]) => [k, v.props]));
    console.log(new Date().toISOString(), s.version, JSON.stringify(props), JSON.stringify(s.freeBooks?.errors));
    if (Object.values(props).some(p => p && (p.matched?.fanduel || p.matched?.betrivers))) {
      const ev = await fetch(`${U}/api/ev?limit=1000&props=1`).then(r => r.json()).catch(e => ({ error: e.message }));
      const by = {}; for (const r of ev.rows || []) by[r.book] = (by[r.book] || 0) + 1;
      console.log('prop rows', ev.count, JSON.stringify(by));
      console.log((ev.rows || []).filter(r => /fanduel|betrivers/.test(r.book)).slice(0, 10).map(r => [r.book, r.player, r.market, r.side, r.point, r.price, r.ev].join(' ')).join('\n'));
      console.log(JSON.stringify(await fetch(`${U}/api/ev/record`).then(r => r.json()).catch(e => ({ error: e.message }))).slice(0, 3000));
      break;
    }
    await new Promise(r => setTimeout(r, 60e3));
  }
})();
