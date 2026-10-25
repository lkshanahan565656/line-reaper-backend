import json,urllib.request,collections
B='https://line-reaper-backend-production.up.railway.app'
def get(p,t=120):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(B+p,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read())
    except Exception as e: return {'error':str(e)}
b=get('/api/props/board?sport=CFB&limit=500')
rows=b.get('rows',[]); print('CFB board rows',b.get('total'), collections.Counter(r.get('startTime','')[:10] for r in rows), collections.Counter(r.get('mkey') for r in rows).most_common(8))
for r in rows[:8]: print(r.get('player'),r.get('team'),r.get('mkey'),r.get('startTime'),list((r.get('books') or {}).keys()))
d=get('/api/props/cfbmodel?limit=5'); print('cfbmodel',d.get('count'),d.get('status'))
