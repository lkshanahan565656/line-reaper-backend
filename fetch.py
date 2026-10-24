import json,urllib.request,urllib.parse,gzip,os,datetime,time
B='https://line-reaper-backend-production.up.railway.app'
def get(u,t=120):
    for i in range(3):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read()
        except Exception as e: err=e; time.sleep(3)
    print('ERR',u,err); return None
os.makedirs('out/rec',exist_ok=True); os.makedirs('out/box',exist_ok=True)
KINDS=['sharp','p6-sharp','sharp3','p6-sharp3','ev','p6-ev','gap','p6-gap','gap-odd','gap-stale','stale','stale-single','book-fair-single','p6-book-fair-single','book-fair','book-consensus','p6-book-consensus']
for k in KINDS:
  for st in ('graded','locked'):
    allp=[];before=None
    while True:
        u=f"{B}/api/props/record/picks?status={st}&kind={k}&limit=1000"+(f"&before={urllib.parse.quote(before)}" if before else '')
        d=get(u,300)
        if not d: break
        p=json.loads(d).get('picks',[])
        allp+=p
        if len(p)<1000: break
        before=p[-1]['signalAt']
    open(f'out/rec/{k}-{st}.json','w').write(json.dumps(allp)); print(k,st,len(allp))
L={'NBA':'basketball/nba','NFL':'football/nfl','CFB':'football/college-football','NHL':'hockey/nhl','MLB':'baseball/mlb','WNBA':'basketball/wnba'}
idx=[]
d0=datetime.date(2026,10,13)
while d0<=datetime.date(2026,10,24):
    ds=d0.strftime('%Y%m%d')
    for s,p in L.items():
        u=f"https://site.api.espn.com/apis/site/v2/sports/{p}/scoreboard?dates={ds}&limit=400"+('&groups=80' if s=='CFB' else '')
        d=get(u)
        if not d: continue
        for e in json.loads(d).get('events',[]):
            c=e['competitions'][0]
            idx.append(dict(sport=s,id=e['id'],date=e['date'],name=e.get('name'),short=e.get('shortName'),done=c['status']['type'].get('completed'),teams=[dict(abbr=t['team'].get('abbreviation'),name=t['team'].get('displayName'),short=t['team'].get('shortDisplayName'),loc=t['team'].get('location'),ha=t.get('homeAway')) for t in c['competitors']]))
    d0+=datetime.timedelta(days=1)
json.dump(idx,open('out/events.json','w')); print('events',len(idx))
n=0
for e in idx:
    if not e['done']: continue
    f=f"out/box/{e['sport']}-{e['id']}.json.gz"
    d=get(f"https://site.api.espn.com/apis/site/v2/sports/{L[e['sport']]}/summary?event={e['id']}")
    if d:
        j=json.loads(d); slim={'boxscore':{'players':j.get('boxscore',{}).get('players',[])},'header':{'id':j.get('header',{}).get('id')}}
        open(f,'wb').write(gzip.compress(json.dumps(slim).encode())); n+=1
print('boxes',n)
