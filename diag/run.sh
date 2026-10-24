set -x
npm ci --silent || npm install --silent
PORT=8080 node server.js > out/server.log 2>&1 &
mkdir -p out
for i in $(seq 1 40); do sleep 30; curl -s localhost:8080/api/props/corr > out/corr.json; n=$(node -e "try{const d=require('./out/corr.json');console.log((d.stacks||[]).length)}catch(e){console.log(0)}"); echo "t=$i stacks=$n"; [ "$n" -gt 3 ] && [ $i -ge 12 ] && break; done
curl -s "localhost:8080/api/props/board?sport=SPORTS&limit=50" > out/board.json
curl -s localhost:8080/api/status > out/status.json
curl -s localhost:8080/api/props/record > out/record.json
sleep 200; curl -s localhost:8080/api/props/corr > out/corr2.json
