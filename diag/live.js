const fs=require('fs');const B='https://line-reaper-backend-production.up.railway.app';
(async()=>{const out={};for(let i=0;i<20;i++){try{const s=await (await fetch(B+'/api/status')).json();out.status={version:s.version,pick6:s.pick6};if(s.version==='3.130.0')break;}catch(e){out.err=String(e)}await new Promise(r=>setTimeout(r,30000));}
try{const p=await (await fetch(B+'/api/props/board')).json();out.board={counts:p.counts,books:p.counts?.books};}catch(e){out.boardErr=String(e)}
try{const r=await fetch(B+'/');out.root=await r.json();}catch(e){out.rootErr=String(e)}
fs.writeFileSync('out/live.json',JSON.stringify(out,null,1));console.log(JSON.stringify(out).slice(0,2000));})();
