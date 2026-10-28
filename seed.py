import json, os, sys
d = sys.argv[1]; os.makedirs(d, exist_ok=True)
m = {'ev-bets.json': 'rows-ev', 'ev-alt-bets.json': 'rows-alt', 'ev-es-bets.json': 'rows-es', 'ev-stale-bets.json': 'rows-stale', 'sport-props.json': 'rows-props'}
for f, s in m.items(): json.dump(json.load(open(f'out/{s}.json')), open(f'{d}/{f}', 'w'))
json.dump(json.load(open('out/rows-bigmoney.json'))['rows'], open(f'{d}/big-money.json', 'w'))
