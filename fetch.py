import json,urllib.request,os
os.makedirs('out',exist_ok=True)
for pid,eid in json.load(open('ids.json')):
    u=f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/{eid}/competitions/{eid}/odds/{pid}/propBets?limit=1000"
    d=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=60).read())
    open(f'out/raw-{eid}-{pid}.json','w').write(json.dumps(d))
