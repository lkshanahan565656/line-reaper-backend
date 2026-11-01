// ─── THE VERIFIED-RECORD LEADERBOARD (/r) ──────────────────────────────────
// Published bettor records (pubrecord.js) ranked by one thing we can check:
// how the prices they logged compare with Pinnacle's own no-vig close at the
// same number. Each row is one bettor at one app or venue (never pooled, the
// same split the record page judges on). Only picks that reached us before
// their start count; a LATE pick (an imported history included) never does.
//
// The honest bits:
//   - a row is ranked only with BAR (50) picks graded against Pinnacle's close
//     in the slice shown. Under that it shows its count as "building" and no rank.
//   - the rank is by the low end of the 95% interval of the average CLV, not
//     the average itself, so a short lucky run can't top a long steady one.
//     Rows whose low ends round to the same 0.01% share a rank.
//   - the label is the record's own (its page's, all leagues and all time),
//     so a league or week picked after the fact never makes anyone "proven".
//   - no profit, units or stakes: the record page shows units, and only on a
//     proven kind.
//   - a bettor who took their record off the list (TAKE OFF THE LIST) is not
//     here; the caller passes listed records only.
const venues = require('./venues');

const WINDOWS = { '7d': { days: 7, name: 'Last 7 days' }, '30d': { days: 30, name: 'Last 30 days' }, all: { days: null, name: 'All time' } };
const Z95 = 1.959964;
const { r2OrNull: r2, r4OrNull: r4, escHtml: esc } = require('./mathutil');

// a league as one short code: 'basketball_nba' → NBA, 'ncaaf' → CFB
const LEAGUE_ALIAS = { NCAAF: 'CFB', NCAAB: 'CBB', NCAAM: 'CBB', CS: 'CS2', CSGO: 'CS2', LEAGUE: 'LOL', VALORANT: 'VAL' };
function leagueOf(x) {
  const s = String(x ?? '').trim();
  if (!s) return 'OTHER';
  const last = s.split(/[_/\s]+/).filter(Boolean).pop().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return LEAGUE_ALIAS[last] || last || 'OTHER';
}
const cleanLeague = x => (x == null || x === '' || String(x).toLowerCase() === 'all' ? null : leagueOf(x));
const cleanWindow = x => (WINDOWS[x] ? x : 'all');

// the 95% two-sided t value for df degrees of freedom (Cornish-Fisher; within
// 0.01 of the table from df 3 up)
function tCrit(df) {
  if (!(df >= 1)) return null;
  const z = Z95;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3);
}

// one row's numbers from its graded picks: [{ clv (%), fair, outcome }]
function stats(list) {
  const n = list.length;
  const xs = list.map(e => e.clv);
  const mean = n ? xs.reduce((a, x) => a + x, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : null;
  const se = sd != null && sd > 0 ? sd / Math.sqrt(n) : null;
  const tc = tCrit(n - 1);
  const graded = list.filter(e => e.outcome === 'win' || e.outcome === 'loss');
  const exp = graded.reduce((a, e) => a + e.fair, 0), vr = graded.reduce((a, e) => a + e.fair * (1 - e.fair), 0);
  const wins = graded.filter(e => e.outcome === 'win').length;
  return {
    n, clv: r2(mean), clvT: se ? r2(mean / se) : null, sd: r2(sd),
    ciLo: se && tc ? r2(mean - tc * se) : null, ciHi: se && tc ? r2(mean + tc * se) : null,
    beat: n ? r4(list.filter(e => e.clv > 0).length / n) : null,
    graded: graded.length, wins, expWins: r2(exp), shortZ: vr > 0 ? r2((wins - exp) / Math.sqrt(vr)) : null,
  };
}

// what the viewer's state makes of an app or venue (an esports key is '<venue>|es')
function stateTag(key, st) {
  if (!st) return null;
  const s = venues.statusOf(st, String(key).replace(/\|es$/, ''));
  return { status: s, text: s === 'yes' ? `${st}: yes` : s === 'no' ? `not in ${st}` : `${st}: check` };
}

// records: [{ handle, publishedAt, labels: { '<kind>:<key>': { label, why } }, entries: pubrecord.boardEntries() }]
// opts: { league, window: 7d | 30d | all, state, mine (only venues usable in that state), bar, now }
function build(records, { league = null, window = 'all', state = 'TX', mine = false, bar = 50, clvT = 2, now = Date.now() } = {}) {
  const lg = cleanLeague(league), win = cleanWindow(window), st = venues.stateOf(state) || null;
  const since = WINDOWS[win].days ? now - WINDOWS[win].days * 86400e3 : null;
  const inWindow = e => since == null || Date.parse(e.at) >= since;
  // the leagues offered: every league with a graded pick in the window
  const leagueCounts = new Map();
  for (const r of records) for (const e of r.entries) if (inWindow(e)) leagueCounts.set(e.league, (leagueCounts.get(e.league) || 0) + 1);
  const groups = new Map();
  for (const r of records) {
    for (const e of r.entries) {
      if (!inWindow(e) || (lg && e.league !== lg)) continue;
      const k = `${r.handle}|${e.kind}:${e.key}`;
      if (!groups.has(k)) groups.set(k, { r, e, list: [] });
      groups.get(k).list.push(e);
    }
  }
  let rows = [...groups.values()].map(({ r, e, list }) => {
    const s = stats(list);
    const own = r.labels?.[`${e.kind}:${e.key}`] || null;
    return { handle: r.handle, url: `/r/${r.handle}`, card: `/card/record-${r.handle}.png`, publishedAt: r.publishedAt || null,
      kind: e.kind, key: e.key, name: e.name, unit: e.unit, target: bar, ...s,
      ranked: s.n >= bar && s.ciLo != null, label: own?.label || 'not graded yet', why: own?.why || null,
      leagues: [...new Set(list.map(x => x.league))].sort(), state: stateTag(e.key, st) };
  });
  const hiddenByState = mine && st ? rows.filter(x => x.state?.status !== 'yes').length : 0;
  if (mine && st) rows = rows.filter(x => x.state?.status === 'yes');
  const ranked = rows.filter(x => x.ranked).sort((a, b) => b.ciLo - a.ciLo || b.n - a.n || a.handle.localeCompare(b.handle) || a.name.localeCompare(b.name));
  // standard competition ranking: rows tied on the low end share a rank (1, 1, 3)
  let prev = null, rank = 0;
  ranked.forEach((x, i) => { if (prev == null || x.ciLo !== prev) { rank = i + 1; prev = x.ciLo; } x.rank = rank; });
  for (const x of ranked) x.tied = ranked.filter(y => y.rank === x.rank).length > 1;
  const building = rows.filter(x => !x.ranked).sort((a, b) => b.n - a.n || a.handle.localeCompare(b.handle) || a.name.localeCompare(b.name)).map(x => ({ ...x, rank: null, tied: false }));
  return {
    at: new Date(now).toISOString(),
    filter: { league: lg, window: win, windowName: WINDOWS[win].name, state: st, mine: !!(mine && st) },
    leagues: [...leagueCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, n]) => ({ key, n })),
    windows: Object.entries(WINDOWS).map(([key, w]) => ({ key, name: w.name })),
    bar, records: records.length, ranked, building, hiddenByState,
    sortedBy: 'the low end of the 95% interval of the average CLV against Pinnacle\'s close',
    rule: `Ranked only with ${bar} picks logged before their start and graded against Pinnacle's own no-vig close at the pick's number, in the league and window shown. Ranked by the low end of the 95% interval of the average CLV, so a short lucky run can't top a long steady one; rows whose low ends match share a rank. Each bettor is judged one app or venue at a time, never pooled. Picks logged after the start (imported histories included) never count.`,
    labelNote: `The label is the record's own, from its page: all leagues and all time, never from the slice shown. Proven needs ${bar} graded, a CLV t of ${clvT} or more and results not running well under what the close expected. No profit, units or stakes here: a record shows units on its own page, and calls them a profit only on a proven kind.`,
    empty: !ranked.length && !building.length,
  };
}

// one handle's place on the default board (all leagues, all time): each of its
// rows, ranked or building, for the record page and the API
function placeOf(view, handle) {
  const mine = [...view.ranked, ...view.building].filter(x => x.handle === handle);
  return { handle, ranked: view.ranked.length, rows: mine.map(x => ({ name: x.name, unit: x.unit, n: x.n, target: x.target, rank: x.rank, tied: x.tied, clv: x.clv, ciLo: x.ciLo, ciHi: x.ciHi, clvT: x.clvT, label: x.label })) };
}

// the public body (API): no state tag text needed beyond status
function publicBody(view) {
  const row = x => ({ rank: x.rank, tied: x.tied, handle: x.handle, url: x.url, kind: x.kind, name: x.name, unit: x.unit, graded: x.n, target: x.target,
    clv: x.clv, ci95: x.ciLo == null ? null : [x.ciLo, x.ciHi], clvT: x.clvT, beat: x.beat, results: { graded: x.graded, wins: x.wins, expectedWins: x.expWins, shortfallZ: x.shortZ },
    label: x.label, leagues: x.leagues, ...(x.state ? { inState: x.state.status } : {}) });
  return { at: view.at, filter: view.filter, leagues: view.leagues, sortedBy: view.sortedBy, bar: view.bar, records: view.records,
    ranked: view.ranked.map(row), building: view.building.map(row), rule: view.rule, labelNote: view.labelNote,
    note: view.empty ? 'No published record has a pick logged before its start and graded against Pinnacle\'s close in this slice yet.' : null };
}

// ── the section on /r ──
const pc = (x, d = 2) => (x == null ? '—' : `${x > 0 ? '+' : ''}${Number(x).toFixed(d)}%`);
const share = x => (x == null ? '—' : `${Math.round(x * 100)}%`);
const TAG = { proven: 'pv', 'losing to the close': 'neg', building: 'bd' };
const cls = x => (x == null ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');

// the query a filter link keeps (defaults left out)
function qs(f, over = {}) {
  const o = { league: f.league, window: f.window === 'all' ? null : f.window, state: f.state && f.state !== 'TX' ? f.state : null, venues: f.mine ? 'mine' : null, ...over };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// states: [[code, name]]
function sectionHtml(view, { states = [] } = {}) {
  const v = view, f = v.filter;
  const label = l => `<span class="tag ${TAG[l] || ''}">${esc(l)}</span>`;
  const st = x => (x.state ? `<span class="sub st-${esc(x.state.status)}">${esc(x.state.text)}</span>` : '');
  const leagueOpts = [`<option value="">All leagues</option>`, ...v.leagues.map(l => `<option value="${esc(l.key)}"${l.key === f.league ? ' selected' : ''}>${esc(l.key)} (${l.n})</option>`),
    ...(f.league && !v.leagues.some(l => l.key === f.league) ? [`<option value="${esc(f.league)}" selected>${esc(f.league)} (0)</option>`] : [])].join('');
  const form = `<form class="st-pick lb-f" method="get" action="/r#board">
<label for="lbl">League</label><select id="lbl" name="league">${leagueOpts}</select>
<label for="lbw">Window</label><select id="lbw" name="window">${v.windows.map(w => `<option value="${esc(w.key)}"${w.key === f.window ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
${states.length ? `<label for="lbs">Betting from</label><select id="lbs" name="state">${states.map(([c, n]) => `<option value="${esc(c)}"${c === f.state ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
<label for="lbv">Venues</label><select id="lbv" name="venues"><option value="">Every app and venue</option><option value="mine"${f.mine ? ' selected' : ''}>Only ones I can use</option></select>` : ''}
<button type="submit">SHOW</button></form>`;
  const head = '<thead><tr><th>#</th><th>Bettor</th><th>App or venue</th><th>Graded vs Pinnacle</th><th>Avg CLV</th><th>95% interval</th><th>Label</th></tr></thead>';
  const rowHtml = x => `<tr><td>${x.rank == null ? '—' : `${x.tied ? '=' : ''}${x.rank}`}</td>`
    + `<td><a href="${esc(x.url)}">@${esc(x.handle)}</a><span class="sub">${esc(x.leagues.join(', '))}</span></td>`
    + `<td>${esc(x.name)}<span class="sub">${esc(x.unit)}</span>${st(x)}</td>`
    + `<td>${x.n} / ${x.target}${x.ranked ? '' : '<span class="sub">building: no rank under the bar</span>'}</td>`
    + `<td class="${cls(x.clv)}">${pc(x.clv)}<span class="sub">t ${x.clvT ?? '—'} · beat ${share(x.beat)}</span></td>`
    + `<td>${x.ciLo == null ? '—' : `${pc(x.ciLo)} to ${pc(x.ciHi)}`}</td>`
    + `<td>${label(x.label)}</td></tr>`;
  const ranked = v.ranked.length
    ? `<div class="scroll"><table class="lb">${head}<tbody>${v.ranked.map(rowHtml).join('')}</tbody></table></div>`
    : `<div class="ex"><div class="ex-h">Nobody ranked yet</div><p>No record has ${v.bar} picks graded against Pinnacle's close at one app or venue${f.league ? ` in ${esc(f.league)}` : ''}${f.window !== 'all' ? ` in the ${esc(f.windowName.toLowerCase())}` : ''}. Records building toward the bar are below.</p></div>`;
  const building = v.building.length
    ? `<h3>Building toward ${v.bar}</h3><p class="note">Not ranked: under ${v.bar} graded picks an average says little. Most graded first.</p><div class="scroll"><table class="lb">${head}<tbody>${v.building.map(rowHtml).join('')}</tbody></table></div>`
    : '';
  const empty = v.empty ? `<div class="ex"><div class="ex-h">Nothing graded in this slice</div><p>No published record has a pick logged before its start and graded against Pinnacle's close${f.league ? ` in ${esc(f.league)}` : ''}${f.window !== 'all' ? ` in the ${esc(f.windowName.toLowerCase())}` : ''} yet. Publish yours from MY SLIPS > PUBLISH RECORD and log picks before the games start.</p></div>` : '';
  return `<section id="board"><h2>Leaderboard: CLV against Pinnacle's close</h2>
<p class="note">Ranked by ${esc(v.sortedBy)}. ${esc(f.windowName)}${f.league ? `, ${esc(f.league)} only` : ', all leagues'}.${v.hiddenByState ? ` ${v.hiddenByState} row${v.hiddenByState === 1 ? '' : 's'} at apps or venues not confirmed for ${esc(f.state)} left out.` : ''}</p>
${form}
${empty || `${ranked}${building}`}
<p class="note">${esc(v.rule)} ${esc(v.labelNote)} <a href="/api/leaderboard${esc(qs(f))}">JSON</a> · <a href="/share/leaderboard${esc(qs({ league: f.league, window: f.window }))}">SHARE CARD</a></p>
</section>`;
}

const SECTION_CSS = `
.st-pick { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0 0 16px; font:500 12px var(--mono); color:var(--muted); }
.st-pick select, .st-pick button { background:var(--card); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px 8px; font:600 12px var(--mono); max-width:100%; min-width:0; }
.st-pick button { cursor:pointer; letter-spacing:1px; }
.lb-f { margin:0 0 12px; }
table.lb td:first-child { font-family:var(--mono); font-weight:700; }
.st-yes { color:var(--green2); } .st-no { color:#f87171; } .st-unknown { color:#f59e0b; }
section#board h3 { font:700 14px var(--mono); letter-spacing:.06em; text-transform:uppercase; margin:18px 0 6px; color:var(--text2); }
`;

// the app's My state, once, when the page was opened without a state in the link
const prefsScript = () => `<script>(function(){try{var u=new URL(location.href);if(u.searchParams.has('state')||sessionStorage.getItem('lr_board_prefs'))return;sessionStorage.setItem('lr_board_prefs','1');var s=localStorage.getItem('lr_state');if(s&&/^[A-Z]{2}$/.test(s)&&s!=='TX'){u.searchParams.set('state',s);location.replace(u.toString())}}catch(e){}})();</script>`;

module.exports = { build, placeOf, publicBody, sectionHtml, stats, tCrit, leagueOf, cleanLeague, cleanWindow, qs, WINDOWS, SECTION_CSS, prefsScript };
