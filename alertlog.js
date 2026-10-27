'use strict';
// ─── ALERT HISTORY: EVERY ALERT THE SITE SENT, GRADED LIKE RESULTS ───────────
// Each alert that goes out (webhook and phone push, push.withPush) is kept
// here as it was sent: the time, its title and push kind, its lines of text
// and how many webhooks and phones it reached. The same text went to
// everyone, so this is the whole alert record, not one person's view.
//
// Where an alert names a bet (EV alerts, exchange value, steam, line movers,
// esports edges)
// each bet is kept as an item with its venue, the price shown and the id of
// its row in the tracker that grades it. Nothing is graded here: grade()
// reads that tracker row at request time, with the same code RESULTS uses
// (evtrack.gradeOf, closeboard.closeOn, claims.publicRecord for the label),
// then prices the close at the alert's own price. So:
//
//   label        the label RESULTS gives that kind at that venue (only a
//                proven row reads PROVEN); exchange value is research
//   CLV          the close against the price the alert showed
//   Pinnacle     Pinnacle's own no-vig close at the alert's price, where the
//                tracker kept one and it was read within the hour before start
//   units        1u at the alert's price, a profit only where RESULTS shows one
//
// Alerts that name no single bet (arbs, middles, Sharp Tail, pick'em board
// moves, sharp moves) are listed with why they have no grade.
//
// Nothing is back-filled: alert sends were not stored before this module, so
// the history starts at the first boot with it (the 'started' doc). The store
// rides the results backup (append-only), so a deploy keeps it.
//
// Pure apart from createAlertLog's store calls; server.js does the reading.

const crypto = require('crypto');
const evtrack = require('./evtrack');
const closeboard = require('./closeboard');
const venues = require('./venues');

const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const american = d => (!(d > 1) ? null : d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

// links never go on the public page (in US mode no polymarket.com, and a link
// in an old alert can point anywhere by now)
const cleanLine = l => String(l || '').replace(/<(https?:\/\/[^\s>]+)>/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
const MAX_LINES = 12;

// why an alert of this title has no grade
const NO_GRADE = {
  'Sharp alerts': 'A move at Pinnacle and the books, not a price at one venue: nothing to grade.',
  'Tail alerts': 'Sharp Tail is research: it is graded when its market settles (SHARP TAIL record), not against Pinnacle\'s close.',
  'Board alerts': 'Sharp Tail is research: it is graded when its market settles (SHARP TAIL record), not against Pinnacle\'s close.',
  'Fresh wallet alerts': 'Sharp Tail is research: it is graded when its market settles (SHARP TAIL record), not against Pinnacle\'s close.',
  'Exchange arbs': 'An arb locks its price across venues when both sides fill: there is no close to beat.',
  'Exchange middles': 'A middle is priced on both sides at once: there is no single close to beat.',
  Alerts: 'A pick\'em board move: a pick\'em leg has no price of its own to grade here (the PROPS record grades legs).',
  'Gas locks': 'Gas price locks are research, not a sports bet.',
};
const noGradeWhy = title => NO_GRADE[title] || 'This alert names no single bet to grade.';

// ── items: the bets an alert names, as it showed them ──
// an EV screen row (ev.js) → item; DFS legs have no price of their own
function evItem(r) {
  const base = { book: r.book || null, sport: r.sport || null, event: r.event || null, market: r.market || null,
    pick: [r.player, r.side, r.point != null && !String(r.side || '').includes(String(r.point)) && r.market !== 'h2h' ? r.point : null].filter(x => x != null && x !== '').join(' ') || null,
    start: r.start || r.startTime || null, evPct: r2(r.ev) };
  if (r.dfs || !(r.decimal > 1)) return { ...base, tracker: null, ref: null, priceDecimal: null, priceAmerican: null, why: 'A pick\'em leg: no single price to grade here (the PROPS record grades legs).' };
  return { ...base, tracker: 'ev', ref: evtrack.betId(r), priceDecimal: r4(r.decimal), priceAmerican: r.price ?? american(r.decimal) };
}
// an exchange value edge or line mover (xvalue.js) → item, its row id as xvalue.trackRows makes it
function xvalueItem(e) {
  const cost = e.cost > 0 && e.cost < 1 ? e.cost : null;
  return { tracker: 'xvalue', ref: `${e.group}|${e.pick}|${e.venue}`, book: e.venue || null, sport: e.league || e.category || null, event: e.title || null,
    market: e.market || null, pick: e.pick || null, start: e.start || null, evPct: e.ev != null ? r2(e.ev * 100) : null,
    priceDecimal: cost ? r4(1 / cost) : null, priceAmerican: cost ? american(1 / cost) : null, costWithFee: cost ? r4(cost) : null };
}

// an esports board edge (esboard via server.js describeEsportsEdge) → item, its
// row id as esportsEdgeRows makes it (group match|market|venue, side outcome, book venue)
function esportsItem(m, e) {
  const cost = e.cost > 0 && e.cost < 1 ? e.cost : null;
  return { tracker: 'esports', ref: `${m.id}|${e.market}|${e.venue}|${e.outcome}|${e.venue}`, book: e.venue || null, sport: m.game || null, event: m.label || null,
    market: e.kind || e.market || null, pick: e.outcome || null, start: m.start || null, evPct: e.ev != null ? r2(e.ev * 100) : null,
    priceDecimal: cost ? r4(1 / cost) : null, priceAmerican: cost ? american(1 / cost) : null, costWithFee: cost ? r4(cost) : null };
}
// the trackers that close on their own fair (not on the strict record): what they close on and their label
const OWN_FAIR = {
  xvalue: { closeOn: 'the fair it was flagged on (Polymarket or a book), not Pinnacle', why: 'Exchange Shopper value is research: its record (RESULTS > OTHER RECORDS) is not on the strict rule.' },
  esports: { closeOn: "the other venues' fair at the start, not Pinnacle's own close", why: 'Esports exchange edges are research: their record (RESULTS > OTHER RECORDS) is not on the strict rule.' },
};

// ── the store ──
function createAlertLog({ store, now = () => Date.now(), log = console, maxItems = 10 } = {}) {
  let startedAt = null;
  const stats = { recorded: 0, failed: 0, lastAt: null, lastError: null };
  const ready = (async () => {
    await store.init();
    const docs = await store.all();
    const s = docs.find(d => d.id === 'started');
    if (s) startedAt = s.at;
    else {
      // the first boot with an alert log: the history starts here, and says so
      startedAt = new Date(now()).toISOString();
      await store.put({ id: 'started', type: 'meta', at: startedAt });
    }
  })();
  ready.catch(e => { stats.lastError = e.message; log.warn?.(`Alert log: ${e.message}`); });

  // one alert as sent: text (the lines everyone got), title, push kind,
  // reached { webhooks, phones }, items (bets it names)
  async function record({ text, title, kind = null, reached = {}, items = [] } = {}) {
    const lines = String(text || '').split('\n').map(cleanLine).filter(Boolean);
    if (!lines.length) return null;
    const at = new Date(now());
    const doc = {
      id: `a-${at.getTime().toString(36)}-${crypto.randomBytes(4).toString('hex')}`, type: 'alert', sentAt: at.toISOString(),
      title: String(title || 'Alerts').slice(0, 60), kind: kind || null,
      lines: lines.slice(0, MAX_LINES), more: Math.max(0, lines.length - MAX_LINES),
      reached: { webhooks: Number(reached.webhooks) || 0, phones: Number(reached.phones) || 0 },
      items: (Array.isArray(items) ? items : []).filter(Boolean).slice(0, maxItems),
    };
    try {
      await ready;
      await store.put(doc);
      stats.recorded++; stats.lastAt = doc.sentAt;
      return doc;
    } catch (e) {
      stats.failed++; stats.lastError = e.message;
      log.warn?.(`Alert log: ${e.message}`);
      return null;
    }
  }
  async function all() {
    await ready;
    return (await store.all()).filter(d => d.type === 'alert').sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
  }
  return { ready, record, all, startedAt: () => startedAt, stats: () => ({ ...stats, startedAt }) };
}

// ── grading: one item against its tracker row ──
// rows: { ev: Map(id → evTracker row), xvalue: Map(id → exchange value row) }
// labelOf(kind, book) → { label, why, profitShown } from the public record
const LABEL_NONE = 'no grade';
function gradeItem(it, { rows = {}, labelOf = () => null, now = Date.now() } = {}) {
  const started = it.start ? Date.parse(it.start) <= now : null;
  const out = { ...it, bookName: it.book ? venues.NAMES[it.book] || it.book : null, started, state: 'open', closeOn: null, closeProb: null, clvPct: null, beat: null,
    pinState: null, pinCloseProb: null, pinClvPct: null, result: null, units: null, label: LABEL_NONE, why: it.why || null, profitShown: false };
  if (!it.tracker) return out;
  const b = (rows[it.tracker] instanceof Map) ? rows[it.tracker].get(it.ref) : null;
  if (!b) return { ...out, state: started ? 'not tracked' : 'open', why: started ? 'Its tracker kept no row for this bet, so it has no close.' : null, label: started ? LABEL_NONE : 'not graded yet' };
  const d = it.priceDecimal;
  let g, kind, closeOn;
  if (it.tracker === 'ev') {
    g = evtrack.gradeOf(b);
    kind = b.source === 'consensus' ? 'ev-consensus' : 'ev';
    closeOn = closeboard.closeOn({ kind, book: b.book });
  } else {
    // exchange value and esports edges close on the fair they were flagged on, never on the strict record
    g = { state: evtrack.closeState(b), p: b.closeFair != null ? b.closeFair / 100 : null };
    kind = it.tracker;
    closeOn = OWN_FAIR[it.tracker]?.closeOn || 'its own fair, not Pinnacle';
  }
  const lab = it.tracker === 'ev' ? labelOf(kind, b.book) : { label: 'research', why: OWN_FAIR[it.tracker]?.why || 'Research: not on the strict rule.', profitShown: false };
  const state = g.state || 'open';
  const graded = state === 'ok' && g.p != null && d > 1;
  const clv = graded ? r2((g.p * d - 1) * 100) : null;
  // Pinnacle's own close at the alert's price, where it was kept and read near the start
  const pinOk = b.status === 'closed' && b.pinClose != null && b.pinCloseOk === true;
  const pinState = b.status !== 'closed' ? null : b.pinClose == null ? 'none kept' : b.pinCloseOk ? 'ok' : 'stale';
  const result = ['win', 'loss', 'push'].includes(b.outcome) ? b.outcome : b.status === 'void' ? 'void' : null;
  const units = graded && result && result !== 'void' && d > 1 ? evtrack.profitOf(result, d) : null;
  return {
    ...out, kind, state, closeOn, closeProb: graded ? r4(g.p) : null, clvPct: clv, beat: clv == null ? null : clv > 0,
    pinState, pinCloseProb: pinOk ? r4(b.pinClose / 100) : null, pinClvPct: pinOk && d > 1 ? r2((b.pinClose / 100 * d - 1) * 100) : null,
    result, units, label: lab ? lab.label : state === 'open' ? 'not graded yet' : LABEL_NONE,
    why: lab?.why || (state === 'stale' ? 'The close was read more than an hour before the start, so it is not graded.' : null),
    profitShown: !!lab?.profitShown,
  };
}

// a line of the summary: alerts, bets named, graded, CLV at the alert's price, beat, W-L, units
function sumOf(items) {
  const g = items.filter(i => i.clvPct != null);
  const p = items.filter(i => i.pinClvPct != null);
  const w = items.filter(i => i.result === 'win').length, l = items.filter(i => i.result === 'loss').length;
  const u = items.filter(i => i.units != null);
  const mean = a => (a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null);
  return { bets: items.length, open: items.filter(i => i.state === 'open').length, graded: g.length, avgClvPct: mean(g.map(i => i.clvPct)),
    beatPct: g.length ? r2(100 * g.filter(i => i.clvPct > 0).length / g.length) : null,
    pinGraded: p.length, avgPinClvPct: mean(p.map(i => i.pinClvPct)), wins: w, losses: l,
    units: u.length ? r2(u.reduce((s, i) => s + i.units, 0)) : null,
    // units are a profit only where every bet behind them is on a row RESULTS shows a profit for
    profitShown: u.length > 0 && u.every(i => i.profitShown) };
}

const LABEL_ORDER = ['proven', 'building', 'too early', 'losing to the close', 'research', 'copied book', 'no sharp close', 'not graded yet', LABEL_NONE];

// docs (newest first) → the public view. hidden: wallets withheld (licences.mentions)
// full: show the bets of alerts whose game has not started (subscribers);
// false: an alert stays a time and a title until every bet on it has started,
// or for a day when it names none (today's live alerts are what Pro pays for)
function view(docs, { rows = {}, labelOf = () => null, now = Date.now(), startedAt = null, full = true, days = 0, kind = null, limit = 100, before = null, hide = () => false } = {}) {
  const since = days > 0 ? now - days * 86400e3 : 0;
  const all = docs.filter(d => d.type === 'alert' && Date.parse(d.sentAt) >= since && (!kind || d.kind === kind) && !hide(d));
  const graded = all.map(d => {
    const items = (d.items || []).map(it => gradeItem(it, { rows, labelOf, now }));
    const open = items.length ? items.some(i => !i.started) : now - Date.parse(d.sentAt) < 86400e3;
    const top = items.length ? items.map(i => i.label).sort((a, b) => LABEL_ORDER.indexOf(a) - LABEL_ORDER.indexOf(b))[0] : LABEL_NONE;
    return { ...d, items, label: top, why: items.length ? null : noGradeWhy(d.title), open, masked: !full && open };
  });
  const flat = graded.flatMap(d => d.items);
  // per label (an alert counts under each label its bets carry) and per title
  const groups = keysOf => {
    const m = new Map();
    for (const d of graded) {
      for (const [k, items] of keysOf(d)) {
        if (!m.has(k)) m.set(k, { alerts: new Set(), items: [] });
        m.get(k).alerts.add(d.id);
        m.get(k).items.push(...items);
      }
    }
    return [...m];
  };
  const byLabel = groups(d => (d.items.length ? [...new Set(d.items.map(i => i.label))].map(l => [l, d.items.filter(i => i.label === l)]) : [[LABEL_NONE, []]]))
    .map(([label, v]) => ({ label, alerts: v.alerts.size, ...sumOf(v.items) }))
    .sort((a, b) => LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label));
  const byTitle = groups(d => [[d.title, d.items]]).map(([title, v]) => ({ title, alerts: v.alerts.size, why: v.items.length ? null : noGradeWhy(title), ...sumOf(v.items) }))
    .sort((a, b) => b.alerts - a.alerts);
  const cut = before ? graded.filter(d => String(d.sentAt) < String(before)) : graded;
  const page = cut.slice(0, Math.max(1, Math.min(500, limit))).map(d => (d.masked
    ? { id: d.id, sentAt: d.sentAt, title: d.title, kind: d.kind, reached: d.reached, masked: true, label: d.label, bets: d.items.length,
      lines: [], items: d.items.map(i => ({ book: i.book, bookName: i.bookName, sport: i.sport, start: i.start, started: i.started, state: i.state, label: i.label })) }
    : { id: d.id, sentAt: d.sentAt, title: d.title, kind: d.kind, reached: d.reached, masked: false, label: d.label, why: d.why, bets: d.items.length,
      lines: d.lines, more: d.more || 0, items: d.items }));
  return {
    at: new Date(now).toISOString(), startedAt,
    note: `Alerts are kept from ${startedAt ? startedAt.slice(0, 16).replace('T', ' ') + ' UTC' : 'the first boot with the alert log'}, when the site started storing them. Nothing before that is shown or rebuilt.`,
    rule: 'Each bet an alert named is graded by the tracker that records it, with the same code and label as RESULTS, which marks a kind proven only at a venue where it clears the rule. CLV is the close against the price the alert showed. Units are 1u at that price, a profit only where RESULTS shows one.',
    days: days > 0 ? days : null, kind: kind || null,
    summary: { alerts: graded.length, ...sumOf(flat), byLabel, byTitle },
    total: cut.length, shown: page.length, next: cut.length > page.length ? page[page.length - 1].sentAt : null,
    alerts: page,
  };
}

// ── the public page: /alerts ──
const LABEL_COLOR = { proven: '#34d399', building: '#fbbf24', 'too early': '#94a3b8', 'losing to the close': '#f87171', research: '#a78bfa', 'copied book': '#94a3b8', 'no sharp close': '#64748b', 'not graded yet': '#64748b', [LABEL_NONE]: '#64748b' };
function renderPage(v, { origin = '' } = {}) {
  const learn = require('./learn');
  const { esc } = learn;
  const o = String(origin).replace(/[^\w.:/-]/g, '').replace(/\/+$/, '');
  const pc = x => (x == null ? '—' : `${x > 0 ? '+' : ''}${Number(x).toFixed(1)}%`);
  const units = (u, shown) => (u == null ? '—' : shown ? `${u > 0 ? '+' : ''}${Number(u).toFixed(1)}u` : `<span class="muted" title="Not a profit claim">${u > 0 ? '+' : ''}${Number(u).toFixed(1)}u*</span>`);
  const lab = l => `<span class="lab" style="color:${LABEL_COLOR[l] || '#94a3b8'}">${esc(String(l).toUpperCase())}</span>`;
  const when = t => esc(String(t || '').slice(0, 16).replace('T', ' ')) + ' UTC';
  const s = v.summary;
  const res = r => (r ? esc(r.toUpperCase()) : '—');
  const itemRow = i => `<tr><td>${esc(i.pick || '—')}${i.bookName ? ` · ${esc(i.bookName)}` : ''}<div class="sub">${esc([String(i.sport || '').toUpperCase(), i.event].filter(Boolean).join(' · '))}</div>${lab(i.label)}</td>
<td class="n">${i.priceAmerican != null ? esc(i.priceAmerican > 0 ? `+${i.priceAmerican}` : String(i.priceAmerican)) : '—'}<div class="sub">${i.priceDecimal != null ? esc(Number(i.priceDecimal).toFixed(3)) : ''}</div></td>
<td class="n">${i.state === 'ok' ? pc(i.clvPct) : esc(i.state)}<div class="sub">Pinnacle ${i.pinClvPct != null ? pc(i.pinClvPct) : esc(i.pinState || '—')}</div></td>
<td class="n">${res(i.result)}<div class="sub">${units(i.units, i.profitShown)}</div></td></tr>`;
  const alertBlock = a => {
    const head = `<div class="ah"><b>${esc(a.title)}</b> <span class="sub">${when(a.sentAt)} · reached ${a.reached?.phones || 0} phone${a.reached?.phones === 1 ? '' : 's'}, ${a.reached?.webhooks || 0} webhook${a.reached?.webhooks === 1 ? '' : 's'}</span> ${lab(a.label)}</div>`;
    if (a.masked) return `<div class="alert">${head}<p class="sub">${a.bets ? `${a.bets} bet${a.bets === 1 ? '' : 's'}; shown once ${a.bets === 1 ? 'its game starts' : 'every game on it starts'}.` : 'Shown a day after it was sent.'} Live alerts are for subscribers.</p></div>`;
    const text = `<pre>${a.lines.map(esc).join('\n')}${a.more ? `\n…and ${a.more} more lines` : ''}</pre>`;
    const items = a.items.length ? `<div class="scroll"><table><thead><tr><th>Bet</th><th class="n">Price shown</th><th class="n">CLV</th><th class="n">Result</th></tr></thead><tbody>${a.items.map(itemRow).join('')}</tbody></table></div>`
      : `<p class="sub">${esc(a.why || '')}</p>`;
    return `<div class="alert">${head}${text}${items}</div>`;
  };
  const labRows = s.byLabel.map(r => `<tr><td>${lab(r.label)}</td><td class="n">${r.alerts}</td><td class="n">${r.bets}</td><td class="n">${r.graded}</td><td class="n">${pc(r.avgClvPct)}<div class="sub">beat ${r.beatPct == null ? '—' : Math.round(r.beatPct) + '%'}</div></td><td class="n">${r.wins + r.losses ? `${r.wins}-${r.losses}` : '—'}<div class="sub">${units(r.units, r.profitShown)}</div></td></tr>`).join('');
  const lead = `${s.alerts} alert${s.alerts === 1 ? '' : 's'} sent since ${v.startedAt ? v.startedAt.slice(0, 10) : 'storing began'}, ${s.graded} bet${s.graded === 1 ? '' : 's'} graded against the close.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alert history | Line Reaper</title>
<meta name="description" content="${esc(lead)}">
<meta property="og:title" content="Line Reaper alert history">
<meta property="og:description" content="${esc(lead)}">
${o ? `<meta property="og:image" content="${esc(o)}/card/alerts.png"><link rel="canonical" href="${esc(o)}/alerts">` : ''}
<meta name="theme-color" content="#080b10">
<link rel="icon" href="${learn.FAVICON}">
<style>${learn.CSS}
.lab { font:700 10px var(--mono); letter-spacing:.06em; white-space:nowrap; }
.sub { color:var(--muted); font-size:11px; }
td.n, th.n { text-align:right; white-space:nowrap; }
.muted { color:var(--muted); }
.alert { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin:0 0 10px; min-width:0; }
.alert pre { white-space:pre-wrap; word-break:break-word; font:12px/1.5 var(--mono); color:var(--text2); margin:6px 0; }
.ah { display:flex; flex-wrap:wrap; gap:6px; align-items:baseline; }
.tiles { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 18px; }
.tiles div { flex:1 1 140px; background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
.tiles span { display:block; font:600 10px var(--mono); letter-spacing:.1em; color:var(--muted); }
.tiles b { display:block; font-size:20px; margin:2px 0; }
.tiles i { font-style:normal; color:var(--text2); font-size:12px; }
</style>
</head>
<body>
<header class="top"><div class="top-in"><a class="brand" href="/">${learn.LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app?start=alerts">OPEN IN THE APP</a></div></header>
<main>
<p class="kicker">Alert history</p>
<h1>Every alert we sent, graded</h1>
<p class="lead">${esc(lead)} The same alert went to everyone: no per-person sizing.</p>
<p class="note">${esc(v.note)}</p>
<div class="tiles">
<div><span>ALERTS SENT</span><b>${s.alerts}</b><i>${s.bets} bet${s.bets === 1 ? '' : 's'} named</i></div>
<div><span>GRADED</span><b>${s.graded}</b><i>${s.open} still open</i></div>
<div><span>CLV AT THE ALERT'S PRICE</span><b>${esc(pc(s.avgClvPct))}</b><i>every label pooled: never a claim</i></div>
<div><span>VS PINNACLE'S OWN CLOSE</span><b>${esc(pc(s.avgPinClvPct))}</b><i>${s.pinGraded} with Pinnacle's close kept</i></div>
</div>
<h2>By label</h2>
${labRows ? `<div class="scroll"><table><thead><tr><th></th><th class="n">Alerts</th><th class="n">Bets</th><th class="n">Graded</th><th class="n">CLV</th><th class="n">W-L</th></tr></thead><tbody>${labRows}</tbody></table></div>` : '<p class="note">No alert has been sent since storing began.</p>'}
<p class="note">${esc(v.rule)} * marks units that are not a profit claim.</p>
<h2>Alerts, newest first</h2>
${v.alerts.length ? v.alerts.map(alertBlock).join('\n') : '<p class="note">No alert has been sent since storing began. The first one will show here.</p>'}
${v.next ? `<p><a class="go" href="/alerts?before=${encodeURIComponent(v.next)}">OLDER ALERTS →</a></p>` : ''}
<p><a class="go" href="/api/alerts/history">DOWNLOAD JSON</a> <a class="go" href="/app?start=results">SEE THE FULL RECORD →</a></p>
</main>
<footer><div class="in"><nav><a href="/">Line Reaper</a><a href="/pricing">Pricing</a><a href="/learn/how-the-record-works">How the record works</a><a href="/terms">Terms</a><a href="/responsible-gambling">Responsible gambling</a></nav>
<div>Line Reaper is an information service, not a sportsbook. It does not take bets. This page reports what was sent; it is not advice to bet. 21+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></div></footer>
</body>
</html>`;
}

module.exports = { createAlertLog, evItem, xvalueItem, esportsItem, OWN_FAIR, gradeItem, view, renderPage, noGradeWhy, cleanLine, LABEL_NONE, NO_GRADE };
