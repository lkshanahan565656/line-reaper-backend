#!/bin/bash
# boot the PR branch against live feeds, wait for the esports props board, then read the research pages
mkdir -p out
cd app && npm ci --silent >/dev/null 2>&1
PORT=4999 LR_DATA_DIR=$PWD/data node server.js > ../out/server.log 2>&1 &
cd ..
B=http://127.0.0.1:4999
for i in $(seq 1 30); do
  sleep 30
  n=$(curl -s -m 20 $B/api/esports/research | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d.get('players',[])))" 2>/dev/null)
  echo "$(date -u +%H:%M:%S) players=$n" >> out/poll.txt
  if [ "${n:-0}" -gt 20 ] && [ $i -ge 8 ]; then break; fi
done
curl -s -m 30 $B/api/esports/research -o out/list.json
curl -s -m 30 $B/esports/research -o out/index.html
python3 - <<'PY' > out/pages.txt 2>&1
import json, urllib.request, urllib.parse, time, os
B='http://127.0.0.1:4999'
d=json.load(open('out/list.json'))
ps=d['players']
from collections import Counter
print('players', len(ps), Counter(p['game'] for p in ps), 'sources', d.get('sources'))
want={'LOL':4,'DOTA':3,'CS':2,'VAL':1,'COD':1}
os.makedirs('out/p', exist_ok=True)
for g,n in want.items():
    for p in [x for x in ps if x['game']==g][:n]:
        url=p['url']
        for kind,path in (('json','/api'+url),('html',url)):
            t=time.time()
            try:
                r=urllib.request.urlopen(B+urllib.parse.quote(path), timeout=60); body=r.read(); code=r.status
            except Exception as e:
                body=str(e).encode(); code='err'
            fn=f"out/p/{g}-{''.join(c for c in p['player'] if c.isalnum())}.{kind}"
            open(fn,'wb').write(body)
            if kind=='json':
                try:
                    j=json.loads(body); s=j['source']
                    print(f"{g} {p['player']} {code} {time.time()-t:.1f}s src={s['maps']} status={s['status']} err={s['error']} link={s['link']} maps={len(j['maps'])} series={len(j['series'])} hitFrom={j['hitFrom']} lines={j['lines']} market={j['market']}")
                    for h in j['hit'][:2]: print('    line', h['line'], [(w['window'], w['over'], w['n'], w['avg']) for w in h['windows']], [(s['label'], s['over'], s['n']) for s in h['splits']])
                    print('    maps', [(m['opp'], m['n'], m['k'], m['a']) for m in j['maps'][:6]])
                except Exception as e: print(g, p['player'], code, 'parse', e, body[:200])
PY
curl -s -m 20 $B/api/esports/research | python3 -c "import json,sys;print(json.load(sys.stdin).get('mapLogs'))" >> out/pages.txt
curl -s -m 20 $B/api/status > out/status.json
grep -i "research\|leaguepedia\|opendota" out/server.log | head -40 > out/warn.txt
