import json, time, urllib.request
B = 'https://line-reaper-backend-production.up.railway.app'
def get(u, t=300):
    try:
        with urllib.request.urlopen(urllib.request.Request(B + u, headers={'User-Agent': 'diag'}), timeout=t) as r: return json.load(r)
    except Exception as e: return {'error': str(e)}
out = {'polls': []}
end = time.time() + 30 * 60
while time.time() < end:
    s = get('/api/status'); v = s.get('version'); out['polls'].append([time.strftime('%H:%M:%S'), v])
    if v == '3.149.0': break
    time.sleep(60)
time.sleep(240)   # let the free-books loop run a few times
s = get('/api/status')
out['version'] = s.get('version')
for k in ('gemini', 'polymarketUsBooks', 'pinnacleExtraGames', 'evResults'): out[k] = s.get(k)
out['freeBooksErrors'] = (s.get('freeBooks') or {}).get('errors')
out['freeBooksCounts'] = {k: v for k, v in ((s.get('freeBooks') or {}).get('counts') or {}).items() if isinstance(v, dict) and v.get('exchangeOnly')}
ev = get('/api/ev?state=TX')
rows = ev.get('rows', ev if isinstance(ev, list) else [])
out['evTX'] = [{k: r.get(k) for k in ('book', 'sport', 'event', 'market', 'side', 'price', 'ev', 'fairProb')} for r in rows if r.get('book') in ('gemini', 'polymarketus')][:40]
out['evTXcount'] = len([r for r in rows if r.get('book') in ('gemini', 'polymarketus')])
for bk in ('gemini', 'polymarketus'):
    out['bets_' + bk] = get(f'/api/ev/record/bets?book={bk}&limit=500')
sb = get('/api/ev/scoreboard?state=TX')
out['scoreboardTX'] = [r for r in sb.get('rows', []) if r.get('book') in ('gemini', 'polymarketus', 'kalshi')]
json.dump(out, open('out/check.json', 'w'), indent=1)
