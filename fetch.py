import json,urllib.request,urllib.parse,gzip,os,time
B='https://line-reaper-backend-production.up.railway.app'
def get(u,t=300):
    err=None
    for i in range(3):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read()
        except Exception as e: err=e; time.sleep(5)
    print('ERR',u,err,flush=True); return None
os.makedirs('out/rec',exist_ok=True)
s=get(B+'/api/props/record'); summ=json.loads(s) if s else {}
open('out/summary.json','w').write(json.dumps(summ))
kinds=sorted(set(list((summ.get('byKind') or {}).keys())+['sharp','p6-sharp','sharp3','p6-sharp3','ev','p6-ev','gap','p6-gap','gap-odd','gap-stale','stale','stale-single','p6-stale','p6-stale-single','book-fair-single','p6-book-fair-single','book-fair','book-consensus','p6-book-consensus','combo','p6-combo']))
cut=1792454400000  # 2026-10-19T00:00Z
for k in kinds:
  allp=[];before=None
  while True:
    u=f"{B}/api/props/record/picks?kind={urllib.parse.quote(k)}&limit=1000"+(f"&before={urllib.parse.quote(before)}" if before else '')
    d=get(u)
    if not d: break
    p=json.loads(d).get('picks',[])
    allp+=p
    if len(p)<1000: break
    before=p[-1]['signalAt']
    if any(x.get('start') and str(x.get('start'))<'2026-10-19' for x in p): break
  nba=[x for x in allp if x.get('sport')=='NBA']
  open(f'out/rec/{k}.json','w').write(json.dumps(nba)); print(k,len(allp),'nba',len(nba),flush=True)
b=get(B+'/api/props/board?sport=NBA&limit=5000')
if b: open('out/board-nba.json.gz','wb').write(gzip.compress(b))
print('board',len(b or b''))
