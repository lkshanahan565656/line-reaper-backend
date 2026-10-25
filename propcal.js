// ─── PROP MODEL CALIBRATION (shared by the NBA and CFB models) ───────────────
// A model's raw P(over) on a logit scale, shifted and shrunk per stat by a
// logistic fit on development lines: cal = { a, b, range, stat: { stat: [a, b] } }.
// The slope b says how much the model knows beyond the line itself (1 = trust
// the raw number, 0 = the line is all there is). Fitted on results at the line
// only, never on a price. First used by NBA v2 (checks/nba-model-v2-2026-10-25),
// then CFB v2 (checks/cfb-model-v2-2026-10-25).

const clip = p => Math.min(0.995, Math.max(0.005, p));
const logit = p => { const q = clip(p); return Math.log(q / (1 - q)); };

// cal missing → the raw number passes through (v1 params)
function calibrate(p, stat, cal) {
  if (!cal) return p;
  const [a, b] = cal.stat?.[stat] || [cal.a || 0, cal.b ?? 1];
  // the fit only saw raw P(over) within |logit| under cal.range (about 18% to
  // 82% at 1.5): past that the line is far from the projection (a stale or
  // alternate line), so the fitted curve stops and the raw slope carries on,
  // keeping it monotone and continuous
  const x = logit(p), R = cal.range ?? Infinity;
  const xin = Math.max(-R, Math.min(R, x));
  return 1 / (1 + Math.exp(-(a + b * xin + (x - xin))));
}

// over ~ a + b * x by Newton's method
function fit1(xs, ys) {
  let a = 0, b = 1;
  for (let it = 0; it < 50; it++) {
    let g0 = 0, g1 = 0, h00 = 1e-6, h01 = 0, h11 = 1e-6;
    for (let i = 0; i < xs.length; i++) {
      const p = 1 / (1 + Math.exp(-(a + b * xs[i]))), r = ys[i] - p, w = p * (1 - p);
      g0 += r; g1 += r * xs[i]; h00 += w; h01 += w * xs[i]; h11 += w * xs[i] * xs[i];
    }
    const det = h00 * h11 - h01 * h01;
    const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return [a, b];
}

// rows [{ stat, raw, over }] → cal. Inside the range only (the guard's region);
// a stat with minN+ rows gets its own fit, shrunk toward the pooled one with
// `pseudo` pseudo-lines.
function fitCal(rows, { range = 1.5, minN = 300, pseudo = 1000 } = {}) {
  const r4 = x => Math.round(x * 1e4) / 1e4;
  const inR = rows.filter(r => Math.abs(logit(r.raw)) <= range);
  const all = fit1(inR.map(r => logit(r.raw)), inR.map(r => r.over));
  const by = {};
  for (const r of inR) (by[r.stat] ||= []).push(r);
  const stat = {};
  for (const [s, rs] of Object.entries(by)) {
    if (rs.length < minN) continue;
    const f = fit1(rs.map(r => logit(r.raw)), rs.map(r => r.over));
    const w = rs.length / (rs.length + pseudo);
    stat[s] = [r4(w * f[0] + (1 - w) * all[0]), r4(w * f[1] + (1 - w) * all[1])];
  }
  return { a: r4(all[0]), b: r4(all[1]), range, n: inR.length, stat };
}

module.exports = { calibrate, fitCal, fit1, logit };
