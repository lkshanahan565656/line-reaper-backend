#!/usr/bin/env node
// Builds the CS2 and VALORANT series seeds for the matchup engines from the
// results the diag-esh2h workflow pulled (branches diag-esh2h-out-res-cs and
// diag-esh2h-out-res-val):
//
//   node scripts/esmatchup-seed.js <res-cs.json.gz> <res-val.json.gz>
//
// CS2 (bo3.gg finished matches): the event tier (s, a, b, c) stands in for a
// league, so a new team starts at its tier's level.
// VALORANT (vlr.gg results list): day plus listed time. vlr.gg lists times
// five hours behind UTC for a visitor without a cookie (1,062 series matched
// to Kalshi start times: 65% exactly +5 h, nearly all within an hour).
// Forfeits (0-0) and rows without both names are left out.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const [csFile, valFile] = process.argv.slice(2);
if (!csFile || !valFile) { console.error('usage: esmatchup-seed.js <res-cs.json.gz> <res-val.json.gz>'); process.exit(1); }
const gz = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
const out = (name, rows) => {
  rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  fs.writeFileSync(path.join(__dirname, '..', 'seeds', name), zlib.gzipSync(JSON.stringify(rows)));
  console.log(name, rows.length, rows[0]?.t, rows[rows.length - 1]?.t);
};
const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&ndash;/g, '-').replace(/&#0?39;|&apos;/g, "'").trim();

const TIER = { s: 'CS2 S-tier', a: 'CS2 A-tier', b: 'CS2 B-tier', c: 'CS2 C-tier' };
out('cs2-series.json.gz', gz(csFile).filter(m => m.an && m.bn && m.s1 != null && m.s2 != null && m.s1 + m.s2 > 0 && m.t).map(m => ({
  id: `bo3:${m.id}`, t: new Date(Date.parse(m.t)).toISOString(), lg: TIER[m.tier] || 'CS2 other', bo: m.bo || null, a: m.an, b: m.bn, s1: m.s1, s2: m.s2,
})));

const minutes = s => { const m = /(\d+):(\d+)\s*(AM|PM)/i.exec(s || ''); if (!m) return null; let h = Number(m[1]) % 12; if (/PM/i.test(m[3])) h += 12; return h * 60 + Number(m[2]); };
out('val-series.json.gz', gz(valFile).filter(v => v.a && v.b && v.s1 != null && v.s2 != null && v.s1 + v.s2 > 0 && v.day).map(v => {
  const mins = minutes(v.time);
  return { id: `vlr:${v.id}`, t: new Date(v.day + ((mins ?? 12 * 60) + 300) * 60e3).toISOString(), lg: null, stage: decode(v.ev) || null, bo: Math.max(v.s1, v.s2) * 2 - 1 || null, a: decode(v.a), b: decode(v.b), s1: v.s1, s2: v.s2 };
}));
