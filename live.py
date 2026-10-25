import json,urllib.request,time,os
B='https://line-reaper-backend-production.up.railway.app'
def get(p,t=120):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(B+p,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read())
    except Exception as e: return {'error':str(e)}
t0=time.time(); v=None
while time.time()-t0<40*60:
    s=get('/api/status'); v=s.get('version'); print(int(time.time()-t0),'version',v,flush=True)
    if v=='3.169.0': break
    time.sleep(60)
up=time.time()
os.makedirs('out',exist_ok=True)
for i in range(3):
    time.sleep(240 if i==0 else 120)
    d=get('/api/props/cfbmodel?limit=50')
    print('cfbmodel', int(time.time()-up), json.dumps({k:d.get(k) for k in ('on','label','status','count','record')})[:1500], flush=True)
    json.dump(d,open(f'out/cfbmodel-{i}.json','w'))
r=get('/api/props/record'); print('record kinds', {k:v for k,v in (r.get('byKind') or {}).items() if 'model' in k}, flush=True)
n=get('/api/props/nbamodel?limit=5'); print('nbamodel', n.get('on'), n.get('count'), flush=True)
print('health', get('/api/health'), flush=True)
