import json,urllib.request,collections
B='https://line-reaper-backend-production.up.railway.app'
def get(p,t=120):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(B+p,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read())
    except Exception as e: return {'error':str(e)}
b=get('/api/props/board?sport=CFB&limit=500')
rows=b.get('rows',[]); print('CFB board rows',b.get('total'), collections.Counter(r.get('startTime','')[:10] for r in rows), collections.Counter(r.get('mkey') for r in rows).most_common(8))
for r in rows[:8]: print(r.get('player'),r.get('team'),r.get('mkey'),r.get('startTime'),list((r.get('books') or {}).keys()))
d=get('/api/props/cfbmodel?limit=5'); print('cfbmodel',d.get('count'),d.get('status'))
full=[r for r in rows if not str(r.get('mkey','')).startswith(('1h|','2h|','1q|'))]; print('full-game CFB rows',len(full))
print('cfbmodel rows sample',[(x.get('player'),x.get('stat'),x.get('line')) for x in (d.get('rows') or [])[:5]])
rec=get('/api/props/record'); bk=rec.get('byKind') or {}
print('record kinds',{k:bk.get(k) for k in ('cfb-model','p6-cfb-model','ud-cfb-model')})
v=get('/api/health'); print('version',v.get('version'))
