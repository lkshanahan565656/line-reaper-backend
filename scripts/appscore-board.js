// App scorecard on a recorded board (appscore.js): every app's number against
// Pinnacle's close, per app and per app and stat, graded where the board's
// report has the box score.
// Usage: node scripts/appscore-board.js <legs.json.gz> [out dir] [pick6 payouts.json]
//   legs.json.gz: a board report's legs (nflsun-<WEEK>-report, board-<WEEK>-report)
//   payouts: out/stats.json's p6Payouts as the recorder read them (Pick6's
//   3-pick paid 5.5x on 10-24, not 6x)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const A = require('../appscore');
const SP = require('../sportprops');

const [file, out = 'appscore-out', payouts] = process.argv.slice(2);
if (!file) { console.error('usage: node scripts/appscore-board.js <legs.json.gz> [out dir] [pick6 payouts.json]'); process.exit(2); }
if (payouts) {
  const j = JSON.parse(fs.readFileSync(payouts, 'utf8'));
  SP.setPick6Payouts(j.p6Payouts || j);
}
const board = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
fs.mkdirSync(out, { recursive: true });
const res = {};
for (const at of ['close', 'bet']) {
  const legs = A.legsFromBoard(board, { at });
  const card = A.scorecard(legs, { minCell: 10 });
  res[at] = card;
  const title = at === 'close' ? 'App scorecard: each app\'s last number before kickoff vs Pinnacle\'s close' : 'Bet time: each app\'s number an hour before kickoff vs Pinnacle\'s close';
  fs.writeFileSync(path.join(out, `scorecard-${at}.txt`), `${A.reportText(card, { title })}\n`);
  if (at === 'close') console.log(A.reportText(card, { title }));
}
res.pick6ThreePick = SP.FIXED.pick6?.grade || null;
res.at = new Date().toISOString();
fs.writeFileSync(path.join(out, 'scorecard.json'), JSON.stringify(res, null, 1));
