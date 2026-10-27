// ─── EMBEDDABLE WIDGETS AND THE /developers PAGE ─────────────────────────────
// Three widgets anyone can put on a page, as an iframe or through /embed.js:
//   /embed/best-price   the best price above the fair (one to five rows)
//   /embed/line-move    one game's line chart (default: today's biggest move)
//   /embed/record       the proven-record card
// Each wears the same label the app gives it (PROVEN only where RESULTS proves
// it, LEAD or "information, not an edge" otherwise), says when it was read and
// links back to the site. They read the same shapes as /api/v1 (publicapi.js),
// so a widget never says more than the API, and the API never more than RESULTS.
// Pure renderers: the server hands in the data.

const learn = require('./learn');
const oddsFmt = require('./oddsfmt');
const { esc } = learn;

const VENUE_COLOR = { pinnacle: '#94a3b8', fanduel: '#3b82f6', betrivers: '#f59e0b', kalshi: '#10b981', polymarketus: '#a78bfa', gemini: '#22d3ee', matchbook: '#f472b6',
  draftkings: '#84cc16', betmgm: '#eab308', caesars: '#fb923c', bet365: '#4ade80', fanatics: '#ef4444', hardrock: '#c084fc', thescore: '#60a5fa' };
const colorOf = v => VENUE_COLOR[v] || '#64748b';
const cleanOrigin = o => String(o || '').replace(/[^\w.:/-]/g, '').replace(/\/+$/, '');
// American odds in the widget's format (data-odds: american, decimal, fractional or probability)
const am = (a, fmt = 'american') => (a == null || !Number.isFinite(Number(a)) ? '—' : oddsFmt.fromAm(Number(a), fmt));
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(d)}%`);
const hhmm = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(11, 16)} UTC` : '—'; };
const when = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(5, 10).replace('-', '/')} ${d.toISOString().slice(11, 16)} UTC` : ''; };
const usd = n => `$${Math.round(n).toLocaleString('en-US')}`;
const impliedOf = a => (a == null || !Number.isFinite(a) || a === 0 ? null : a > 0 ? 100 / (a + 100) : -a / (-a + 100));

const WIDGET_CSS = `
:root { --bg:#080b10; --card:#0d121b; --border:#1e2738; --text:#e2e8f0; --text2:#94a3b8; --muted:#64748b; --green:#10b981; --green2:#34d399; --amber:#f59e0b; --mono:'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; color-scheme:dark; }
* { box-sizing:border-box; }
html, body { margin:0; background:var(--bg); color:var(--text); font:13px/1.45 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
.w { border:1px solid var(--border); border-radius:8px; background:var(--card); padding:10px 12px; min-width:0; overflow:hidden; }
.hd { display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin:0 0 6px; }
.hd b { font:700 10px var(--mono); letter-spacing:.12em; text-transform:uppercase; color:var(--green2); }
.hd i { font:500 10px var(--mono); font-style:normal; color:var(--muted); white-space:nowrap; }
.row { border-top:1px solid var(--border); padding:7px 0; min-width:0; }
.row:first-of-type { border-top:0; }
.ev { font-weight:600; overflow-wrap:anywhere; }
.sub { color:var(--text2); font-size:12px; overflow-wrap:anywhere; }
.nums { display:flex; flex-wrap:wrap; gap:4px 12px; font:500 12px var(--mono); font-variant-numeric:tabular-nums; margin-top:3px; }
.nums span { white-space:nowrap; }
.nums em { font-style:normal; color:var(--muted); font-size:10px; letter-spacing:.06em; margin-right:3px; }
.tag { display:inline-block; font:700 9px var(--mono); letter-spacing:.08em; padding:1px 5px; border-radius:3px; border:1px solid var(--border); color:var(--text2); vertical-align:1px; }
.tag.pv { color:var(--green2); border-color:rgba(52,211,153,.5); }
.tag.ld { color:var(--amber); border-color:rgba(245,158,11,.45); }
.pos { color:var(--green2); }
.note { color:var(--muted); font-size:11px; margin:6px 0 0; overflow-wrap:anywhere; }
.ft { display:flex; justify-content:space-between; align-items:center; gap:8px; border-top:1px solid var(--border); margin-top:8px; padding-top:6px; }
.ft a { font:700 10px var(--mono); letter-spacing:.12em; color:var(--green2); text-decoration:none; white-space:nowrap; }
.ft span { font-size:10px; color:var(--muted); overflow-wrap:anywhere; }
.empty { color:var(--text2); padding:8px 0; }
svg { display:block; width:100%; height:auto; }
.legend { display:flex; flex-wrap:wrap; gap:4px 10px; font:500 10px var(--mono); color:var(--text2); margin-top:4px; }
.legend i { display:inline-block; width:10px; height:3px; border-radius:2px; margin-right:4px; vertical-align:2px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(110px, 1fr)); gap:6px 12px; margin-top:4px; }
.grid div { min-width:0; }
.grid em { display:block; font:600 9px var(--mono); font-style:normal; letter-spacing:.1em; color:var(--muted); text-transform:uppercase; }
.grid b { font:600 15px var(--mono); font-variant-numeric:tabular-nums; }
`;

// the iframe page around a widget: dark, one card, a link home, and a height
// message for /embed.js (only a number goes out)
function shell({ title, body, id, refresh = 60 }) {
  const safeId = String(id || '').replace(/[^\w-]/g, '').slice(0, 40);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${esc(title)} | Line Reaper</title>
<style>${WIDGET_CSS}</style>
</head>
<body>
${body}
<script>(function(){var id=${JSON.stringify(safeId)};function send(){try{parent.postMessage({lrEmbed:id,height:Math.ceil(document.documentElement.getBoundingClientRect().height)},'*')}catch(e){}}if(id){send();window.addEventListener('load',send);window.addEventListener('resize',send)}})();</script>
</body>
</html>`;
}
const footer = (origin, link, label, extra = '') => `<div class="ft"><span>${extra}</span><a href="${esc(cleanOrigin(origin) + link)}" target="_blank" rel="noopener">${esc(label)} ↗</a></div>`;

function fillText(f) {
  if (!f) return '';
  if (f.status === 'read') return f.fillsUsd ? `fills ${usd(f.fillsUsd)}` : `only ${usd(f.depthUsd || 0)} on the book`;
  if (f.status === 'empty') return 'nothing on the book';
  if (f.status === 'not published') return 'limit not published';
  return 'size not read';
}

// rows: publicapi.bestPrices(); ctx: { league, at, locked, origin, id }
function bestPriceWidget(rows, { league = null, at = null, locked = false, origin = '', id = '', stale = false, fmt = 'american' } = {}) {
  const head = `<div class="hd"><b>Best price above fair${league ? ` · ${esc(String(league).toUpperCase())}` : ''}</b><i>${at ? `read ${esc(hhmm(at))}` : ''}</i></div>`;
  let list;
  if (locked) list = '<div class="empty">Fair prices and EV are for subscribers right now, so this widget has nothing to show.</div>';
  else if (stale) list = '<div class="empty">The price feeds have not read in the last few minutes, so nothing is shown rather than an old price.</div>';
  else if (!rows.length) list = `<div class="empty">No price sits above the fair${league ? ` in ${esc(String(league).toUpperCase())}` : ''} right now. That is the usual state of an efficient market.</div>`;
  else {
    list = rows.map(r => `<div class="row">
<div class="ev">${esc(r.selection)} <span class="tag ${r.label === 'proven' ? 'pv' : 'ld'}" title="${esc(r.labelText)}">${r.label === 'proven' ? 'PROVEN VENUE' : 'LEAD'}</span></div>
<div class="sub">${esc(r.event)} · ${esc(r.marketName || r.marketType)} · ${esc(when(r.start))}</div>
<div class="nums"><span><em>${esc(r.venueName)}</em>${esc(am(r.price.american, fmt))}</span><span><em>FAIR</em>${esc(am(r.fair.american, fmt))}</span><span class="pos"><em>EV</em>${esc(pct(r.evPct))}</span><span><em>SIZE</em>${esc(fillText(r.fill))}</span>${r.secondBest ? `<span><em>NEXT</em>${esc(r.secondBest.venueName)} ${esc(am(r.secondBest.american, fmt))}</span>` : ''}</div>
</div>`).join('');
  }
  const note = '<p class="note">EV is after the venue\'s fee, against Pinnacle\'s no-vig fair. LEAD means research: prices above the fair have not beaten the close at that venue yet. Check the price at the venue before you bet.</p>';
  return shell({ title: 'Best price', id, body: `<div class="w">${head}${list}${note}${footer(origin, '/app?start=odds', 'LINE REAPER', 'Not a bet slip; nothing here places a bet.')}</div>` });
}

// the line chart: each venue's implied chance for one side, and the fair
// series: publicapi.historySeries() of one game (all markets); pick: { market, sideIndex }
function chartSvg(points, { w = 420, h = 210, withFair = true } = {}) {
  const venues = [...new Set(points.flatMap(p => Object.keys(p.prices || {})))];
  const lines = venues.map(v => ({ v, pts: points.map(p => [Date.parse(p.t), impliedOf(p.prices?.[v])]).filter(([, y]) => y != null) })).filter(l => l.pts.length);
  const fair = withFair ? points.map(p => [Date.parse(p.t), p.fair]).filter(([, y]) => y != null) : [];
  const all = [...lines.flatMap(l => l.pts), ...fair];
  if (new Set(all.map(p => p[0])).size < 2) return null;
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x1 - x0 < 60e3) x1 = x0 + 60e3;
  let y0 = Math.min(...ys), y1 = Math.max(...ys); const pad = Math.max(0.01, (y1 - y0) * 0.15); y0 = Math.max(0, y0 - pad); y1 = Math.min(1, y1 + pad);
  const L = 40, R = 8, T = 8, B = 22;
  const X = t => L + ((t - x0) / (x1 - x0)) * (w - L - R), Y = y => T + (1 - (y - y0) / (y1 - y0)) * (h - T - B);
  // a step line: a price holds until the next read
  const path = pts => pts.map(([t, y], i) => `${i ? `H${X(t).toFixed(1)}V` : `M${X(t).toFixed(1)},`}${Y(y).toFixed(1)}`).join('') + `H${X(x1).toFixed(1)}`;
  const ticks = [0, 0.5, 1].map(f => y0 + f * (y1 - y0));
  const xt = [x0, (x0 + x1) / 2, x1];
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Implied win chance at each venue over time">
${ticks.map(v => `<line x1="${L}" x2="${w - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="#1e2738"/><text x="${L - 4}" y="${(Y(v) + 3).toFixed(1)}" fill="#64748b" font-size="10" text-anchor="end" font-family="monospace">${(v * 100).toFixed(1)}%</text>`).join('')}
${xt.map((t, i) => `<text x="${X(t).toFixed(1)}" y="${h - 6}" fill="#64748b" font-size="10" text-anchor="${['start', 'middle', 'end'][i]}" font-family="monospace">${new Date(t).toISOString().slice(11, 16)}</text>`).join('')}
${fair.length ? `<path d="${path(fair)}" fill="none" stroke="#e2e8f0" stroke-width="1.5" stroke-dasharray="4 3"/>` : ''}
${lines.map(l => `<path d="${path(l.pts)}" fill="none" stroke="${colorOf(l.v)}" stroke-width="2"/>`).join('')}
</svg>`;
}
function lineMoveWidget({ game = null, series = [], market = null, sideIndex = 0, withFair = true, origin = '', id = '', venueName = v => v, fmt = 'american' } = {}) {
  const head = t => `<div class="hd"><b>Line move</b><i>${t}</i></div>`;
  const note = '<p class="note">Each venue\'s implied chance for this side as read, a step at each change; dashed is Pinnacle\'s no-vig fair. A move is information, not a proven edge.</p>';
  const foot = footer(origin, '/app?start=odds', 'LINE REAPER', 'History is kept until 6 hours after the start.');
  const markets = [...new Set(series.map(s => s.market))];
  const mk = markets.includes(market) ? market : markets.includes('ml') ? 'ml' : markets[0];
  const sides = series.filter(s => s.market === mk);
  const s = sides[Math.min(Math.max(0, sideIndex), Math.max(0, sides.length - 1))];
  if (!game || !s) return shell({ title: 'Line move', id, body: `<div class="w">${head('')}<div class="empty">${game ? 'No saved prices for this game yet: points are saved every few minutes from when a game first shows up.' : 'No game to chart: the game has started more than 6 hours ago, or no game is on the board right now.'}</div>${note}${foot}</div>` });
  const svg = chartSvg(s.points, { withFair });
  const venues = [...new Set(s.points.flatMap(p => Object.keys(p.prices || {})))];
  const last = s.points[s.points.length - 1];
  const legend = `<div class="legend">${venues.map(v => `<span><i style="background:${colorOf(v)}"></i>${esc(venueName(v))} ${esc(am(last?.prices?.[v], fmt))}</span>`).join('')}${withFair && last?.fair != null ? `<span><i style="background:#e2e8f0"></i>FAIR ${esc((last.fair * 100).toFixed(1))}%</span>` : ''}</div>`;
  const body = `<div class="w">${head(last ? `read ${esc(hhmm(last.t))}` : '')}
<div class="ev">${esc(game.event)}</div>
<div class="sub">${esc(game.leagueLabel || '')} · ${esc({ ml: 'Moneyline', spread: 'Spread', total: 'Total' }[mk] || mk)} · ${esc(s.side)}${s.points.some(p => p.point != null) && mk !== 'ml' ? ` (now ${esc(last.point)})` : ''} · starts ${esc(when(game.start))}</div>
${svg || '<div class="empty">Only one point saved so far: the chart starts with the second.</div>'}${svg ? legend : ''}${note}${foot}</div>`;
  return shell({ title: 'Line move', id, body });
}

// card: publicapi.recordCard()
function recordWidget(card, { origin = '', id = '' } = {}) {
  const head = `<div class="hd"><b>Line Reaper record</b><i>${card.at ? `read ${esc(hhmm(card.at))}` : ''}</i></div>`;
  let list;
  if (!card.proven.length) list = '<div class="empty">Nothing is proven yet on the strict rule. Every kind is still building, research, or losing to the close.</div>';
  else {
    list = card.proven.map(r => `<div class="row">
<div class="ev">${esc(r.venueName)} ${esc(r.kindLabel || r.kind)} <span class="tag pv">PROVEN</span>${r.texas ? '' : ' <span class="tag">NOT IN TEXAS</span>'}</div>
<div class="grid"><div><em>Graded</em><b>${r.graded}</b></div><div><em>CLV vs close</em><b class="pos">${esc(pct(r.clvPct))}</b></div><div><em>Beat close</em><b>${r.beatPct == null ? '—' : `${Math.round(r.beatPct)}%`}</b></div><div><em>Won-lost</em><b>${r.wins}-${r.losses}</b></div>
<div><em>Profit</em><b>${r.profitShown && r.units != null ? `${r.units > 0 ? '+' : ''}${r.units.toFixed(1)}u` : '—'}</b></div></div>
${r.profitShown ? '' : '<div class="sub">Profit not shown: results have not cleared chance yet. Proven here means it beats Pinnacle\'s closing price, not that it has made money.</div>'}
</div>`).join('');
  }
  const rest = `<p class="note">${card.notProven} other kind${card.notProven === 1 ? '' : 's'} on the record ${card.notProven === 1 ? 'is' : 'are'} not proven (${card.building} building, ${card.losing} losing to the close). The rule: 50 graded at one venue we read ourselves and a CLV t of 2 or more against Pinnacle's close, never pooled.</p>`;
  return shell({ title: 'Record', id, body: `<div class="w">${head}${list}${rest}${footer(origin, '/app?start=results', 'FULL RECORD', 'Every flag is downloadable on RESULTS.')}</div>` });
}

// the loader: <script src="…/embed.js" async></script> then
// <div data-line-reaper="best-price|line-move|record" data-league="nfl"></div>
function embedScript(origin) {
  const o = cleanOrigin(origin);
  return `/* Line Reaper widgets: ${o}/developers#widgets */
(function () {
  var base = ${JSON.stringify(o)};
  var KINDS = { 'best-price': 220, 'line-move': 330, 'record': 230 };
  var ATTRS = ['league', 'market', 'venue', 'n', 'game', 'side', 'state', 'odds'];
  function mount(el) {
    if (el.getAttribute('data-lr-mounted')) return;
    var kind = el.getAttribute('data-line-reaper');
    if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) return;
    el.setAttribute('data-lr-mounted', '1');
    var q = [];
    for (var i = 0; i < ATTRS.length; i++) { var v = el.getAttribute('data-' + ATTRS[i]); if (v) q.push(ATTRS[i] + '=' + encodeURIComponent(v)); }
    var id = 'lr' + Math.random().toString(36).slice(2, 10);
    q.push('_id=' + id);
    var f = document.createElement('iframe');
    f.src = base + '/embed/' + kind + '?' + q.join('&');
    f.title = 'Line Reaper ' + kind.replace('-', ' ');
    f.loading = 'lazy';
    f.setAttribute('data-lr-id', id);
    f.style.cssText = 'display:block;width:100%;max-width:100%;border:0;background:#080b10;color-scheme:dark;height:' + KINDS[kind] + 'px';
    el.appendChild(f);
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== base || !e.data || typeof e.data.lrEmbed !== 'string') return;
    var f = document.querySelector('iframe[data-lr-id="' + e.data.lrEmbed.replace(/[^\\w-]/g, '') + '"]');
    var h = Number(e.data.height);
    if (f && h > 40 && h < 4000) f.style.height = h + 'px';
  });
  function all() { var els = document.querySelectorAll('[data-line-reaper]'); for (var i = 0; i < els.length; i++) mount(els[i]); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', all); else all();
})();
`;
}

// ── /developers ──
const DEV_CSS = `
main { max-width:900px; }
.top-in { max-width:900px; }
pre { background:#05070b; border:1px solid var(--border); border-radius:8px; padding:10px 12px; overflow:auto; max-width:100%; max-height:340px; font:12px/1.5 var(--mono); color:#cbd5e1; margin:0 0 12px; white-space:pre; }
code { font:13px var(--mono); color:#cbd5e1; overflow-wrap:anywhere; }
.ep { border:1px solid var(--border); border-radius:10px; background:var(--card); padding:12px 14px; margin:0 0 16px; min-width:0; }
.ep h3 { margin:0 0 4px; font-size:16px; }
.ep .path { font:600 13px var(--mono); color:var(--green2); overflow-wrap:anywhere; margin:0 0 6px; }
.ep table td:first-child { font-family:var(--mono); font-size:12px; white-space:nowrap; }
.ep table td { overflow-wrap:anywhere; }
.btn { font:600 12px var(--mono); letter-spacing:.06em; color:var(--green2); background:transparent; border:1px solid rgba(52,211,153,.4); border-radius:6px; padding:8px 14px; cursor:pointer; }
.btn:hover { border-color:var(--green2); }
.btn.warn { color:#fca5a5; border-color:rgba(252,165,165,.4); }
a.btn { display:inline-block; text-decoration:none; }
.keybox { border:1px solid var(--border); border-radius:10px; background:var(--card); padding:14px 16px; margin:0 0 18px; }
.keybox input { width:100%; max-width:320px; background:#05070b; color:var(--text); border:1px solid var(--border2); border-radius:6px; padding:8px 10px; font:14px var(--mono); }
.keybox label { display:block; font:600 10px var(--mono); letter-spacing:.1em; color:var(--muted); text-transform:uppercase; margin:0 0 4px; }
.keyout { font:600 13px var(--mono); color:var(--text); background:#05070b; border:1px dashed var(--green); border-radius:6px; padding:8px 10px; overflow-wrap:anywhere; margin:8px 0; }
.msg { font-size:13px; color:var(--text2); margin:8px 0 0; }
.msg.err { color:#fca5a5; }
.row2 { display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; }
.wg { border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin:0 0 18px; min-width:0; }
.wg iframe { display:block; width:100%; border:0; background:#080b10; margin:0 0 10px; }
.rules li { color:var(--text2); }
.h3s { font:600 11px var(--mono); letter-spacing:.1em; color:var(--muted); text-transform:uppercase; margin:10px 0 4px; overflow-wrap:anywhere; }
.h3s code { text-transform:none; letter-spacing:0; font-size:11px; }
`;
function developersPage({ origin = '', endpoints = [], examples = {}, limits, widgetLimit, keyCreate, licences = null, planLimits = null } = {}) {
  const o = cleanOrigin(origin);
  const exampleOf = p => {
    const ex = examples[p];
    if (!ex) return '<p class="note">No live example: this endpoint needs a value from another (an id or a week).</p>';
    return `<div class="h3s">Live example: <code>GET ${esc(ex.url)}</code>, read ${esc(hhmm(ex.at))}</div><pre data-ex="${esc(p)}">${esc(JSON.stringify(ex.body, null, 2))}</pre>`;
  };
  const eps = endpoints.map(e => `<section class="ep" id="ep-${esc(e.path.replace(/[^\w]+/g, '-'))}">
<h3>${esc(e.title)}</h3>
<div class="path">GET ${esc(e.path)}</div>
<p style="color:var(--text2);font-size:14px">${esc(e.about)}</p>
${e.params.length ? `<div class="scroll"><table><thead><tr><th>Parameter</th><th>What it does</th></tr></thead><tbody>${e.params.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div>` : ''}
${exampleOf(e.path)}
${examples[e.path] ? `<button class="btn" type="button" data-try="${esc(examples[e.path].url)}">TRY IT WITH YOUR KEY</button> <span class="msg" data-try-msg></span>` : ''}
</section>`).join('');
  const snippet = (kind, attrs) => `<script src="${o}/embed.js" async></script>\n<div data-line-reaper="${kind}"${attrs}></div>`;
  const frame = (kind, q, h) => `<iframe src="${o}/embed/${kind}${q}" title="Line Reaper ${kind.replace('-', ' ')}" style="width:100%;height:${h}px;border:0" loading="lazy"></iframe>`;
  const widget = (kind, title, about, attrs, q, h) => `<div class="wg"><h3 style="margin:0 0 6px">${esc(title)}</h3><p style="color:var(--text2);font-size:14px">${esc(about)}</p>
<iframe src="/embed/${kind}${q}${q ? '&' : '?'}_id=pv-${kind}" data-lr-id="pv-${kind}" title="${esc(title)} preview" style="height:${h}px" loading="lazy"></iframe>
<div class="h3s">With the script (sizes itself)</div><pre>${esc(snippet(kind, attrs))}</pre><button class="btn" type="button" data-copy="${esc(snippet(kind, attrs))}">COPY</button>
<div class="h3s" style="margin-top:12px">As a plain iframe</div><pre>${esc(frame(kind, q, h))}</pre><button class="btn" type="button" data-copy="${esc(frame(kind, q, h))}">COPY</button></div>`;
  const lic = licences && licences.kalshi === false ? '<li>Kalshi prices are left out of the API and widgets until Kalshi gives written permission to show its data to other people; Polymarket the same.</li>' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Developers: public API and widgets | Line Reaper</title>
<meta name="description" content="Line Reaper's read-only JSON API and embeddable widgets: best prices above the fair, line moves, the public record, league boards and feed status.">
${o ? `<link rel="canonical" href="${esc(o)}/developers">` : ''}
<meta name="theme-color" content="#080b10">
<link rel="icon" href="${learn.FAVICON}">
<style>${learn.CSS}${DEV_CSS}</style>
</head>
<body>
<header class="top"><div class="top-in"><a class="brand" href="/">${learn.LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app">OPEN THE APP</a></div></header>
<main>
<p class="kicker">Developers</p>
<h1>Public API and widgets</h1>
<p class="lead">The same numbers the app shows, as JSON and as widgets for your own page: best prices above the fair, line moves, the public record, league boards and feed status. Read-only, and the same for everyone.</p>
<ul class="rules">
<li>Nothing here places a bet, and nothing is sized or set up per person: every caller gets the same data.</li>
<li>Every row carries the label the app gives it. PROVEN appears only where RESULTS proves it (50 graded at one venue, CLV t of 2 against Pinnacle's close); everything else is a LEAD or research.</li>
<li>Prices are what each feed showed at its last read. Check the price at the venue before you bet.</li>
${lic}</ul>

<h2 id="key">Get a key</h2>
<div class="keybox">
<form id="mk" class="row2" autocomplete="off"><div style="flex:1 1 220px;min-width:0"><label for="kname">Name it (for you; kept with the key)</label><input id="kname" name="name" maxlength="40" placeholder="my site"></div><button class="btn" type="submit">MAKE A KEY</button></form>
<div id="mkOut" class="msg">One key is enough for a site. It is shown once: copy it somewhere safe. We keep only a hash of it.</div>
<div id="mine" style="display:none;margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
<div class="h3s">The key saved in this browser</div>
<div id="mineInfo" class="msg"></div>
<div class="row2" style="margin-top:8px"><button class="btn" type="button" id="mineUse">CHECK USAGE</button><button class="btn warn" type="button" id="mineRevoke">REVOKE THIS KEY</button><button class="btn" type="button" id="mineForget">FORGET IT HERE</button></div>
</div>
</div>

<h2 id="auth">Using it</h2>
<p>Send the key in an <code>X-API-Key</code> header (or as <code>?key=</code> where a header is awkward). Any site may call it from a browser: CORS is open to every origin.</p>
<pre>curl -H "X-API-Key: lr_…" ${esc(o)}/api/v1/best-prices?league=nfl</pre>
<ul>
<li><b>Limits:</b> ${planLimits ? `Pro keys ${planLimits.pro.apiPerMinute} calls a minute and ${planLimits.pro.apiPerDay.toLocaleString('en-US')} a day (UTC); Free keys ${planLimits.free.apiPerMinute} a minute and ${planLimits.free.apiPerDay.toLocaleString('en-US')} a day. A key takes the plan of the account it was made from (<a href="/pricing">plans</a>)` : `${limits.perMinute} calls a minute and ${limits.perDay.toLocaleString('en-US')} a day (UTC) per key`}. Every answer says where you are in <code>X-RateLimit-Remaining</code>, <code>X-RateLimit-Reset</code> (seconds) and <code>X-RateLimit-Daily-Remaining</code>. Over the limit is a 429 with <code>Retry-After</code>. Counts restart when the server redeploys.</li>
<li id="lines"><b>Line history:</b> every market's prices at each venue we read, Pinnacle included, kept 30 days after the start, as JSON or CSV (<code>?format=csv</code>) from <code>/api/v1/lines</code>. ${planLimits ? `Pro keys read all ${planLimits.pro.historyDays} days; Free keys the last ${planLimits.free.historyDays}.` : 'Every key reads all 30 days.'} The same charts are public at <a href="/lines">/lines</a>.</li>
<li><b>Caching:</b> each answer has an <code>ETag</code>. Send it back in <code>If-None-Match</code> and an unchanged answer is a 304 with no body. Most data changes about once a minute.</li>
<li><b>Errors</b> are JSON: <code>{"error":{"code":"…","message":"…"}}</code> with 400 (bad parameter), 401 (no key or an unknown one), 404 and 429.</li>
<li><b>New keys:</b> at most ${keyCreate.perHour} an hour from one address.</li>
<li><b>Versioning:</b> fields may be added to v1; none are renamed or removed. A change that would break a caller becomes v2.</li>
<li><b>Widgets</b> need no key and allow ${widgetLimit} loads a minute per visitor address.</li>
</ul>

<h2 id="endpoints">Endpoints</h2>
<p class="note">Every example below is the live answer at the time this page was built, cut to its first rows.</p>
${eps}

<h2 id="feed">Discord feed</h2>
<p>Run a Discord server? Paste a webhook and your channel gets the same public posts as everyone else, each with its share card: the weekly record digest (Mondays 13:00 UTC), record changes on RESULTS (a kind newly proven, no longer proven, losing to the close, or reaching 50 graded; checked hourly), and today's biggest line moves (daily 21:00 UTC).</p>
<ol class="steps">
<li>In Discord: <b>Server Settings &gt; Integrations &gt; Webhooks &gt; New Webhook</b>. Pick the channel, then <b>Copy Webhook URL</b>. You need the Manage Webhooks permission.</li>
<li>Make a key above (it is saved in this browser), paste the URL below and tap <b>CONNECT</b>. A welcome post lands in the channel straight away.</li>
<li>To stop: tap <b>DISCONNECT</b>, revoke the key, or delete the webhook in Discord.</li>
</ol>
<ul class="rules">
<li>Every channel gets the same posts. Nothing is sized, picked or set up per person, and nothing places a bet.</li>
<li>A post says proven only of what RESULTS marks proven, and shows a profit only where RESULTS does.</li>
<li>One webhook per key. The URL is stored encrypted and never shown again; a webhook Discord says is gone, or 5 failed posts in a row, stops the feed.</li>
</ul>
<div class="keybox">
<form id="fd" class="row2" autocomplete="off"><div style="flex:1 1 260px;min-width:0"><label for="fdUrl">Discord webhook URL</label><input id="fdUrl" name="url" type="url" inputmode="url" maxlength="300" placeholder="https://discord.com/api/webhooks/…"></div><button class="btn" type="submit">CONNECT</button></form>
<div class="row2" style="margin-top:8px"><button class="btn" type="button" id="fdCheck">CHECK FEED</button><button class="btn warn" type="button" id="fdOff">DISCONNECT</button></div>
<div id="fdOut" class="msg">Needs a key from this page, saved in this browser.</div>
</div>
<p class="note">With code: <code>PUT /api/v1/feed/discord</code> with <code>{"url":"…"}</code>, <code>GET /api/v1/feed</code> and <code>DELETE /api/v1/feed/discord</code>, each with your <code>X-API-Key</code>.</p>

<h2 id="bot">Discord bot: slash commands</h2>
<p>Run the Line Reaper slash commands on your own server, under your own Discord application. Members type a command and the bot answers in the channel with the same public numbers as this API.</p>
<ul class="rules">
<li><code>/odds game</code>: a game's best price at each venue (for the server's state), with Pinnacle's price and a line history link.</li>
<li><code>/props player</code>: each pick'em app's line for a player, beside Pinnacle's where Pinnacle hangs the prop.</li>
<li><code>/moves</code>: today's biggest line moves and which venues followed. <code>/lines market</code>: the markets we keep, each with a chart and a CSV.</li>
<li><code>/record</code>: the public record as RESULTS says it, or <code>/record handle</code> for a bettor's verified record.</li>
<li><code>/settings</code>: the server's state (only venues a resident there can use) and odds format. Manage Server only.</li>
</ul>
<ol class="steps">
<li>At <b>discord.com/developers/applications</b> tap <b>New Application</b>, name it and tap <b>Create</b>.</li>
<li>On <b>General Information</b>, copy the <b>Application ID</b> and the <b>Public Key</b> into the boxes below.</li>
<li>Open <b>Bot</b>, tap <b>Reset Token</b>, then <b>Copy</b>, and paste it below. It is used once to add the commands and is never kept.</li>
<li>Tap <b>CONNECT BOT</b>. The answer gives your <b>Interactions Endpoint URL</b>: paste it on <b>General Information</b> and tap <b>Save Changes</b> (Discord checks it there and then).</li>
<li>Open the install link from the answer, pick your server and tap <b>Authorize</b>. Type <code>/odds</code> in any channel.</li>
</ol>
<ul class="rules">
<li>Everyone who asks the same thing gets the same answer. Nothing is sized or picked per person, and nothing places a bet.</li>
<li>Each command is one API call on this key's plan, so the key's limits apply. A record is called proven only where RESULTS proves it, with a profit only where RESULTS shows one.</li>
</ul>
<div class="keybox">
<form id="bt" autocomplete="off">
<div class="row2"><div style="flex:1 1 200px;min-width:0"><label for="btApp">Application ID</label><input id="btApp" name="appId" inputmode="numeric" maxlength="22" placeholder="123456789012345678"></div>
<div style="flex:1 1 200px;min-width:0"><label for="btKey">Public key</label><input id="btKey" name="publicKey" maxlength="64" placeholder="64 letters and digits"></div></div>
<div class="row2" style="margin-top:8px"><div style="flex:1 1 260px;min-width:0"><label for="btTok">Bot token</label><input id="btTok" name="botToken" type="password" maxlength="100" placeholder="used once, never kept"></div><button class="btn" type="submit">CONNECT BOT</button></div>
</form>
<div class="row2" style="margin-top:8px"><button class="btn" type="button" id="btCheck">CHECK BOT</button><button class="btn warn" type="button" id="btOff">DISCONNECT BOT</button></div>
<div id="btOut" class="msg">Needs a key from this page, saved in this browser.</div>
</div>
<p class="note">With code: <code>PUT /api/v1/bot/discord</code> with <code>{"appId":"…","publicKey":"…","botToken":"…"}</code>, <code>GET /api/v1/bot</code> and <code>DELETE /api/v1/bot/discord</code>, each with your <code>X-API-Key</code>.</p>

<h2 id="widgets">Widgets</h2>
<p>Paste a snippet into any page. Each widget is dark, sizes to its container, refreshes every minute, wears the same label as the app and links back here. Options go on the div as <code>data-league</code>, <code>data-market</code>, <code>data-venue</code>, <code>data-n</code> (rows, 1 to 5), <code>data-state</code> (a two-letter state: only venues a resident can use), <code>data-game</code>, <code>data-side</code> and <code>data-odds</code> (american, decimal, fractional or probability; American when none).</p>
${widget('best-price', 'Best price above the fair', 'The top price above Pinnacle\'s no-vig fair, after fees, with its EV and what the book fills. Pick a league with data-league.', ' data-league="nfl" data-n="3"', '?league=nfl&n=3', 330)}
${widget('line-move', 'Line move chart', 'One game\'s prices over time at each venue against the fair. Without data-game it charts today\'s biggest move.', '', '', 360)}
${widget('record', 'Proven record card', 'What RESULTS proves, nothing more: graded count, CLV against the close, record, and profit only where it clears chance.', '', '', 280)}
</main>
<footer><div class="in"><nav><a href="/">Line Reaper</a><a href="/learn">Learn</a><a href="/status">Status</a><a href="/terms">Terms</a><a href="/responsible-gambling">Responsible gambling</a></nav>
<div>Line Reaper is an information service, not a sportsbook. It does not take bets. 21+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></div></footer>
<script>
(function () {
  var LS = 'lr_api_key';
  function get() { try { return localStorage.getItem(LS); } catch (e) { return null; } }
  function set(v) { try { v ? localStorage.setItem(LS, v) : localStorage.removeItem(LS); } catch (e) {} }
  function tok() { try { return localStorage.getItem('lr_token'); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var out = document.getElementById('mkOut');
  function mine() {
    var k = get(), box = document.getElementById('mine');
    box.style.display = k ? 'block' : 'none';
    if (k) document.getElementById('mineInfo').textContent = 'Key ' + k.slice(0, 7) + '…' + k.slice(-4) + ' is saved in this browser, so TRY IT below uses it.';
  }
  document.getElementById('mk').addEventListener('submit', function (e) {
    e.preventDefault();
    out.className = 'msg'; out.textContent = 'Making a key…';
    var h = { 'Content-Type': 'application/json' }, t = tok();
    if (t) h.Authorization = 'Bearer ' + t;
    fetch('/api/v1/keys', { method: 'POST', headers: h, body: JSON.stringify({ name: document.getElementById('kname').value }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { out.className = 'msg err'; out.textContent = (x.j.error && x.j.error.message) || 'Could not make a key.'; return; }
        set(x.j.key);
        out.innerHTML = 'Your key (shown once):<div class="keyout" id="keyText">' + esc(x.j.key) + '</div><button class="btn" type="button" data-copy="' + esc(x.j.key) + '">COPY KEY</button>';
        mine();
      })
      .catch(function () { out.className = 'msg err'; out.textContent = 'Could not reach the server. Try again.'; });
  });
  document.getElementById('mineUse').addEventListener('click', function () {
    var info = document.getElementById('mineInfo');
    fetch('/api/v1/key', { headers: { 'X-API-Key': get() || '' } }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) { info.textContent = j.error.message; return; }
      info.textContent = '"' + j.key.name + '", made ' + j.key.createdAt.slice(0, 10) + '. Used ' + j.usage.minute + ' of ' + j.limits.perMinute + ' this minute and ' + j.usage.today + ' of ' + j.limits.perDay + ' today.';
    }).catch(function () { info.textContent = 'Could not reach the server. Try again.'; });
  });
  document.getElementById('mineRevoke').addEventListener('click', function () {
    var info = document.getElementById('mineInfo');
    fetch('/api/v1/key', { method: 'DELETE', headers: { 'X-API-Key': get() || '' } }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) { info.textContent = j.error.message; return; }
      set(null); mine(); out.className = 'msg'; out.textContent = 'Revoked: that key no longer works. Make a new one any time.';
    }).catch(function () { info.textContent = 'Could not reach the server. Try again.'; });
  });
  // the Discord feed: connect, check, disconnect with the key saved here
  var fdOut = document.getElementById('fdOut');
  function fdShow(j) {
    var d = j && j.discord;
    if (!d) return;
    if (d.connected) fdOut.textContent = 'Connected: webhook ' + d.webhook + (d.name ? ' ("' + d.name + '")' : '') + ', since ' + String(d.addedAt).slice(0, 10) + '. Last post ' + (d.lastOkAt ? String(d.lastOkAt).slice(0, 16).replace('T', ' ') + ' UTC' : 'not yet') + '.';
    else if (d.stoppedAt) { fdOut.className = 'msg err'; fdOut.textContent = 'Stopped ' + String(d.stoppedAt).slice(0, 10) + ': ' + (d.stoppedWhy || '') + (d.lastError ? ' (' + d.lastError + ')' : ''); }
    else fdOut.textContent = 'No Discord feed on this key.';
  }
  function fdCall(method, path, body) {
    var k = get();
    if (!k) { fdOut.className = 'msg err'; fdOut.textContent = 'Make a key first (top of the page): the feed is tied to it.'; document.getElementById('kname').focus(); return; }
    fdOut.className = 'msg'; fdOut.textContent = method === 'PUT' ? 'Checking the webhook with Discord…' : 'Asking…';
    var h = { 'X-API-Key': k };
    if (body) h['Content-Type'] = 'application/json';
    fetch(path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) { fdOut.className = 'msg err'; fdOut.textContent = j.error.message; return; }
        fdShow(j);
        if (j.note) fdOut.textContent = j.note + ' ' + fdOut.textContent;
      })
      .catch(function () { fdOut.className = 'msg err'; fdOut.textContent = 'Could not reach the server. Try again.'; });
  }
  document.getElementById('fd').addEventListener('submit', function (e) {
    e.preventDefault();
    var u = document.getElementById('fdUrl').value.trim();
    if (!/^https:\\/\\/(ptb\\.|canary\\.)?discord(app)?\\.com\\/api\\/(v\\d+\\/)?webhooks\\/\\d+\\/[\\w-]+\\/?$/.test(u)) { fdOut.className = 'msg err'; fdOut.textContent = 'That is not a Discord webhook URL. It starts https://discord.com/api/webhooks/ (step 1 above).'; return; }
    fdCall('PUT', '/api/v1/feed/discord', { url: u });
  });
  document.getElementById('fdCheck').addEventListener('click', function () { fdCall('GET', '/api/v1/feed'); });
  document.getElementById('fdOff').addEventListener('click', function () { fdCall('DELETE', '/api/v1/feed/discord'); });
  // the Discord bot: connect (the token goes to the server once), check, disconnect
  var btOut = document.getElementById('btOut');
  function btShow(j) {
    var d = j && j.discord;
    if (!d) return;
    if (d.connected) btOut.innerHTML = 'Connected: application ' + esc(d.appId) + ', since ' + esc(String(d.addedAt).slice(0, 10)) + '. Last command ' + (d.lastUseAt ? esc(String(d.lastUseAt).slice(0, 16).replace('T', ' ')) + ' UTC' : 'not yet') + '.<br>Interactions Endpoint URL:<div class="keyout" id="btEndpoint">' + esc(d.endpoint) + '</div><button class="btn" type="button" data-copy="' + esc(d.endpoint) + '">COPY URL</button> <a class="btn" href="' + esc(d.install) + '" target="_blank" rel="noopener">INSTALL ON A SERVER</a>';
    else btOut.textContent = 'No Discord bot on this key.';
  }
  function btCall(method, path, body) {
    var k = get();
    if (!k) { btOut.className = 'msg err'; btOut.textContent = 'Make a key first (top of the page): the bot is tied to it.'; document.getElementById('kname').focus(); return; }
    btOut.className = 'msg'; btOut.textContent = method === 'PUT' ? 'Adding the commands with Discord…' : 'Asking…';
    var h = { 'X-API-Key': k };
    if (body) h['Content-Type'] = 'application/json';
    fetch(path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) { btOut.className = 'msg err'; btOut.textContent = j.error.message; return; }
        btShow(j);
        if (j.note) btOut.insertAdjacentText('afterbegin', j.note + ' ');
      })
      .catch(function () { btOut.className = 'msg err'; btOut.textContent = 'Could not reach the server. Try again.'; });
  }
  document.getElementById('bt').addEventListener('submit', function (e) {
    e.preventDefault();
    var a = document.getElementById('btApp').value.trim(), pk = document.getElementById('btKey').value.trim(), t = document.getElementById('btTok').value.trim();
    if (!/^[0-9]{15,22}$/.test(a)) { btOut.className = 'msg err'; btOut.textContent = 'The Application ID is the long number on General Information (step 2).'; return; }
    if (!/^[0-9a-fA-F]{64}$/.test(pk)) { btOut.className = 'msg err'; btOut.textContent = 'The Public Key is 64 letters and digits on General Information (step 2).'; return; }
    if (!t) { btOut.className = 'msg err'; btOut.textContent = 'Paste the bot token from Bot > Reset Token (step 3).'; return; }
    document.getElementById('btTok').value = '';
    btCall('PUT', '/api/v1/bot/discord', { appId: a, publicKey: pk, botToken: t });
  });
  document.getElementById('btCheck').addEventListener('click', function () { btCall('GET', '/api/v1/bot'); });
  document.getElementById('btOff').addEventListener('click', function () { btCall('DELETE', '/api/v1/bot/discord'); });
  document.getElementById('mineForget').addEventListener('click', function () { set(null); mine(); out.className = 'msg'; out.textContent = 'Forgotten in this browser. The key still works wherever you use it.'; });
  document.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('[data-copy]');
    if (c) {
      var text = c.getAttribute('data-copy');
      var done = function () { var was = c.textContent; c.textContent = 'COPIED'; setTimeout(function () { c.textContent = was; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy this:', text); });
      else window.prompt('Copy this:', text);
      return;
    }
    var b = e.target.closest && e.target.closest('[data-try]');
    if (!b) return;
    var msg = b.parentNode.querySelector('[data-try-msg]'), pre = b.parentNode.querySelector('pre[data-ex]');
    var k = get();
    if (!k) { msg.textContent = 'Make a key first (top of the page): it is saved in this browser and used here.'; document.getElementById('kname').focus(); return; }
    msg.textContent = 'Asking…';
    fetch(b.getAttribute('data-try'), { headers: { 'X-API-Key': k } }).then(function (r) {
      return r.json().then(function (j) { msg.textContent = r.status + ' · ' + (r.headers.get('X-RateLimit-Remaining') || '?') + ' calls left this minute'; pre.textContent = JSON.stringify(j, null, 2); });
    }).catch(function () { msg.textContent = 'Could not reach the server. Try again.'; });
  });
  // the previews size themselves like /embed.js does
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || typeof e.data.lrEmbed !== 'string') return;
    var f = document.querySelector('iframe[data-lr-id="' + e.data.lrEmbed.replace(/[^\\w-]/g, '') + '"]');
    var h = Number(e.data.height);
    if (f && h > 40 && h < 4000) f.style.height = h + 'px';
  });
  mine();
})();
</script>
</body>
</html>`;
}

module.exports = { bestPriceWidget, lineMoveWidget, recordWidget, chartSvg, embedScript, developersPage, fillText, impliedOf, WIDGET_CSS };
