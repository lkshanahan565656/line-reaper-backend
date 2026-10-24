import json, urllib.request, time, collections
B='https://line-reaper-backend-production.up.railway.app'
def get(u):
    try:
        with urllib.request.urlopen(urllib.request.Request(B+u, headers={'User-Agent':'diag'}), timeout=120) as r: return json.loads(r.read())
    except Exception as e: return {'error': str(e)}
t0=time.time(); v=None
while time.time()-t0<1800:
    v=get('/api/status').get('version'); print(time.strftime('%H:%M:%S'), v, flush=True)
    if v=='3.152.0': break
    time.sleep(60)
time.sleep(300)  # let the board fill (Pick6 relay, FanDuel props)
st=get('/api/status'); print('version', st.get('version'))
p6=st.get('pick6') or {}
print('pick6 status', json.dumps({k:p6.get(k) for k in ('lines','relay','bySport','payouts')})[:1500])
rows=[]
for off in range(0,40000,500):
    d=get(f'/api/props/board?sport=SPORTS&sort=start&limit=500&offset={off}'); r=d.get('rows') or []; rows+=r
    if len(r)<500: break
print('board rows', len(rows), 'counts', json.dumps(d.get('counts')))
m=collections.Counter((r['sport'],r['mkey']) for r in rows if 'pick6' in (r.get('books') or {}))
print('pick6 cells by stat', m.most_common(30))
cb=collections.Counter(r['mkey'] for r in rows if r.get('mkey') in ('pts_rebs','pts_asts','rebs_asts','pra','stocks') and r['sport']=='NBA')
print('NBA combo rows', cb)
print('combo chips (pro-redacted rows show locked)', sum(1 for r in rows if r.get('combo')))
rec=get('/api/props/record'); print('record combo', rec.get('byKind',{}).get('combo'), 'p6-combo', rec.get('byKind',{}).get('p6-combo'))
