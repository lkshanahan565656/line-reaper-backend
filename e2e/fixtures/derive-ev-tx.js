// The recording's /api/ev?state=TX answer was read seconds after a server
// restart (staleLag since 05:09:03Z, 0.02 h): no feeds and no rows, while the
// all-states answer a minute earlier held 258 rows from 19 feeds. Whether the
// +EV tab opened with Texas picked then decided whether e2e saw an empty
// screen. This rebuilds the Texas answer from the all-states one with the
// server's own filter (venues.rowLegalIn, the same as GET /api/ev?state=TX),
// so it holds only recorded rows. Run once: node e2e/fixtures/derive-ev-tx.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const venues = require('../../venues');

const FILE = path.join(__dirname, 'snapshot.json.gz');
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf8'));
const ALL = '/api/ev?limit=1000', TX = '/api/ev?limit=1000&state=TX';
const full = JSON.parse(snap.responses[ALL].body), tx = JSON.parse(snap.responses[TX].body);
const ok = venues.rowLegalIn('TX');
const rows = full.rows.filter(ok);
const clear = rows.filter(r => !r.dfs && r.ev >= 2);
const out = {
  ...full,
  rows,
  alt: (full.alt || []).filter(ok),
  esports: (full.esports || []).filter(ok),
  stale: (full.stale || []).filter(ok),
  esStale: (full.esStale || []).filter(ok),
  count: rows.length,
  counts: { clear2: clear.length, agree2: clear.filter(r => r.agree).length, agree2Lines: clear.filter(r => r.agree && !r.player).length, agree2Props: clear.filter(r => r.agree && r.player).length },
  state: tx.state,
};
snap.responses[TX] = { ...snap.responses[TX], body: JSON.stringify(out) };
fs.writeFileSync(FILE, zlib.gzipSync(JSON.stringify(snap)));
console.log(`${TX}: ${rows.length} rows, ${out.alt.length} alt, ${out.feeds.length} feeds`);
