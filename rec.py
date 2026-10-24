# Independent raw Pinnacle close recorder for the exchange rows (Gemini, Polymarket US, Kalshi).
# Every 4 min: open rows on the live site starting within 75 min (or started under 5 min ago) ->
# Pinnacle's raw straight markets (period 0) for the matched matchup, straight from Pinnacle's guest API.
import json, time, gzip, urllib.request, os, sys, re, datetime as D
B = 'https://line-reaper-backend-production.up.railway.app'
PIN = 'https://guest.api.arcadia.pinnacle.com/0.1'
END = time.time() + float(sys.argv[1]) * 60
SPORT = {'nfl': 15, 'ncaaf': 15, 'nba': 4, 'wnba': 4, 'ncaab': 4, 'nhl': 19, 'khl': 19, 'ahl': 19, 'shl': 19, 'mlb': 3, 'kbo': 3, 'npb': 3, 'tennis': 33, 'ufc': 22}
SOCCER = {'epl': 1980, 'laliga': 2196, 'bundesliga': 1842, 'seriea': 2436, 'ligue1': 2036, 'mls': 2663, 'ligamx': 2242, 'eredivisie': 1928, 'brasileirao': 1834, 'ucl': 2627, 'uel': 2630}
def get(u, t=120, h=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', **(h or {})}), timeout=t) as r: return json.load(r)
    except Exception as e: return {'error': str(e)}
P = lambda s: D.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
words = lambda s: set(w for w in re.sub(r'[^a-z0-9 ]', ' ', s.lower()).split() if len(w) > 2)
def same(a, b): return bool(words(a) & words(b))
os.makedirs('out/h', exist_ok=True)
while time.time() < END:
    now = time.time(); rows = []
    for bk in ('gemini', 'polymarketus', 'kalshi'):
        r = get(f'{B}/api/ev/record/bets?book={bk}&status=open&limit=500', 300)
        rows += r.get('bets', []) if isinstance(r, dict) else []
    due = [b for b in rows if b.get('start') and -300 < P(b['start']) - now < 75 * 60]
    feeds = {}
    for b in due:
        k = ('s', SPORT[b['sport']]) if b['sport'] in SPORT else ('l', SOCCER[b['sport']]) if b['sport'] in SOCCER else None
        if k and k not in feeds:
            path = f'sports/{k[1]}' if k[0] == 's' else f'leagues/{k[1]}'
            feeds[k] = (get(f'{PIN}/{path}/matchups', 120), get(f'{PIN}/{path}/markets/straight', 120))
    out = {'at': now, 'rows': [{k: b.get(k) for k in ('id', 'book', 'sport', 'event', 'market', 'point', 'side', 'start', 'price', 'decimal', 'pinClose', 'pinRaw')} for b in due], 'pin': {}}
    for b in due:
        k = ('s', SPORT[b['sport']]) if b['sport'] in SPORT else ('l', SOCCER.get(b['sport']))
        if k not in feeds: continue
        mus, mks = feeds[k]
        if not isinstance(mus, list) or not isinstance(mks, list): continue
        away, _, home = b['event'].partition(' @ ')
        hit = [m for m in mus if m.get('parentId') is None and m.get('type', 'matchup') == 'matchup' and abs(P(m['startTime']) - P(b['start'])) < 3 * 3600
               and len(m.get('participants', [])) >= 2
               and any(same(p.get('name', ''), home) for p in m['participants']) and any(same(p.get('name', ''), away) for p in m['participants'])]
        for m in hit:
            out['pin'][str(m['id'])] = {'matchup': m, 'markets': [x for x in mks if x.get('matchupId') == m['id'] and x.get('period') == 0]}
    stamp = D.datetime.utcnow().strftime('%Y%m%dT%H%M%S')
    with gzip.open(f'out/h/{stamp}.json.gz', 'wt') as f: json.dump(out, f)
    print(stamp, len(rows), len(due), len(out['pin']), flush=True)
    time.sleep(max(5, 240 - (time.time() - now)))
