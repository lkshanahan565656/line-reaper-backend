#!/usr/bin/env node
// Builds the Dota 2 series seed for the matchup engine from the OpenDota
// pro-match games the diag-esh2h workflow pulled (branch
// diag-esh2h-out-res-dota, data/res-dota.json.gz: 55.8k games 2024-09 to
// 2026-10 from api.opendota.com/api/proMatches):
//
//   node scripts/dota-seed.js <res-dota.json.gz>
//
// Each row there is one game (map): radiant a, dire b, aw = radiant won,
// t = start, sid = OpenDota's series id, st = series type (0 Bo1, 1 Bo3,
// 2 Bo5, 3 Bo2). Games of one series are folded into one series row with the
// first game's start; a game without a series id is its own Bo1.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { dotaSeriesFromGames } = require('../esmatchupdata');

const [file] = process.argv.slice(2);
if (!file) { console.error('usage: dota-seed.js <res-dota.json.gz>'); process.exit(1); }
const games = JSON.parse(zlib.gunzipSync(fs.readFileSync(file))).map(g => ({
  id: g.id, sid: g.sid || null, st: g.st, a: g.a, b: g.b, aWon: g.aw === 1 || g.aw === true, t: g.t, lg: g.lg || null,
}));
const rows = dotaSeriesFromGames(games).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
fs.writeFileSync(path.join(__dirname, '..', 'seeds', 'dota-series.json.gz'), zlib.gzipSync(JSON.stringify(rows)));
console.log('dota-series.json.gz', rows.length, rows[0]?.t, rows[rows.length - 1]?.t);
