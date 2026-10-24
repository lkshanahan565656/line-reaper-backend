import json,urllib.request,gzip,os
L={'NBA':'basketball/nba','NFL':'football/nfl','CFB':'football/college-football','NHL':'hockey/nhl','MLB':'baseball/mlb'}
os.makedirs('out/box',exist_ok=True)
seen=set()
for l in json.load(open('regrade.json')):
    if not l['eventId'] or l['sport'] not in L: continue
    k=(l['sport'],l['eventId'])
    if k in seen: continue
    seen.add(k)
    u=f"https://site.api.espn.com/apis/site/v2/sports/{L[l['sport']]}/summary?event={l['eventId']}"
    try:
        d=urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=60).read()
        open(f"out/box/{l['sport']}-{l['eventId']}.json.gz",'wb').write(gzip.compress(d))
    except Exception as e: print('ERR',u,e)
print(len(seen))
