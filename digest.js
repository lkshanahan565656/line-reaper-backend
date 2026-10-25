'use strict';
// ─── THE WEEKLY RECORD DIGEST ────────────────────────────────────────────────
// Once a week (Monday 13:00 UTC) the server writes one digest of the public
// record, the same for everyone, from the same strict record RESULTS and the
// sales page read (closeboard.scoreboard → claims.publicRecord). Per kind and
// venue it says:
//
//   this week   games whose start fell in the week (Monday 00:00 UTC to the
//               next Monday) and were graded: count, CLV, beat rate, W-L
//   the bar     graded all time at the week's start and end (toward 50), and
//               the CLV t at both ends, so a reader sees it move toward the
//               bar or away from it
//   all time    the RESULTS row as of the week's end: graded, CLV, t, W-L,
//               units and the label (proven, building, research, ...)
//   change      newly proven, no longer proven, newly losing to the close,
//               reached 50 graded
//
// A game closes at its start, so "as of time T" is every play whose game
// started before T. Units are said as a profit only where RESULTS says so
// (claims.profitOf on a proven row); the "model, not an edge" tags are
// claims.LABELS unchanged. Nothing here sizes a bet or says to place one.
//
// A digest is frozen when it is published (Monday 13:00 UTC): the share link
// (/digest/<week>) shows what was sent. A past week with no frozen digest (from
// before this shipped) is rebuilt from the record as it reads now, and says so.
//
// Pure: build(), weekOf(), pushText(), renderPage(). server.js does the I/O.

const closeboard = require('./closeboard');
const claims = require('./claims');

const DAY = 86400e3, WEEK = 7 * DAY;
const SEND_HOUR_UTC = 13;

// Monday 00:00 UTC at or before t
function weekStart(t) {
  const d = new Date(t);
  const m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return m - ((new Date(m).getUTCDay() + 6) % 7) * DAY;
}
const weekId = t => new Date(weekStart(t)).toISOString().slice(0, 10);
const validWeek = id => /^\d{4}-\d{2}-\d{2}$/.test(String(id || '')) && Number.isFinite(Date.parse(`${id}T00:00:00Z`)) && weekId(Date.parse(`${id}T00:00:00Z`)) === id;
// { id, from, to } for a week id ('2026-10-19') or the week holding t
function weekOf(idOrT) {
  const from = typeof idOrT === 'string' ? Date.parse(`${idOrT}T00:00:00Z`) : weekStart(idOrT);
  return { id: new Date(from).toISOString().slice(0, 10), from, to: from + WEEK };
}
// "Oct 19 to 25", "Oct 26 to Nov 1"
function weekName(id) {
  const { from, to } = weekOf(id);
  const a = new Date(from), b = new Date(to - DAY);
  const mon = d => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${mon(a)} ${a.getUTCDate()} to ${mon(b) === mon(a) ? '' : `${mon(b)} `}${b.getUTCDate()}`;
}
// the week a Monday 13:00 UTC send covers: the one that just ended
const dueWeek = now => weekOf(weekStart(now) - WEEK).id;
const sendAt = id => weekOf(id).to + SEND_HOUR_UTC * 3600e3;

const startOf = b => Date.parse(b.start || b.startTime || b.flaggedAt || b.signalAt || '') || 0;
// the tracker lists cut to plays whose game started in [from, to)
function cut(lists, from, to) {
  const out = {};
  for (const [k, l] of Object.entries(lists || {})) out[k] = (l || []).filter(b => { const s = startOf(b); return s >= from && s < to; });
  return out;
}
const recordAt = (lists, from, to) => claims.publicRecord({ board: closeboard.scoreboard(cut(lists, from, to)) });

const CLAIMABLE = new Set(['proven', 'building', 'too early', 'losing to the close', 'not graded yet']);
// toward the bar: more graded with the t holding at 2 or rising; away: the t fell
function moveOf(before, after, weekGraded) {
  if (!weekGraded) return 'flat';
  if (!CLAIMABLE.has(after.label)) return null;   // research, copied, no sharp close: no bar to move toward
  const tb = before?.clvT, ta = after.clvT;
  if (ta == null) return 'toward';
  if (tb == null) return ta >= 0 ? 'toward' : 'away';
  return ta >= 2 || ta >= tb ? 'toward' : 'away';
}
function changeOf(before, after) {
  const b = before?.label || 'not graded yet', a = after.label;
  if (a === 'proven' && b !== 'proven') return 'newly proven';
  if (b === 'proven' && a !== 'proven') return 'no longer proven';
  if (a === 'losing to the close' && b !== 'losing to the close') return 'newly losing to the close';
  if ((before?.graded || 0) < (after.target || 50) && after.graded >= (after.target || 50) && CLAIMABLE.has(a)) return 'reached 50 graded';
  return null;
}

// lists: the scoreboard's tracker lists; week: id, or null for the week so far
function build({ lists = {}, week = null, now = Date.now() } = {}) {
  const w = weekOf(week || now);
  const partial = w.to > now;
  const end = Math.min(w.to, now);
  const before = recordAt(lists, 0, w.from), after = recordAt(lists, 0, end), wk = recordAt(lists, w.from, end);
  const key = r => `${r.kind}|${r.book}`;
  const mb = new Map(before.rows.map(r => [key(r), r])), mw = new Map(wk.rows.map(r => [key(r), r]));
  const rows = after.rows.map(a => {
    const b = mb.get(key(a)) || null, x = mw.get(key(a)) || null;
    const weekGraded = x?.graded || 0;
    const change = changeOf(b, a);
    return {
      kind: a.kind, kindLabel: a.kindLabel, book: a.book, bookName: a.bookName, texas: a.texas, relayed: a.relayed,
      week: { graded: weekGraded, clv: x?.clv ?? null, beatPct: x?.beatPct ?? null, wins: x?.wins || 0, losses: x?.losses || 0,
        // the week's units are a profit only on a row RESULTS shows a profit for
        units: x?.units ?? null, profitShown: !!a.profitShown && (x?.units ?? 0) > 0 },
      bar: { target: a.target, before: b?.graded || 0, after: a.graded, left: Math.max(0, a.target - a.graded), tBefore: b?.clvT ?? null, tAfter: a.clvT ?? null, move: moveOf(b, a, weekGraded) },
      all: { graded: a.graded, clv: a.clv, clvT: a.clvT, beatPct: a.beatPct, wins: a.wins, losses: a.losses, units: a.units, profitShown: a.profitShown, label: a.label, why: a.why },
      labelBefore: b?.label || 'not graded yet', change,
    };
  }).filter(r => r.week.graded > 0 || r.change);
  rows.sort((p, q) => (!!q.change - !!p.change) || q.week.graded - p.week.graded || q.all.graded - p.all.graded);
  const proven = after.rows.filter(r => r.label === 'proven').map(r => ({ kind: r.kind, kindLabel: r.kindLabel, book: r.book, bookName: r.bookName, graded: r.graded, clv: r.clv, texas: r.texas, profitShown: r.profitShown, units: r.profitShown ? r.units : null }));
  const names = c => rows.filter(r => r.change === c).map(r => `${r.kindLabel} · ${r.bookName}`);
  const quiet = after.rows.filter(r => r.recorded && !rows.some(x => key(x) === key(r))).length;
  return {
    week: w.id, name: weekName(w.id), from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString(), partial,
    builtAt: new Date(now).toISOString(), rule: after.rule,
    summary: {
      graded: rows.reduce((s, r) => s + r.week.graded, 0), kinds: rows.filter(r => r.week.graded > 0).length, quiet,
      proven, newlyProven: names('newly proven'), noLongerProven: names('no longer proven'), newlyFailed: names('newly losing to the close'), reached50: names('reached 50 graded'),
      overall: { week: { graded: wk.overall.graded, clv: wk.overall.clv }, all: { graded: after.overall.graded, clv: after.overall.clv }, label: 'pooled, never proven' },
    },
    rows,
    labels: after.labels,
  };
}

const pc = x => (x == null ? '—' : `${x > 0 ? '+' : ''}${Number(x).toFixed(1)}%`);
const list = a => (a.length ? a.join(', ') : 'none');
// the push and the share card: plain lines, the link last (push.toNotification
// shows the first three and opens the link)
function pushText(d, { origin = '' } = {}) {
  const s = d.summary;
  const lines = [
    `Week of ${d.name}: ${s.graded.toLocaleString('en-US')} game${s.graded === 1 ? '' : 's'} graded across ${s.kinds} kind${s.kinds === 1 ? '' : 's'} and venue${s.kinds === 1 ? '' : 's'}.`,
    s.proven.length ? `Proven: ${s.proven.map(p => `${p.kindLabel} · ${p.bookName} (${p.graded} graded, CLV ${pc(p.clv)})`).join('; ')}.` : 'Proven: nothing yet.',
    `Newly proven: ${list(s.newlyProven)}. Newly losing to the close: ${list(s.newlyFailed)}.${s.noLongerProven.length ? ` No longer proven: ${list(s.noLongerProven)}.` : ''}`,
  ];
  const o = String(origin || '').replace(/\/+$/, '');
  if (/^https:\/\//.test(o)) lines.push(`${o}/digest/${d.week}`);
  return lines.join('\n');
}

// ─── THE SHARE PAGE: /digest/<week> ──────────────────────────────────────────
// Read-only and public, under the sales page's rule: it says proven only of a
// row RESULTS marks proven and a profit only where RESULTS shows one.
const LABEL_COLOR = { proven: '#34d399', building: '#fbbf24', 'too early': '#94a3b8', 'losing to the close': '#f87171', research: '#a78bfa', 'copied book': '#94a3b8', 'no sharp close': '#64748b', 'not graded yet': '#64748b' };
const CHANGE_COLOR = { 'newly proven': '#34d399', 'no longer proven': '#f87171', 'newly losing to the close': '#f87171', 'reached 50 graded': '#60a5fa' };
const t1 = x => (x == null ? '—' : `${x > 0 ? '+' : ''}${Number(x).toFixed(1)}`);
function renderPage(d, { origin = '', frozen = null, sentAt = null } = {}) {
  const learn = require('./learn');
  const { esc } = learn;
  const o = String(origin).replace(/[^\w.:/-]/g, '').replace(/\/+$/, '');
  const s = d.summary;
  const units = (u, shown) => (u == null ? '—' : shown ? `${u > 0 ? '+' : ''}${Number(u).toFixed(1)}u` : `<span class="muted" title="Not a profit claim: this kind is not proven, or its units do not clear chance">${u > 0 ? '+' : ''}${Number(u).toFixed(1)}u*</span>`);
  const lab = l => `<span class="lab" style="color:${LABEL_COLOR[l] || '#94a3b8'}">${esc(String(l).toUpperCase())}</span>`;
  const body = d.rows.map(r => `<tr>
<td>${lab(r.all.label)}${r.change ? `<div class="lab" style="color:${CHANGE_COLOR[r.change]}">${esc(r.change.toUpperCase())}</div>` : ''}</td>
<td><b>${esc(r.kindLabel)}</b> · ${esc(r.bookName)}${r.texas ? ' <span class="lab tx">TX</span>' : ''}${r.all.why ? `<div class="why">${esc(r.all.why)}</div>` : ''}</td>
<td class="n">${r.week.graded}<div class="sub">${pc(r.week.clv)} · ${r.week.wins + r.week.losses ? `${r.week.wins}-${r.week.losses}` : '—'}</div></td>
<td class="n">${r.bar.before} → ${r.bar.after}/${r.bar.target}<div class="sub">t ${t1(r.bar.tBefore)} → ${t1(r.bar.tAfter)}${r.bar.move === 'toward' ? ' · toward' : r.bar.move === 'away' ? ' · away' : ''}</div></td>
<td class="n">${pc(r.all.clv)}<div class="sub">${r.all.wins + r.all.losses ? `${r.all.wins}-${r.all.losses}` : '—'} · ${units(r.all.units, r.all.profitShown)}</div></td></tr>`).join('');
  const table = body
    ? `<div class="scroll"><table><thead><tr><th></th><th>Kind · venue</th><th class="n">This week</th><th class="n">Toward 50</th><th class="n">All time</th></tr></thead><tbody>${body}</tbody></table></div>`
    : '<p class="note">Nothing graded this week: no flagged game started and closed in it.</p>';
  const provenTxt = s.proven.length
    ? s.proven.map(p => `<li><b>${esc(p.kindLabel)} · ${esc(p.bookName)}</b>: ${p.graded} graded, CLV ${esc(pc(p.clv))}${p.texas ? ', a Texas venue' : ', not a Texas venue'}, ${p.profitShown ? `profit ${esc(units(p.units, true))}` : 'profit not shown yet (units do not clear chance)'}.</li>`).join('')
    : '<li>Nothing is proven yet.</li>';
  const tags = (d.labels || []).map(l => `<tr><td>${esc(l.tool)}</td><td>${esc(String(l.tag).toUpperCase())}</td><td>${esc(l.where)}: ${esc(l.why)}</td></tr>`).join('');
  const state = d.partial ? `The week so far, read ${esc(d.builtAt.slice(0, 16).replace('T', ' '))} UTC. It is published Monday 13:00 UTC.`
    : frozen ? `Published ${esc(String(sentAt || d.builtAt).slice(0, 16).replace('T', ' '))} UTC and frozen: this is what was sent.`
    : `Rebuilt from the record as it reads ${esc(d.builtAt.slice(0, 16).replace('T', ' '))} UTC (this week came before the digest was published).`;
  const lead = `${s.graded} game${s.graded === 1 ? '' : 's'} graded across ${s.kinds} kind${s.kinds === 1 ? '' : 's'} and venue${s.kinds === 1 ? '' : 's'}.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Week of ${esc(d.name)} | Line Reaper record</title>
<meta name="description" content="${esc(lead)}">
<meta property="og:title" content="Line Reaper record: week of ${esc(d.name)}">
<meta property="og:description" content="${esc(lead)}">
${o ? `<meta property="og:image" content="${esc(o)}/og.png"><link rel="canonical" href="${esc(o)}/digest/${esc(d.week)}">` : ''}
<meta name="theme-color" content="#080b10">
<link rel="icon" href="${learn.FAVICON}">
<style>${learn.CSS}
.lab { font:700 10px var(--mono); letter-spacing:.06em; white-space:nowrap; }
.lab.tx { color:#60a5fa; }
.why, .sub { color:var(--muted); font-size:11px; font-family:inherit; }
td.n, th.n { text-align:right; white-space:nowrap; }
.muted { color:var(--muted); }
.tiles { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 18px; }
.tiles div { flex:1 1 140px; background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
.tiles span { display:block; font:600 10px var(--mono); letter-spacing:.1em; color:var(--muted); }
.tiles b { display:block; font-size:20px; margin:2px 0; }
.tiles i { font-style:normal; color:var(--text2); font-size:12px; }
</style>
</head>
<body>
<header class="top"><div class="top-in"><a class="brand" href="/">${learn.LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app?start=results">OPEN RESULTS</a></div></header>
<main>
<p class="kicker">Weekly record</p>
<h1>Week of ${esc(d.name)}</h1>
<p class="lead">${esc(lead)} Every number comes from the public record on RESULTS, graded against the close.</p>
<p class="note">${state}</p>
<div class="tiles">
<div><span>GRADED THIS WEEK</span><b>${s.graded}</b><i>${s.kinds} kinds and venues</i></div>
<div><span>PROVEN</span><b style="color:${s.proven.length ? 'var(--green2)' : 'var(--text2)'}">${s.proven.length}</b><i>${s.newlyProven.length ? `${s.newlyProven.length} new this week` : 'none new this week'}</i></div>
<div><span>NEWLY LOSING TO THE CLOSE</span><b style="color:${s.newlyFailed.length ? '#f87171' : 'var(--text2)'}">${s.newlyFailed.length}</b><i>${s.noLongerProven.length ? `${s.noLongerProven.length} no longer proven` : 'none lost proven'}</i></div>
<div><span>ALL SHARP CLOSES</span><b>${esc(pc(s.overall.week.clv))}</b><i>this week, ${s.overall.week.graded} graded · pooled, never proven</i></div>
</div>
<h2>Proven at the end of the week</h2>
<ul>${provenTxt}</ul>
<h2>By kind and venue</h2>
${table}
<p class="note">This week: games that started in the week and were graded, CLV at the flagged price against the close, W-L. Toward 50: graded all time at the week's start → end, and the CLV t then and now. ${esc(d.rule?.text || '')} Units are 1u a graded line; * marks units on a kind that is not proven, which are not a profit claim.${s.quiet ? ` ${s.quiet} other kinds and venues had nothing graded this week.` : ''}</p>
${tags ? `<h2>Models and research (not a claim)</h2><div class="scroll"><table><thead><tr><th>Tool</th><th>Tag</th><th>Where and why</th></tr></thead><tbody>${tags}</tbody></table></div>` : ''}
<p><a class="go" href="/app?start=results">SEE THE FULL RECORD →</a></p>
</main>
<footer><div class="in"><nav><a href="/">Line Reaper</a><a href="/learn/how-the-record-works">How the record works</a><a href="/terms">Terms</a><a href="/responsible-gambling">Responsible gambling</a></nav>
<div>Line Reaper is an information service, not a sportsbook. It does not take bets. This page reports a record; it is not advice to bet. 21+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></div></footer>
</body>
</html>`;
}

module.exports = { build, weekOf, weekStart, weekId, weekName, validWeek, dueWeek, sendAt, pushText, renderPage, cut, startOf, SEND_HOUR_UTC, WEEK };
