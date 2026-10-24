import json,urllib.request,gzip,os,datetime,time,concurrent.futures as cf
def get(u,t=40):
    err=None
    for i in range(4):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read()
        except Exception as e: err=e; time.sleep(2+3*i)
    print('ERR',u,err,flush=True); return None
L={'NBA':'basketball/nba','NFL':'football/nfl','CFB':'football/college-football','NHL':'hockey/nhl','MLB':'baseball/mlb','WNBA':'basketball/wnba'}
D=datetime.date
R={'NFL':[(D(2026,9,9),D(2026,10,24))],'CFB':[(D(2026,8,27),D(2026,10,24))],
   'NHL':[(D(2026,3,1),D(2026,4,18)),(D(2026,10,6),D(2026,10,24))],
   'NBA':[(D(2026,1,10),D(2026,4,14)),(D(2026,10,20),D(2026,10,24))],
   'WNBA':[(D(2026,7,15),D(2026,10,24))],'MLB':[(D(2026,9,1),D(2026,10,24))]}
os.makedirs('out/box',exist_ok=True)
jobs=[]
for s,rs in R.items():
  for a,b in rs:
    d=a
    while d<=b: jobs.append((s,d.strftime('%Y%m%d'))); d+=datetime.timedelta(days=1)
def sb(j):
    s,ds=j
    u=f"https://site.api.espn.com/apis/site/v2/sports/{L[s]}/scoreboard?dates={ds}&limit=400"+('&groups=80' if s=='CFB' else '')
    d=get(u); out=[]
    if not d: return out
    for e in json.loads(d).get('events',[]):
        c=e['competitions'][0]
        out.append(dict(sport=s,id=e['id'],date=e['date'],done=c['status']['type'].get('completed'),teams=[dict(abbr=t['team'].get('abbreviation'),name=t['team'].get('displayName'),short=t['team'].get('shortDisplayName'),loc=t['team'].get('location'),ha=t.get('homeAway'),score=t.get('score')) for t in c['competitors']]))
    return out
idx=[]
with cf.ThreadPoolExecutor(6) as ex:
    for r in ex.map(sb,jobs): idx+=r
seen=set(); idx=[e for e in idx if not ((e['sport'],e['id']) in seen or seen.add((e['sport'],e['id'])))]
json.dump(idx,open('out/events.json','w')); print('events',len(idx),flush=True)
def bx(e):
    f=f"out/box/{e['sport']}-{e['id']}.json.gz"
    if not e['done'] or os.path.exists(f): return 0
    d=get(f"https://site.api.espn.com/apis/site/v2/sports/{L[e['sport']]}/summary?event={e['id']}")
    if not d: return 0
    j=json.loads(d); slim={'boxscore':{'players':j.get('boxscore',{}).get('players',[])},'header':{'id':j.get('header',{}).get('id')}}
    open(f,'wb').write(gzip.compress(json.dumps(slim).encode())); return 1
with cf.ThreadPoolExecutor(8) as ex: n=sum(ex.map(bx,idx))
print('boxes',n)
