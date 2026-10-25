import json,urllib.request,gzip,os,time
os.makedirs('out/box',exist_ok=True)
def get(u):
  for i in range(4):
    try:
      return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=40).read()
    except Exception as e: print('ERR',u,e); time.sleep(3)
ev=[]
for d in ['20261024','20261025']:
  for lg in ['nba','wnba']:
    b=get(f'https://site.api.espn.com/apis/site/v2/sports/basketball/{lg}/scoreboard?dates={d}')
    if not b: continue
    for e in json.loads(b).get('events',[]): ev.append((lg,e['id'],e['date'],e['name'],e['status']['type']['name']))
json.dump(ev,open('out/events.json','w'),indent=0); print(ev)
for lg,i,*_ in ev:
  b=get(f'https://site.api.espn.com/apis/site/v2/sports/basketball/{lg}/summary?event={i}')
  if b: open(f'out/box/{lg}-{i}.json.gz','wb').write(gzip.compress(b))
P='https://line-reaper-backend-production.up.railway.app'
for name,u in [('record','/api/props/record'),('combo','/api/props/record/picks?kind=combo&status=graded&limit=1000'),('p6combo','/api/props/record/picks?kind=p6-combo&status=graded&limit=1000'),('combo_locked','/api/props/record/picks?kind=combo&status=locked&limit=1000'),('p6combo_locked','/api/props/record/picks?kind=p6-combo&status=locked&limit=1000'),('health','/api/health')]:
  b=get(P+u)
  if b: open(f'out/{name}.json','wb').write(b)
