import json, time, urllib.request
B='https://line-reaper-backend-production.up.railway.app'
def get(p, raw=False):
    r=urllib.request.urlopen(urllib.request.Request(B+p,headers={'User-Agent':'diag'}),timeout=60)
    b=r.read(); return (r.status, b) if raw else (r.status, json.loads(b))
t0=time.time(); v=None
while time.time()-t0<1800:
    try:
        s,j=get('/'); v=j.get('version'); print(round(time.time()-t0),'version',v,flush=True)
        if v=='3.168.0': break
    except Exception as e: print(round(time.time()-t0),'err',e,flush=True)
    time.sleep(30)
time.sleep(150)  # boot refresh at 120 s
for p in ['/api/health','/api/props/nbamodel']:
    try:
        s,j=get(p); print(p,s); json.dump(j,open(p.strip('/').replace('/','_')+'.json','w'))
        if 'nbamodel' in p:
            print({k:j.get(k) for k in ['on','label','status','pickMin','bar','record','count']})
            print('backtest', json.dumps(j.get('backtest'))[:600])
            for r in (j.get('rows') or [])[:5]: print(json.dumps(r)[:400])
    except Exception as e: print(p,'err',e)
for p in ['/app','/api/props/board?sport=NBA']:
    try: s,b=get(p,True); print(p,s,len(b), (b'NBA MODEL' in b) if p=='/app' else '')
    except Exception as e: print(p,'err',e)
