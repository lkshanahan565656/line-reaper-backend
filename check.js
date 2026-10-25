const B='https://line-reaper-backend-production.up.railway.app';
const j=async(p,o)=>{const r=await fetch(B+p,o);return {s:r.status,b:await r.text()}};
(async()=>{
  for(let i=0;i<60;i++){try{const s=JSON.parse((await j('/api/status')).b);if(s.version==='3.163.0'){console.log('version',s.version,'lineBets',JSON.stringify(s.lineBets));break}console.log('waiting',s.version)}catch(e){console.log('err',e.message)}await new Promise(r=>setTimeout(r,30000))}
  await new Promise(r=>setTimeout(r,90000));
  const os=JSON.parse((await j('/api/odds-screen')).b);
  console.log('games',os.games.length);
  const g=os.games.find(x=>new Date(x.start)>Date.now()+3600e3&&x.markets.some(m=>m.key==='spread'));
  if(g){const m=g.markets.find(m=>m.key==='spread');const s=m.sides[1];
    const body={bets:[{id:'diagtest1',track:{kind:'line',game:g.id,league:g.league,market:'spread',side:s.name,point:m.point}}]};
    console.log('game',g.away,'@',g.home,g.league,s.label,'venues',s.venues.map(v=>v.venue+' '+v.american).join(', '));
    const r=await j('/api/bets/settle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});console.log('settle',r.s,r.b.slice(0,600));}
  const st=JSON.parse((await j('/api/status')).b);console.log('lineBets after',JSON.stringify(st.lineBets));
  const sl=(await j('/slips.js')).b, bt=(await j('/bets.js')).b, app=(await j('/app')).b;
  console.log('slips.js repriced',sl.includes('function repriced'),'settleSlip',sl.includes('function settleSlip'),'closing_line',sl.includes('closing[ _]?'));
  console.log('bets.js fromLine',bt.includes('function fromLine'));
  console.log('app osLog',app.includes('function osLog'),'pkTray',app.includes('id="pkTray"'),'msSlipTot',app.includes('msSlipTot'));
})();
