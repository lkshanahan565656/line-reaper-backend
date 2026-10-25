const fs=require('fs');const out=[];const P=(...a)=>{const s=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ');console.log(s);out.push(s);};
const H={'User-Agent':'Mozilla/5.0'};
(async()=>{
 const id='117133816701918803';
 const r0=await fetch(`https://feed.lolesports.com/livestats/v1/window/${id}`,{headers:H});const j0=await r0.json();const fr=j0.frames||[];P('nostart',r0.status,fr.length,fr[0]?.rfc460Timestamp,fr.slice(-1)[0]?.rfc460Timestamp,fr.slice(-1)[0]?.gameState);
 const end=Date.parse(fr.slice(-1)[0].rfc460Timestamp);
 for(const back of [5,15,25,35,45,60,90]){const st=new Date(Math.floor((end-back*60e3)/10e3)*10e3).toISOString();const r=await fetch(`https://feed.lolesports.com/livestats/v1/window/${id}?startingTime=${st}`,{headers:H});const b=await r.text();let n=0,f0='',fl='';try{const j=JSON.parse(b);n=(j.frames||[]).length;f0=j.frames?.[0]?.rfc460Timestamp;fl=j.frames?.slice(-1)[0]?.rfc460Timestamp}catch{}P('back',back,st,r.status,b.length,n,f0,fl);}
 const d=await fetch(`https://feed.lolesports.com/livestats/v1/details/${id}`,{headers:H});const db=await d.text();P('details',d.status,db.slice(0,300));
 fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/probe.txt',out.join('\n'));
})();
