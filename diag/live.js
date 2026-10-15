const fs=require('fs');const B='https://line-reaper-backend-production.up.railway.app';
const j=async p=>{try{const r=await fetch(B+p);return {code:r.status,body:await r.json()}}catch(e){return {err:String(e)}}};
(async()=>{const out={};const t0=Date.now();
while(Date.now()-t0<14*60e3){const s=await j('/api/status');out.status={version:s.body?.version,pick6:s.body?.pick6};if(s.body?.version==='3.138.0'&&(s.body?.pick6?.lines||0)>0){await new Promise(r=>setTimeout(r,240000));break;}await new Promise(r=>setTimeout(r,45000));}
const b=await j('/api/props/board');const rows=b.body?.rows||[];
const p6=rows.filter(r=>r.books?.pick6);const pr=p6.filter(r=>r.books.pick6.ev);out.p6sample=p6.slice(0,3).map(r=>({p:r.player,s:r.sport,m:r.market,c:r.books.pick6}));
out.board={code:b.code,counts:b.body?.counts,pick6Rows:p6.length,pick6Priced:pr.length,pick6Clears:pr.filter(r=>r.books.pick6.ev.clears).length,bestPick6:rows.filter(r=>r.best?.book==='pick6').length,bySport:{},sample:pr.filter(r=>r.books.pick6.ev.clears).slice(0,6).map(r=>({p:r.player,s:r.sport,m:r.market,l:r.books.pick6.line,ev:r.books.pick6.ev}))};
for(const r of p6){const o=out.board.bySport[r.sport]||={lines:0,priced:0,clears:0};o.lines++;if(r.books.pick6.ev){o.priced++;if(r.books.pick6.ev.clears)o.clears++;}}
out.boardKeys=Object.keys(b.body||{});
const a=await j('/api/esports/auto-slips');out.autoSlips={code:a.code,keys:Object.keys(a.body||{}),books:(a.body?.slips||[]).map(s=>s.book),pick6:(a.body?.slips||[]).filter(s=>/pick6/i.test(JSON.stringify(s).slice(0,400))).slice(0,2)};
const rec=await j('/api/props/record');const rs=JSON.stringify(rec.body||{});out.record={code:rec.code,p6mentions:(rs.match(/p6[-a-z]*/g)||[]).slice(0,20),snippet:rs.slice(0,1500)};
fs.writeFileSync('out/live.json',JSON.stringify(out,null,1));console.log('done');})();
