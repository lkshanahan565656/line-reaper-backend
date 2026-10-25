// Fits seeds/ufc-model.json from UFCStats history (Greco1899 mirror CSVs).
// node scripts/ufc-fit.js <dir with the three CSVs> [--write]
// Train 2019-01-01..2024-12-31, report held out 2025-01-01 on.
const fs = require('fs'), path = require('path');
const D = require('../ufcdata'), M = require('../ufcmodel');
const { canonName } = require('../ev');
const dir = process.argv[2];
const rd = f => D.parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
const fights = D.buildFights({ events: rd(D.FILES.events), results: rd(D.FILES.results), stats: rd(D.FILES.stats) });
const TRAIN = ['2019-01-01', '2025-01-01'];
const hazard = M.fitHazard(fights, { from: TRAIN[0], to: TRAIN[1], isDecision: D.isDecision, isVoid: D.isVoid });

// rows: each fighter in each fight with both careers before it
const car = new Map(), rows = [];
const get = n => { const k = canonName(n); if (!car.has(k)) car.set(k, { n: 0, mins: 0, sigL: 0, sigA: 0, tdL: 0, tdA: 0 }); return car.get(k); };
for (const f of fights) {
  if (D.isVoid(f.method) || f.f.some(x => x.sig == null)) continue;
  const a = get(f.f[0].name), b = get(f.f[1].name);
  if (f.date >= '2016-01-01') for (const [i, me, op] of [[0, a, b], [1, b, a]]) rows.push({ date: f.date, div: f.div, T: f.T, sched: f.sched, sig: f.f[i].sig, td: f.f[i].td, me: { ...me, div: f.div }, op: { ...op } });
  for (const [i, me] of [[0, a], [1, b]]) { const o = f.f[1 - i]; me.n++; me.mins += f.T; me.sigL += f.f[i].sig; me.sigA += o.sig; me.tdL += f.f[i].td; me.tdA += o.td; }
}
const inTrain = r => r.date >= TRAIN[0] && r.date < TRAIN[1];
const ok = r => r.me.n >= 2 && r.op.n >= 2 && r.T > 0.2;
const train = rows.filter(r => inTrain(r) && ok(r)), test = rows.filter(r => r.date >= TRAIN[1] && ok(r));
// division priors (rate a minute) from the train fights
const prior = stat => {
  const by = {}; let n = 0, s = 0;
  for (const r of rows.filter(inTrain)) { const v = r[stat]; by[r.div] = by[r.div] || [0, 0]; by[r.div][0] += v; by[r.div][1] += r.T; s += v; n += r.T; }
  return { all: +(s / n).toFixed(4), ...Object.fromEntries(Object.entries(by).map(([d, [a, b]]) => [d, +(a / b).toFixed(4)])) };
};
const lgamma = x => { // Lanczos
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
};
const nbll = (y, mu, k) => lgamma(y + k) - lgamma(k) - lgamma(y + 1) + k * Math.log(k / (k + mu)) + y * Math.log(mu / (k + mu));
function fit(stat) {
  const P = { [stat]: { prior: prior(stat) } };
  let best = null;
  for (const w of [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1]) for (const m of [1, 2, 3, 5, 7, 10, 15, 20, 30, 45]) for (const k of stat === 'sig' ? [2, 2.5, 3, 3.5, 4, 5] : [0.4, 0.6, 0.8, 1, 1.2, 1.5, 2]) {
    P[stat].w = w; P[stat].m = m;
    let ll = 0;
    for (const r of train) { const mu = Math.max(0.01, M.rateOf(r.me, r.op, stat, P) * r.T); ll += nbll(r[stat], mu, k); }
    if (!best || ll > best.ll) best = { w, m, k, ll };
  }
  return { prior: P[stat].prior, w: best.w, m: best.m, k: best.k, minFights: 2, trainLL: +(best.ll / train.length).toFixed(4) };
}
const sig = fit('sig'), td = fit('td');
const params = { fitted: new Date().toISOString().slice(0, 10), train: TRAIN, source: 'UFCStats via github.com/Greco1899/scrape_ufc_stats', fights: fights.length, latest: fights[fights.length - 1].date,
  hazard, sig, td, counts: { train: train.length, test: test.length } };
// held out: given the real time, P(over) at the fighter's median line vs the outcome
function holdout(stat) {
  // the line: the division's own median count for the minutes fought (what an
  // app with no fighter knowledge would hang); the model vs the division rate alone
  let b = 0, b0 = 0, n = 0, ll = 0, ll0 = 0;
  const buckets = {};
  for (const r of test) {
    const rate = M.rateOf(r.me, r.op, stat, params), mu = rate * r.T;
    const pr = params[stat].prior[r.div] ?? params[stat].prior.all, mu0 = pr * r.T;
    const line = Math.floor(mu0) + 0.5, p = M.nbOver(line, mu, params[stat].k), p0 = M.nbOver(line, mu0, params[stat].k), y = r[stat] > line ? 1 : 0;
    b += (p - y) ** 2; b0 += (p0 - y) ** 2; n++; ll += Math.log(Math.max(1e-6, y ? p : 1 - p)); ll0 += Math.log(Math.max(1e-6, y ? p0 : 1 - p0));
    const k = Math.min(9, Math.floor(p * 10)); buckets[k] = buckets[k] || [0, 0, 0]; buckets[k][0]++; buckets[k][1] += p; buckets[k][2] += y;
  }
  return { n, brier: +(b / n).toFixed(4), brierDivisionOnly: +(b0 / n).toFixed(4), logloss: +(-ll / n).toFixed(4), loglossDivisionOnly: +(-ll0 / n).toFixed(4),
    calibration: Object.keys(buckets).sort((a, c) => a - c).map(k => ({ bucket: `${k * 10}-${k * 10 + 10}%`, n: buckets[k][0], predicted: +(buckets[k][1] / buckets[k][0]).toFixed(3), hit: +(buckets[k][2] / buckets[k][0]).toFixed(3) })) };
}
params.holdout = { sig: holdout('sig'), td: holdout('td') };
console.log(JSON.stringify({ ...params, hazard: { bin: hazard.bin, h3n: hazard.h3.length, h5n: hazard.h5.length } }, null, 1));
if (process.argv.includes('--write')) fs.writeFileSync(path.join(__dirname, '..', 'seeds', 'ufc-model.json'), JSON.stringify(params, null, 1) + '\n');
