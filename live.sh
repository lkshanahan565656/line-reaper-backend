#!/bin/bash
# wait for v3.165.0 on prod, then read the SHOP endpoints
B=https://line-reaper-backend-production.up.railway.app
mkdir -p out
for i in $(seq 1 60); do
  v=$(curl -s -m 20 $B/api/status | grep -o '"version":"[^"]*"' | head -1)
  echo "$(date -u +%H:%M:%S) $v" >> out/poll.txt
  [[ "$v" == *3.165.0* ]] && break
  sleep 30
done
sleep 240   # let the props board fill after boot
for p in "api/props/shop?limit=500" "api/props/shop?sort=start&limit=20" "api/props/shop/record" "api/props/board?limit=5"; do
  f=out/$(echo "$p" | tr '/?=&' '____').json
  curl -s -m 60 -D out/headers.txt -o "$f" -w "$p %{http_code} %{size_download}B %{time_total}s\n" "$B/$p" >> out/poll.txt
done
curl -s -m 30 -o out/app.html -w "app %{http_code} %{size_download}B\n" $B/app >> out/poll.txt
grep -c "renderShop" out/app.html >> out/poll.txt || true
