// The slip builder's speed-ups give the same numbers to the last bit.
// fixtures/autoslips-snapshot.json.gz: the esports board (418 picks) and the
// auto slips the builder made from it before the change, recorded on the
// 10-15 06:17Z raw feeds replayed through the server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const slip = require('../slip');
const { autoSlips } = require('../slipbuild');

// the factor model's loop as it stood before (fresh arrays per leg per node)
function factorReference(probs, loads, teams) {
  const n = probs.length;
  const t0 = teams.find(Boolean);
  const s = teams.map(t => (t && t === t0 ? 1 : -1));
  const phiCdf = x => {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
  };
  const phiInv = p => { let lo = -9, hi = 9; for (let i = 0; i < 70; i++) { const m = (lo + hi) / 2; if (phiCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
  const GRID = (() => { const k = 32, o = []; let tot = 0; for (let i = 0; i < k; i++) { const x = -5 + 10 * (i + 0.5) / k; const w = Math.exp(-x * x / 2); o.push([x, w]); tot += w; } return o.map(([x, w]) => [x, w / tot]); })();
  const c = probs.map(p => phiInv(1 - Math.min(1 - 1e-9, Math.max(1e-9, p))));
  const sd = loads.map(l => (l ? Math.sqrt(Math.max(1e-9, 1 - l.a * l.a - l.b * l.b)) : 1));
  const out = new Array(n + 1).fill(0);
  for (const [m, wm] of GRID) for (const [d, wd] of GRID) {
    let dist = [1];
    for (let i = 0; i < n; i++) {
      const l = loads[i];
      const q = l ? 1 - phiCdf((c[i] - l.a * m - l.b * s[i] * d) / sd[i]) : probs[i];
      const next = new Array(dist.length + 1).fill(0);
      for (let h = 0; h < dist.length; h++) { next[h] += dist[h] * (1 - q); next[h + 1] += dist[h] * q; }
      dist = next;
    }
    const w = wm * wd;
    for (let h = 0; h <= n; h++) out[h] += w * dist[h];
  }
  return out;
}

test('factor model: the in-place loop and its memo match the old loop bit for bit', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < 60; k++) {
    const n = 2 + (k % 6);
    const probs = [], loads = [], teams = [];
    for (let i = 0; i < n; i++) {
      probs.push(0.02 + 0.96 * rnd());
      const sign = rnd() < 0.5 ? -1 : 1;
      loads.push(rnd() < 0.15 ? null : { a: sign * Math.sqrt(0.3 * rnd()), b: sign * Math.sqrt(0.2 * rnd()) });
      teams.push(rnd() < 0.1 ? null : rnd() < 0.5 ? 'navi' : 'vitality');
    }
    const want = factorReference(probs, loads, teams);
    assert.deepStrictEqual(slip.factorHitsDistribution(probs, loads, teams), want);
    // asked again: the kept answer, and a copy the caller may change
    const again = slip.factorHitsDistribution(probs, loads, teams);
    assert.deepStrictEqual(again, want);
    again[0] = -1;
    assert.deepStrictEqual(slip.factorHitsDistribution(probs, loads, teams), want);
  }
});

const rev = (k, v) => (v && v.__map ? new Map(v.__map) : v && v.__set ? new Set(v.__set) : v);
const fix = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'autoslips-snapshot.json.gz'))), rev);

test('snapshot: auto slips on a recorded board are the ones built before the speed-up', () => {
  const [picks, opts] = fix.args;
  assert.ok(picks.length > 400 && fix.result.stacks.length > 10);
  // twice: the second build reads the kept factor answers
  for (let i = 0; i < 2; i++) assert.deepStrictEqual(JSON.parse(JSON.stringify(autoSlips(picks, { ...opts, now: fix.at }))), fix.result);
});
