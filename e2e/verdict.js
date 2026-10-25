// Turns the crawl reports into one pass/fail: what counts as a failure, what
// is only listed, and the short summary printed at the end.
'use strict';
const fs = require('fs');
const path = require('path');

// Controls that may do nothing visible on purpose. Each needs a reason.
const ALLOW = JSON.parse(fs.readFileSync(path.join(__dirname, 'allow.json'), 'utf8'));
const re = s => new RegExp(s, 'i');

function allowedDead(d) {
  return ALLOW.dead.find(a => (!a.tab || a.tab === d.tab) && (!a.label || re(a.label).test(d.label)) && (!a.family || re(a.family).test(d.family)));
}
function allowedIssue(i) {
  return ALLOW.issues.find(a => a.kind === i.kind && Object.entries(a.match || {}).every(([k, v]) => re(v).test(String(i[k] ?? ''))));
}

// what /api/results marks proven, in the fixture: the only places "PROVEN" may show
function provenKinds(snapshot) {
  const r = snapshot?.responses?.['/api/results'];
  if (!r) return null;
  let d;
  try { d = JSON.parse(r.body); } catch { return null; }
  const out = [];
  const walk = (o, p) => {
    if (!o || typeof o !== 'object') return;
    if (o.verdict === 'proven') out.push(p);
    for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k);
  };
  walk(d, '');
  return out;
}

function combine(reports, { misses = [], recordedAt, snapshot, ms }) {
  const issues = [], dead = [], empties = [], proven = [];
  const tabs = {};
  let clicks = 0, requests = 0;
  const flows = {};
  for (const r of reports) {
    clicks += r.clicks; requests += r.requests;
    for (const i of r.issues) issues.push({ ...i, viewport: r.viewport });
    for (const d of r.dead) dead.push(d);
    for (const e of r.empties) empties.push(e);
    for (const p of r.proven) proven.push({ ...p, viewport: r.viewport });
    for (const [k, v] of Object.entries(r.tabs)) {
      const t = (tabs[k] ||= {});
      t[r.viewport] = { clicks: v.clicks, dead: v.dead, families: Object.keys(v.families).length, links: v.links || 0, ms: v.ms, opened: v.opened };
    }
    Object.assign(flows, Object.fromEntries(Object.entries(r.flows || {}).map(([k, v]) => [`${r.viewport} ${k}`, v])));
  }
  const kinds = provenKinds(snapshot);
  const failures = [];
  for (const i of issues) {
    const a = allowedIssue(i);
    if (a) { i.allowed = a.why; continue; }
    failures.push({ what: i.kind, ...i, key: undefined });
  }
  for (const d of dead) {
    const a = allowedDead(d);
    if (a) { d.allowed = a.why; continue; }
    failures.push({ what: 'dead-control', ...d });
  }
  // "PROVEN" may only show when the record has a proven kind
  const seen = new Set();
  for (const p of proven) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    const a = ALLOW.proven.find(x => re(x.text).test(p.text));
    if (a) { p.allowed = a.why; continue; }
    if (p.badge && /^proven$/i.test(p.word) && kinds && kinds.length) { p.allowed = `record has ${kinds.length} proven: ${kinds.slice(0, 3).join(', ')}`; continue; }
    failures.push({ what: 'proven-claim', ...p, key: undefined });
  }
  for (const m of misses) {
    if (ALLOW.misses.some(x => re(x.key).test(m.key))) continue;
    failures.push({ what: 'fixture-miss', ...m });
  }
  for (const [k, v] of Object.entries(flows)) if (!v.ok) failures.push({ what: 'flow', flow: k, ...v });
  // views that the snapshot has data for must not show their empty state
  for (const e of empties) {
    const want = ALLOW.mustHaveData.find(x => x.tab === e.tab && re(x.empty).test(e.text));
    if (want) failures.push({ what: 'empty-with-data', ...e, why: want.why });
  }
  return { ok: !failures.length, failures, ms, recordedAt, clicks, requests, tabs, flows, dead, empties, proven, issues, misses, provenKinds: kinds };
}

function summary(o) {
  const lines = [];
  lines.push(`e2e: ${o.ok ? 'PASS' : 'FAIL'} in ${(o.ms / 1000).toFixed(1)} s, ${o.clicks} clicks, ${o.requests} requests, snapshot ${o.recordedAt || 'none'}`);
  for (const [k, v] of Object.entries(o.tabs)) lines.push(`  ${k.padEnd(9)} ${Object.entries(v).map(([vp, t]) => `${vp} ${t.clicks} clicks/${t.families} kinds/${t.links} links${t.dead ? `/${t.dead} dead` : ''}`).join('  ')}`);
  for (const [k, v] of Object.entries(o.flows)) lines.push(`  flow ${k}: ${v.ok ? 'ok' : 'FAILED ' + (v.error || '')}`);
  if (o.failures.length) {
    lines.push(`${o.failures.length} failures:`);
    const by = {};
    for (const f of o.failures) (by[f.what] ||= []).push(f);
    for (const [k, list] of Object.entries(by)) {
      lines.push(` ${k} (${list.length})`);
      for (const f of list.slice(0, 25)) lines.push(`   - ${JSON.stringify(Object.fromEntries(Object.entries(f).filter(([x, v]) => x !== 'what' && v != null))).slice(0, 400)}`);
    }
  }
  return lines.join('\n');
}

module.exports = { combine, summary, provenKinds };
