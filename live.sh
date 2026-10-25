#!/bin/bash
# wait for v3.167.0 on prod, then read the PROMOS endpoints twice (PrizePicks' full pull is every 20 min)
B=https://line-reaper-backend-production.up.railway.app
mkdir -p out
for i in $(seq 1 80); do
  v=$(curl -s -m 20 $B/api/status | grep -o '"version":"[^"]*"' | head -1)
  echo "$(date -u +%H:%M:%S) $v" >> out/poll.txt
  [[ "$v" == *3.167.0* ]] && break
  sleep 30
done
for round in 1 2; do
  sleep $([ $round = 1 ] && echo 300 || echo 1200)
  for p in "api/props/promos?limit=500" "api/props/promos?priced=0&limit=500" "api/props/promos/record" "api/props/board?limit=3"; do
    f=out/r${round}_$(echo "$p" | tr '/?=&' '____').json
    curl -s -m 90 -o "$f" -w "r$round $p %{http_code} %{size_download}B %{time_total}s\n" "$B/$p" >> out/poll.txt
  done
done
curl -s -m 30 -o out/app.html -w "app %{http_code} %{size_download}B\n" $B/app >> out/poll.txt
grep -c "renderPromos" out/app.html >> out/poll.txt || true
