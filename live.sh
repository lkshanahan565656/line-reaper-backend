#!/bin/bash
# boot the PR branch against live feeds, let the player log read ESPN, then read the pages
mkdir -p out
cd app && npm ci --silent >/dev/null 2>&1
PORT=4999 LR_DATA_DIR=$PWD/data node server.js > ../out/server.log 2>&1 &
cd ..
B=http://127.0.0.1:4999
for i in $(seq 1 32); do
  sleep 30
  curl -s -m 20 $B/api/status | python3 -c "import json,sys;d=json.load(sys.stdin);p=d.get('playerLog',{});print('$(date -u +%H:%M:%S)',p.get('games'),p.get('bySport'),p.get('running'),p.get('reads'),p.get('errors',[])[:2])" >> out/poll.txt 2>&1
done
python3 - <<'PY' > out/pages.txt 2>&1
import json, urllib.request, urllib.parse, time
B='http://127.0.0.1:4999'
def get(p):
    t=time.time(); r=urllib.request.urlopen(B+p, timeout=60); body=r.read(); return json.loads(body), time.time()-t, len(body)
st,_,_=get('/api/status'); print('playerLog', json.dumps(st.get('playerLog'))[:1500])
for sport in ['NFL','CFB','NBA','NHL','MLB','LOL','CS','VAL']:
    for book in ['prizepicks','underdog']:
        try:
            d,dt,n=get(f'/api/props/board?sport={sport}&book={book}&facets=1&sort=hit10&limit=40')
        except Exception as e:
            print(sport, book, 'board error', e); continue
        rows=d.get('rows',[]); withhit=[r for r in rows if r.get('hit')]
        print(f'{sport} {book}: board {dt:.2f}s {n}B rows {len(rows)} total {d.get("total")} with hit {len(withhit)}')
        for r in rows[:3]: print('   ', r['player'], r['market'], r['books'].get(book,{}).get('line'), r.get('hit'))
        for r in (withhit[:2] or rows[:1]):
            try:
                p,dt,n=get('/api/props/player?key='+urllib.parse.quote(r['key']))
                h=p['hits'][0] if p['hits'] else {}
                print(f"    PAGE {dt:.2f}s {n}B ms={p.get('ms')} {p['player']} {p['market']} team={p['team']} opp={p['opponent']} home={p['homeTonight']} games={p['games']} season={p['seasonGames']} src={p['source']} amb={p['ambiguous']} unsup={p['unsupported']}")
                print('      lines', p['lines'], 'L10', h.get('l10'), 'season', h.get('season'), 'vs', h.get('vs'))
                print('      log', [(time.strftime('%m-%d', time.gmtime(e['t']/1000)), e['opp'], e['v'], e['u']) for e in p['log'][:6]])
                print('      usage', p.get('usage'), 'books', (p.get('books') or [])[:3], 'moves', len(p.get('moves') or []), 'others', len(p.get('others') or []))
            except Exception as e: print('    PAGE error', e)
PY
curl -s -m 20 $B/api/ops > out/ops.json
grep -i "player log" out/server.log | head -20 > out/plog-warn.txt
