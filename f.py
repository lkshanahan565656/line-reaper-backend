import json, gzip, urllib.request, os
B = 'https://site.api.espn.com/apis/site/v2/sports/'
C = {'basketball_nba': 'basketball/nba', 'football_nfl': 'football/nfl', 'football_college-football': 'football/college-football', 'hockey_nhl': 'hockey/nhl'}
def get(u):
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=60) as r: return json.load(r)
    except Exception as e: return {'error': str(e)}
os.makedirs('o', exist_ok=True)
for code, path in C.items():
    for d in ('20261024', '20261025', '20261026'):
        q = '&groups=80&limit=400' if 'college' in path else '&limit=400'
        sb = get(f'{B}{path}/scoreboard?dates={d}{q}')
        json.dump(sb, open(f'o/{code}-{d}.json', 'w'))
        for e in sb.get('events', []):
            s = get(f'{B}{path}/summary?event={e["id"]}')
            json.dump(s, gzip.open(f'o/sum-{code}-{e["id"]}.json.gz', 'wt'))
