// ─── SHARE CARDS: ONE IMAGE FOR A ROW, A CHART, A LEAGUE OR THE RECORD ───────
// A 1200x630 picture (the size X, Discord and iMessage show for a link) of
// something the app already shows, drawn on the server from the server's own
// data, never from numbers a browser sends:
//   price   one best-price row (a shopper opportunity, by its id)
//   move    one game's line chart (a game, a market and a side)
//   league  a league's board: games, venues, the best prices above the fair
//   record  what RESULTS proves, nothing more
//   digest  one week of the weekly digest
// Every card wears the label the app gives the same thing: PROVEN only where
// RESULTS proves it (claims.js, through the public API's shapes), LEAD
// (research) for a price above the fair, "information, not an edge" for a line
// move. Profit only where RESULTS shows one. The same card for everyone: no
// stake, no slips, nothing from an account.
//
// Pure: each builder takes the shapes publicapi.js and digest.js make and
// returns SVG text. server.js turns it into a PNG with resvg (renderPng below)
// and serves it at /card/<kind>.png; the share page (/share/<kind>) and the
// Open Graph tags point link previews at it.

const path = require('path');
const oddsFmt = require('./oddsfmt');

const W = 1200, H = 630;
const FONT = 'JetBrains Mono';
// JetBrains Mono is monospaced: every glyph is 600/1000 of the font size wide,
// so text is cut to fit exactly, with no measuring
const CHAR = 0.6;
const C = { bg: '#080b10', card: '#0d121b', border: '#1e2738', text: '#e2e8f0', text2: '#94a3b8', muted: '#8391a7', green: '#10b981', green2: '#34d399', amber: '#f59e0b', red: '#f87171', blue: '#60a5fa', violet: '#a78bfa' };
const TONE = { proven: C.green2, lead: C.amber, info: C.blue, research: C.violet, losing: C.red, plain: C.text2 };
const VENUE_COLOR = { pinnacle: '#94a3b8', fanduel: '#3b82f6', betrivers: '#f59e0b', kalshi: '#10b981', polymarketus: '#a78bfa', gemini: '#22d3ee', matchbook: '#f472b6',
  draftkings: '#84cc16', betmgm: '#eab308', caesars: '#fb923c', bet365: '#4ade80', fanatics: '#ef4444', hardrock: '#c084fc', thescore: '#60a5fa' };
const colorOf = v => VENUE_COLOR[v] || '#8391a7';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// strip control characters (resvg draws nothing for them; a feed name could carry one)
const clean = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
// cut text to maxPx at this size, with an ellipsis
function fit(s, size, maxPx) {
  const t = clean(s);
  const n = Math.max(1, Math.floor(maxPx / (size * CHAR)));
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}
const textW = (s, size) => clean(s).length * size * CHAR;
// American odds in the sharer's format (?odds=, CUSTOMIZE > Odds format; American when none)
const am = (a, fmt = 'american') => (a == null || !Number.isFinite(Number(a)) ? '—' : oddsFmt.fromAm(Number(a), fmt));
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(d)}%`);
const pctPlain = (p, d = 1) => (p == null || !Number.isFinite(p) ? '—' : `${(p * 100).toFixed(d)}%`);
const usd = n => `$${Math.round(n).toLocaleString('en-US')}`;
const when = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(5, 10).replace('-', '/')} ${d.toISOString().slice(11, 16)} UTC` : ''; };
const readStamp = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? `read ${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC` : 'read time unknown'; };
const impliedOf = a => (a == null || !Number.isFinite(a) || a === 0 ? null : a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const americanOfDec = d => (d == null || !(d > 1) ? null : d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
const host = origin => String(origin || '').replace(/^https?:\/\//, '').replace(/[^\w.:-]/g, '').replace(/\/+$/, '');

// ── drawing pieces ──
const txt = (x, y, s, { size = 24, fill = C.text, weight = 400, anchor = 'start', max = null, spacing = 0 } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(max ? fit(s, size, max) : clean(s))}</text>`;
// a chip: a label in a box, as wide as its words
function chip(x, y, s, tone = 'plain', { size = 18, right = false } = {}) {
  const t = clean(s).toUpperCase();
  const w = Math.round(textW(t, size) + size * 1.2), h = Math.round(size * 1.8);
  const x0 = right ? x - w : x;
  const col = TONE[tone] || TONE.plain;
  return { w, svg: `<rect x="${x0}" y="${y}" width="${w}" height="${h}" rx="6" fill="none" stroke="${col}" stroke-opacity=".7" stroke-width="2"/>${txt(x0 + w / 2, y + h / 2 + size * 0.36, t, { size, fill: col, weight: 700, anchor: 'middle' })}` };
}
// a stat tile: small caps name over a big number
function tile(x, y, w, name, value, { color = C.text, size = 36, note = '' } = {}) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${note ? 112 : 96}" rx="10" fill="${C.card}" stroke="${C.border}" stroke-width="2"/>
${txt(x + 18, y + 30, String(name).toUpperCase(), { size: 15, fill: C.muted, weight: 700, max: w - 36, spacing: 1.5 })}
${txt(x + 18, y + 74, value, { size, fill: color, weight: 700, max: w - 36 })}
${note ? txt(x + 18, y + 100, note, { size: 14, fill: C.text2, max: w - 36 }) : ''}`;
}
// lay tiles out in a row across the card
function tileRow(y, items, { x0 = 48, x1 = W - 48, gap = 16, size = 34 } = {}) {
  const n = items.length;
  if (!n) return '';
  const w = Math.floor((x1 - x0 - gap * (n - 1)) / n);
  return items.map((it, i) => tile(x0 + i * (w + gap), y, w, it.name, it.value, { color: it.color, size: it.size || size, note: it.note })).join('\n');
}
const LOGO = (x, y, s = 40) => `<g transform="translate(${x},${y}) scale(${s / 32})"><rect width="32" height="32" rx="7" fill="#10b981"/><path d="M8 24V8h3.4v13h6.6V24H8zm11-9.5h5V18h-5z" fill="#06110d"/><path d="M19 8h5v3.5h-5z" fill="#06110d" opacity=".55"/></g>`;

// the frame every card shares: brand and what the card is at the top, the
// label chip on the right, the read time and the site at the bottom
function frame({ kind, label = null, body, readAt = null, origin = '', foot = 'Information, not a bet slip. Check the price at the venue before you bet. 21+.' }) {
  const lab = label ? chip(W - 48, 40, label.text, label.tone, { size: 18, right: true }) : null;
  const kindMax = W - 48 - 256 - (lab ? lab.w + 24 : 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect x="0" y="0" width="${W}" height="6" fill="${C.green}"/>
${LOGO(48, 36, 40)}
${txt(100, 66, 'LINE', { size: 26, weight: 700, fill: C.text })}${txt(100 + 5 * 26 * CHAR, 66, 'REAPER', { size: 26, weight: 700, fill: C.green2 })}
${txt(48 + 256, 66, kind.toUpperCase(), { size: 18, weight: 700, fill: C.muted, max: kindMax, spacing: 2 })}
${lab ? lab.svg : ''}
<line x1="48" x2="${W - 48}" y1="104" y2="104" stroke="${C.border}" stroke-width="2"/>
${body}
<line x1="48" x2="${W - 48}" y1="${H - 74}" y2="${H - 74}" stroke="${C.border}" stroke-width="2"/>
${txt(48, H - 38, readAt ? readStamp(readAt) : '', { size: 18, fill: C.text2, max: 420 })}
${txt(W - 48, H - 38, host(origin) || 'Line Reaper', { size: 18, fill: C.green2, weight: 700, anchor: 'end', max: 560 })}
${txt(48, H - 14, foot, { size: 14, fill: C.muted, max: W - 96 })}
</svg>`;
}
// a card with nothing to draw says why, in plain words
function emptyCard({ kind, label, title, why, readAt = null, origin = '' }) {
  return frame({ kind, label, readAt, origin, body: `${txt(48, 200, title, { size: 40, weight: 700, max: W - 96 })}
${wrap(why, 24, W - 96, 3).map((l, i) => txt(48, 260 + i * 36, l, { size: 24, fill: C.text2 })).join('\n')}` });
}
// split text into lines that fit, at most n (the last one cut)
function wrap(s, size, maxPx, n = 2) {
  const per = Math.max(1, Math.floor(maxPx / (size * CHAR)));
  const words = clean(s).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (`${cur} ${w}`.length <= per) cur += ` ${w}`;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > n) { lines.length = n; lines[n - 1] = fit(`${lines[n - 1]} …`, size, maxPx).replace(/ …$/, '…'); }
  return lines.map(l => fit(l, size, maxPx));
}

// ── the labels, in the app's words ──
const PRICE_LABEL = { proven: { text: 'PROVEN VENUE', tone: 'proven' }, lead: { text: 'LEAD · RESEARCH', tone: 'lead' } };
const MOVE_LABEL = { text: 'INFORMATION, NOT AN EDGE', tone: 'info' };
const LEAGUE_LABEL = { text: 'RESEARCH', tone: 'research' };
// a price's fill, in the widget's words (embeds.fillText): a read book, or why there is no number
function fillText(f) {
  if (!f) return 'size not read';
  if (f.status === 'read') return f.fillsUsd ? `fills ${usd(f.fillsUsd)}` : `only ${usd(f.depthUsd || 0)} on book`;
  if (f.status === 'empty') return 'nothing on the book';
  if (f.status === 'not published') return 'limit not published';
  return 'size not read';
}

// ── price: one row of publicapi.bestPrices() ──
// row: the row, or null when it is gone; ctx: { at, locked, stale, origin }
function priceCard(row, { at = null, locked = false, stale = false, origin = '', gone = false, fmt = 'american' } = {}) {
  const kind = !row || row.evPct > 0 ? 'Best price above the fair' : 'Best price';
  if (locked) return emptyCard({ kind, label: PRICE_LABEL.lead, title: 'Fair prices are for subscribers right now', why: 'While the paywall is on, the fair and the EV are not shown in public, so this card has no price to show.', readAt: at, origin });
  if (stale) return emptyCard({ kind, label: PRICE_LABEL.lead, title: 'The price feeds are behind', why: 'The feeds have not read in the last few minutes, so nothing is shown rather than an old price.', readAt: at, origin });
  if (!row) return emptyCard({ kind, label: PRICE_LABEL.lead, title: gone ? 'This price is no longer above the fair' : 'No price sits above the fair right now', why: gone ? 'It moved, the game started, or the venue took it down. Open the app for the prices as they are now.' : 'That is the usual state of an efficient market. Open the app for every price beside the fair.', readAt: at, origin });
  const lab = PRICE_LABEL[row.label] || PRICE_LABEL.lead;
  const dec = row.price?.decimalAfterFees;
  const be = dec > 1 ? 1 / dec : null;
  const afterAm = americanOfDec(dec);
  const shownAm = row.price?.american ?? afterAm;
  const sub = [row.event, row.marketName || row.marketType, row.altLine ? 'alt line' : '', when(row.start) ? `starts ${when(row.start)}` : ''].filter(Boolean).join(' · ');
  const body = `${txt(48, 168, row.selection, { size: 46, weight: 700, max: W - 96 })}
${txt(48, 210, sub, { size: 22, fill: C.text2, max: W - 96 })}
${tileRow(244, [
    { name: `Price · ${row.venueName}`, value: am(shownAm, fmt), color: C.green2, size: 44, note: afterAm != null && shownAm !== afterAm ? `${am(afterAm, fmt)} after the fee` : 'after the fee' },
    { name: 'Break-even after fee', value: pctPlain(be), size: 40, note: 'the win chance it needs' },
    { name: "Pinnacle's fair", value: row.fair?.american != null ? am(row.fair.american, fmt) : '—', size: 40, note: row.fair?.prob != null ? `no-vig ${pctPlain(row.fair.prob)}` : 'no fair' },
  ])}
${tileRow(372, [
    { name: 'EV after fee', value: pct(row.evPct), color: row.evPct > 0 ? C.green2 : C.text, size: 32 },
    { name: 'Fill size', value: fillText(row.fill), size: 26 },
    { name: 'Next best', value: row.secondBest ? `${am(row.secondBest.american, fmt)} ${row.secondBest.venueName}` : '—', size: 26 },
  ])}
${txt(48, 520, row.label === 'proven'
    ? `PROVEN VENUE: ${row.venueName} main lines beat Pinnacle's close on RESULTS. This row is one price, not a result.`
    : "LEAD: research, not a proven edge. A price above the fair has not beaten the close at this venue yet.", { size: 16, fill: lab.tone === 'proven' ? C.green2 : C.amber, max: W - 96 })}`;
  return frame({ kind, label: lab, readAt: at, origin, body });
}

// ── move: one game's line chart (publicapi.historySeries) ──
function chartSvg(points, { x, y, w, h, withFair = true }) {
  const venues = [...new Set(points.flatMap(p => Object.keys(p.prices || {})))];
  const lines = venues.map(v => ({ v, pts: points.map(p => [Date.parse(p.t), impliedOf(p.prices?.[v])]).filter(([, yy]) => yy != null) })).filter(l => l.pts.length);
  const fair = withFair ? points.map(p => [Date.parse(p.t), p.fair]).filter(([, yy]) => yy != null) : [];
  const all = [...lines.flatMap(l => l.pts), ...fair];
  if (new Set(all.map(p => p[0])).size < 2) return null;
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x1 - x0 < 60e3) x1 = x0 + 60e3;
  let y0 = Math.min(...ys), y1 = Math.max(...ys); const pad = Math.max(0.01, (y1 - y0) * 0.15); y0 = Math.max(0, y0 - pad); y1 = Math.min(1, y1 + pad);
  const L = 90, R = 10, T = 8, B = 34;
  const X = t => x + L + ((t - x0) / (x1 - x0)) * (w - L - R), Y = v => y + T + (1 - (v - y0) / (y1 - y0)) * (h - T - B);
  // a step line: a price holds until the next read
  const path = pts => pts.map(([t, v], i) => `${i ? `H${X(t).toFixed(1)}V` : `M${X(t).toFixed(1)},`}${Y(v).toFixed(1)}`).join('') + `H${X(x1).toFixed(1)}`;
  const ticks = [0, 0.5, 1].map(f => y0 + f * (y1 - y0));
  const xt = [x0, (x0 + x1) / 2, x1];
  return `${ticks.map(v => `<line x1="${x + L}" x2="${x + w - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${C.border}" stroke-width="2"/>${txt(x + L - 10, Y(v) + 6, `${(v * 100).toFixed(1)}%`, { size: 16, fill: C.muted, anchor: 'end' })}`).join('')}
${xt.map((t, i) => txt(X(t), y + h - 6, new Date(t).toISOString().slice(11, 16), { size: 16, fill: C.muted, anchor: ['start', 'middle', 'end'][i] })).join('')}
${fair.length ? `<path d="${path(fair)}" fill="none" stroke="${C.text}" stroke-width="3" stroke-dasharray="8 6"/>` : ''}
${lines.map(l => `<path d="${path(l.pts)}" fill="none" stroke="${colorOf(l.v)}" stroke-width="4"/>`).join('')}`;
}
const MARKET_NAME = { ml: 'Moneyline', spread: 'Spread', total: 'Total' };
// pick the series a card draws: the market asked for (else moneyline), and the
// side by its name or its place
function pickSeries(series, { market = null, side = null, sideIndex = 0 } = {}) {
  const markets = [...new Set(series.map(s => s.market))];
  const mk = markets.includes(market) ? market : markets.includes('ml') ? 'ml' : markets[0];
  const sides = series.filter(s => s.market === mk);
  const bySide = side ? sides.find(s => clean(s.side).toLowerCase() === clean(side).toLowerCase()) : null;
  return { market: mk, s: bySide || sides[Math.min(Math.max(0, sideIndex | 0), Math.max(0, sides.length - 1))] || null };
}
function moveCard({ game = null, series = [], market = null, side = null, sideIndex = 0, withFair = true, origin = '', venueName = v => v, fmt = 'american' } = {}) {
  const kind = 'Line move';
  const { market: mk, s } = pickSeries(series, { market, side, sideIndex });
  if (!game || !s) return emptyCard({ kind, label: MOVE_LABEL, title: game ? 'No saved prices for this game yet' : 'No game to chart', why: game ? 'Points are saved every few minutes from when a game first shows up on the board.' : 'The game started more than 6 hours ago, or it is not on the board.', origin });
  const last = s.points[s.points.length - 1];
  const sub = [game.leagueLabel, `${MARKET_NAME[mk] || mk} · ${s.side}${mk !== 'ml' && last?.point != null ? ` (now ${last.point})` : ''}`, when(game.start) ? `starts ${when(game.start)}` : ''].filter(Boolean).join(' · ');
  const chart = chartSvg(s.points, { x: 48, y: 222, w: W - 96, h: 250, withFair });
  const venues = [...new Set(s.points.flatMap(p => Object.keys(p.prices || {})))];
  // the legend: each venue's last price, then the fair, on one line (cut to fit)
  let lx = 48;
  const legend = [];
  const items = [...venues.map(v => ({ col: colorOf(v), t: `${venueName(v)} ${am(last?.prices?.[v], fmt)}`, dash: false })), ...(withFair && last?.fair != null ? [{ col: C.text, t: `FAIR ${pctPlain(last.fair)}`, dash: true }] : [])];
  for (const it of items) {
    const w = 30 + textW(it.t, 18) + 26;
    if (lx + w > W - 48) break;
    legend.push(`<line x1="${lx}" x2="${lx + 22}" y1="502" y2="502" stroke="${it.col}" stroke-width="4"${it.dash ? ' stroke-dasharray="6 4"' : ''}/>${txt(lx + 30, 508, it.t, { size: 18, fill: C.text2 })}`);
    lx += w;
  }
  const body = `${txt(48, 160, game.event, { size: 40, weight: 700, max: W - 96 })}
${txt(48, 200, sub, { size: 22, fill: C.text2, max: W - 96 })}
${chart || txt(48, 330, 'Only one point saved so far: the chart starts with the second.', { size: 24, fill: C.text2, max: W - 96 })}
${chart ? legend.join('') : ''}
${txt(48, 540, `Implied win chance at each venue${withFair ? "; dashed: Pinnacle's no-vig fair" : ''}. A move is information, not an edge.`, { size: 16, fill: C.blue, max: W - 96 })}`;
  return frame({ kind, label: MOVE_LABEL, readAt: last?.t || null, origin, body });
}

// ── league: a league's board right now ──
// d: { name, games, markets, withFair, venues, aboveFair, rows (publicapi.bestPrices), at, stale, locked, esports }
function leagueCard(d, { origin = '', fmt = 'american' } = {}) {
  const kind = `${d.name} · next 48 hours`;
  if (d.stale) return emptyCard({ kind, label: LEAGUE_LABEL, title: `${d.name}: the price feeds are behind`, why: 'The feeds have not read in the last few minutes, so nothing is shown rather than an old price.', readAt: d.at, origin });
  if (!d.games) return emptyCard({ kind, label: LEAGUE_LABEL, title: `No ${d.name} games on the board right now`, why: d.esports ? 'Esports prices and matchups are on the ESPORTS tab in the app; this card counts game lines on the odds screen.' : 'Nothing starts in the next 48 hours with a price we read. The board fills in as venues post lines.', readAt: d.at, origin });
  const top = (d.rows || []).slice(0, 3);
  const rows = top.length ? top.map((r, i) => {
    const y = 316 + i * 62;
    const lab = chip(W - 48, y - 30, r.label === 'proven' ? 'PROVEN VENUE' : 'LEAD', r.label === 'proven' ? 'proven' : 'lead', { size: 14, right: true });
    const right = `${am(r.price?.american ?? americanOfDec(r.price?.decimalAfterFees), fmt)} ${r.venueName} · fair ${am(r.fair?.american, fmt)} · EV ${pct(r.evPct)}`;
    const rw = textW(right, 20);
    return `<rect x="48" y="${y - 42}" width="${W - 96}" height="54" rx="8" fill="${C.card}" stroke="${C.border}" stroke-width="2"/>
${txt(64, y - 8, `${r.selection} · ${r.event}`, { size: 20, weight: 700, max: W - 96 - 32 - rw - lab.w - 40 })}
${txt(W - 48 - lab.w - 20, y - 8, right, { size: 20, fill: C.green2, anchor: 'end' })}${lab.svg}`;
  }).join('\n') : txt(48, 316, d.locked ? 'Fair prices are for subscribers while the paywall is on.' : 'No price sits above the fair in this league right now.', { size: 24, fill: C.text2, max: W - 96 });
  const body = `${tileRow(124, [
    { name: 'Games', value: String(d.games) },
    { name: 'Markets with a fair', value: d.locked ? '—' : `${d.withFair}/${d.markets}` },
    { name: d.stateName ? `${d.stateName} venues` : 'Venues', value: String(d.venues) },
    { name: 'Prices above fair', value: d.locked ? '—' : String(d.aboveFair), color: d.aboveFair ? C.green2 : C.text },
  ], { size: 36 })}
${top.length ? txt(48, 256, d.stateName ? `BEST ${String(d.stateName).toUpperCase()} PRICES ABOVE THE FAIR, AFTER FEES` : 'BEST PRICES ABOVE THE FAIR, AFTER FEES', { size: 15, fill: C.muted, weight: 700, spacing: 1.5 }) : ''}
${rows}
${txt(48, 530, "Fair: Pinnacle's no-vig price. Above the fair is research (LEAD) until RESULTS proves the venue.", { size: 16, fill: C.violet, max: W - 96 })}`;
  return frame({ kind, label: LEAGUE_LABEL, readAt: d.at, origin, body });
}

// ── record: publicapi.recordCard() ──
function recordCardSvg(card, { origin = '' } = {}) {
  const kind = 'The public record';
  const proven = (card.proven || []).slice(0, 2);
  const label = proven.length ? { text: 'PROVEN', tone: 'proven' } : { text: 'NOTHING PROVEN YET', tone: 'plain' };
  let body;
  if (!proven.length) {
    body = `${txt(48, 190, 'Nothing is proven yet on the strict rule', { size: 38, weight: 700, max: W - 96 })}
${txt(48, 240, `${card.notProven} kind${card.notProven === 1 ? '' : 's'} on the record: ${card.building} building, ${card.losing} losing to the close.`, { size: 24, fill: C.text2, max: W - 96 })}`;
  } else {
    body = proven.map((r, i) => {
      const y0 = 124 + i * 210;
      const name = `${r.venueName} · ${r.kindLabel || r.kind}`;
      const tx = r.texas ? null : chip(48 + Math.min(textW(name, 32), W - 96 - 220) + 20, y0 + 6, 'NOT IN TEXAS', 'plain', { size: 14 });
      return `${txt(48, y0 + 38, name, { size: 32, weight: 700, max: W - 96 - 220 })}${tx ? tx.svg : ''}
${tileRow(y0 + 60, [
        { name: 'Graded', value: String(r.graded) },
        { name: 'CLV vs close', value: pct(r.clvPct), color: C.green2 },
        { name: 'Beat the close', value: r.beatPct == null ? '—' : `${Math.round(r.beatPct)}%` },
        { name: 'Won-lost', value: `${r.wins}-${r.losses}` },
        { name: 'Profit', value: r.profitShown && r.units != null ? `${r.units > 0 ? '+' : ''}${r.units.toFixed(1)}u` : 'not shown', color: r.profitShown ? C.green2 : C.muted, size: r.profitShown ? 34 : 26 },
      ], { size: 34 })}`;
    }).join('\n');
    const y = proven.length === 1 ? 330 : 520;
    body += `\n${proven.length === 1 && !proven[0].profitShown ? txt(48, 318, "Profit not shown: results have not cleared chance. Proven here means it beats Pinnacle's close.", { size: 18, fill: C.text2, max: W - 96 }) : ''}
${txt(48, y + (proven.length === 1 ? 26 : 0), `${card.notProven} other kind${card.notProven === 1 ? '' : 's'} not proven (${card.building} building, ${card.losing} losing to the close).`, { size: 18, fill: C.text2, max: W - 96 })}`;
  }
  const rule = 'Rule: 50 graded at one venue we read ourselves, CLV t of 2 or more against Pinnacle\'s close, never pooled.';
  body += `\n${wrap(rule, 18, W - 96, 2).map((l, i) => txt(48, (proven.length === 2 ? 548 : 470) + i * 26 - (proven.length === 2 ? 26 : 0), l, { size: 18, fill: C.muted })).join('\n')}`;
  return frame({ kind, label, readAt: card.at, origin, body, foot: 'Every graded flag is downloadable on RESULTS. Information, not betting advice. 21+.' });
}

// ── a bettor's own record (pubrecord.recordView): proven only where its app is ──
function bettorCard(v, { origin = '' } = {}) {
  const kind = `@${v.handle} · bettor record`;
  if (!v || v.status !== 'live') return emptyCard({ kind, label: { text: 'UNPUBLISHED', tone: 'plain' }, title: 'This record was unpublished', why: 'Its slips were removed by the bettor.', readAt: v?.at, origin });
  const p = v.pooled;
  const top = (v.apps || []).find(a => a.label === 'proven') || (v.apps || [])[0] || null;
  const label = v.proven.length ? { text: `PROVEN · ${v.proven[0]}`, tone: 'proven' } : { text: 'NOT PROVEN YET', tone: 'plain' };
  const units = (u, shown) => (u == null ? '—' : `${u > 0 ? '+' : ''}${u.toFixed(1)}u${shown ? '' : '*'}`);
  const body = `${txt(48, 168, `@${v.handle}`, { size: 44, weight: 700, max: W - 96 })}
${txt(48, 206, "Pick'em slips logged before the start, graded against Pinnacle's close", { size: 20, fill: C.text2, max: W - 96 })}
${tileRow(232, [
    { name: 'Legs vs Pinnacle', value: `${p.pinN}/${v.rule?.graded || 50}` },
    { name: 'CLV vs close', value: pct(p.clv), color: p.clv > 0 ? C.green2 : p.clv < 0 ? C.red : C.text },
    { name: 'Legs hit', value: p.hitRate == null ? '—' : `${Math.round(p.hitRate * 100)}%`, note: p.be != null ? `needs ${(p.be * 100).toFixed(1)}%` : '' },
    { name: 'Slips W-L', value: p.record },
    { name: top && top.profitShown ? 'Profit' : 'Units', value: top && top.profitShown ? units(top.units, true) : units(p.units, false), color: C.text2, size: 30 },
  ])}
${txt(48, 390, top ? `${top.appName}: ${top.label}${top.why ? `. ${top.why}` : ''}` : 'No slips logged yet.', { size: 20, fill: top?.label === 'proven' ? C.green2 : C.text2, max: W - 96 })}
${wrap(`${v.counts.onTime} slips on time, ${v.counts.late} late (logged after the start, not counted). * Units are 1u a slip at the app's table, not called a profit unless proven.`, 18, W - 96, 2).map((l, i) => txt(48, 432 + i * 26, l, { size: 18, fill: C.muted })).join('\n')}
${wrap('Rule: 50 legs at one app against Pinnacle\'s close at their own line, CLV t of 2 or more, never pooled.', 18, W - 96, 2).map((l, i) => txt(48, 500 + i * 26, l, { size: 18, fill: C.muted })).join('\n')}`;
  return frame({ kind, label, readAt: v.at, origin, body, foot: 'Imported by the bettor, not placed through Line Reaper. Information, not betting advice. 21+.' });
}

// ── the bettor leaderboard (leaderboard.build): ranked only at the bar ──
function boardCard(v, { origin = '' } = {}) {
  const f = v.filter;
  const kind = `Bettor leaderboard · ${f.windowName}${f.league ? ` · ${f.league}` : ''}`;
  if (!v.ranked.length) {
    const top = v.building[0];
    return emptyCard({ kind, label: { text: 'NOBODY RANKED YET', tone: 'plain' }, title: `Nobody at ${v.bar} graded yet`,
      why: top ? `Most graded: @${top.handle} at ${top.name}, ${top.n} of ${v.bar} picks graded against Pinnacle's close. Ranked only at ${v.bar}.`
        : `No published record has a pick logged before its start and graded against Pinnacle's close in this slice yet.`, readAt: v.at, origin });
  }
  const rows = v.ranked.slice(0, 5).map((x, i) => {
    const y = 200 + i * 62;
    return `${txt(48, y, `${x.tied ? '=' : ''}${x.rank}`, { size: 30, weight: 700, fill: C.green2, max: 70 })}${txt(130, y, `@${x.handle}`, { size: 28, weight: 700, max: 360 })}${txt(500, y, `${x.name} · ${x.n} graded`, { size: 20, fill: C.text2, max: 300 })}${txt(W - 48, y, `${pct(x.clv, 2)}  [${pct(x.ciLo, 2)}, ${pct(x.ciHi, 2)}]`, { size: 22, fill: x.clv > 0 ? C.green2 : C.red, anchor: 'end', max: 330 })}`;
  }).join('\n');
  const label = { text: `${v.ranked.length} RANKED`, tone: 'plain' };
  const body = `${txt(48, 146, 'CLV against Pinnacle\'s close · ranked by the low end of the 95% interval', { size: 20, fill: C.text2, max: W - 96 })}
${rows}
${wrap(`Ranked only at ${v.bar} picks logged before the start. Labels are each record's own. No profit shown.`, 18, W - 96, 2).map((l, i) => txt(48, 520 + i * 26, l, { size: 18, fill: C.muted })).join('\n')}`;
  return frame({ kind, label, readAt: v.at, origin, body, foot: 'Records are logged by the bettors, not placed through Line Reaper. Information, not betting advice. 21+.' });
}

// ── digest: one week (digest.build()) ──
function digestCard(d, { origin = '', frozen = false } = {}) {
  const s = d.summary;
  const kind = `Weekly record · week of ${d.name}`;
  const list = a => (a && a.length ? a.join(', ') : 'none');
  const lines = [
    ['Proven at the week\'s end', s.proven.length ? s.proven.map(p => `${p.kindLabel} · ${p.bookName} (${p.graded} graded, CLV ${pct(p.clv)})`).join('; ') : 'nothing yet', s.proven.length ? C.green2 : C.text2],
    ['Newly proven', list(s.newlyProven), s.newlyProven.length ? C.green2 : C.text2],
    ['Newly losing to the close', list(s.newlyFailed), s.newlyFailed.length ? C.red : C.text2],
    ['Reached 50 graded', list(s.reached50), C.text2],
  ];
  const body = `${tileRow(124, [
    { name: 'Graded this week', value: s.graded.toLocaleString('en-US') },
    { name: 'Kinds · venues', value: String(s.kinds) },
    { name: 'Proven', value: String(s.proven.length), color: s.proven.length ? C.green2 : C.text },
    { name: 'Week CLV (pooled)', value: pct(s.overall?.week?.clv), note: 'pooled: never a claim' },
  ], { size: 34 })}
${lines.map(([k, v, col], i) => `${txt(48, 296 + i * 58, k.toUpperCase(), { size: 15, fill: C.muted, weight: 700, spacing: 1.5 })}${txt(48, 322 + i * 58, v, { size: 22, fill: col, max: W - 96 })}`).join('\n')}`;
  const state = d.partial ? 'The week so far' : frozen ? 'Published and frozen' : 'Rebuilt from the record';
  return frame({ kind, label: { text: state, tone: 'plain' }, readAt: d.builtAt, origin, body, foot: 'Proven only where RESULTS proves it; units are a profit only where RESULTS shows one. 21+.' });
}

// ── the alert history (alertlog.view): what was sent, and how its bets graded ──
// PROVEN only where a label row is proven on RESULTS; the pooled CLV is never a claim
const ALERT_TONE = { proven: 'proven', building: 'lead', research: 'research', 'losing to the close': 'losing' };
function alertsCard(v, { origin = '' } = {}) {
  const s = v.summary;
  const kind = 'Alert history';
  const since = v.startedAt ? String(v.startedAt).slice(0, 10) : 'storing began';
  if (!s.alerts) return emptyCard({ kind, label: { text: 'NOTHING SENT YET', tone: 'plain' }, title: 'No alert sent since storing began',
    why: `Every alert is kept from ${since}. The first one sent will show here, graded against the close.`, readAt: v.at, origin });
  const proven = s.byLabel.find(r => r.label === 'proven');
  const label = proven ? { text: 'INCLUDES A PROVEN KIND', tone: 'proven' } : { text: 'NOTHING PROVEN', tone: 'plain' };
  const rows = s.byLabel.slice(0, 4).map((r, i) => {
    const y = 300 + i * 52;
    const u = r.units == null ? '' : r.profitShown ? ` · ${r.units > 0 ? '+' : ''}${r.units.toFixed(1)}u` : '';
    return `${txt(48, y, String(r.label).toUpperCase(), { size: 18, weight: 700, fill: TONE[ALERT_TONE[r.label]] || C.text2, max: 300 })}${txt(360, y, `${r.alerts} alert${r.alerts === 1 ? '' : 's'} · ${r.graded} graded · CLV ${pct(r.avgClvPct)}${r.wins + r.losses ? ` · ${r.wins}-${r.losses}` : ''}${u}`, { size: 20, fill: C.text, max: W - 408 })}`;
  }).join('\n');
  const body = `${tileRow(124, [
    { name: 'Alerts sent', value: s.alerts.toLocaleString('en-US'), note: `since ${since}` },
    { name: 'Bets graded', value: String(s.graded), note: `${s.open} still open` },
    { name: 'CLV at alert price', value: pct(s.avgClvPct), note: 'pooled: never a claim' },
    { name: 'Vs Pinnacle close', value: pct(s.avgPinClvPct), note: `${s.pinGraded} with it kept` },
  ], { size: 32 })}
${rows}`;
  return frame({ kind, label, readAt: v.at, origin, body, foot: 'The same alert went to everyone. Proven only where RESULTS proves it; a profit only where RESULTS shows one. 21+.' });
}

// ── PNG: resvg with the bundled fonts, loaded once; null when it is not there ──
let resvg;
function loadResvg() {
  if (resvg === undefined) { try { resvg = require('@resvg/resvg-js'); } catch { resvg = null; } }
  return resvg;
}
const FONT_FILES = ['JetBrainsMono-Regular.ttf', 'JetBrainsMono-Bold.ttf'].map(f => path.join(__dirname, 'fonts', f));
function renderPng(svg) {
  const r = loadResvg();
  if (!r) return null;
  return r.renderAsync
    ? r.renderAsync(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: FONT }, fitTo: { mode: 'original' } }).then(img => img.asPng())
    : Promise.resolve(new r.Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: FONT } }).render().asPng());
}

// ── link previews: Open Graph and Twitter tags ──
// meta: { title, description, image, url, alt }. image and url absolute.
function metaTags({ title, description, image, url = null, alt = '' }) {
  const t = clean(title).slice(0, 120), d = clean(description).slice(0, 300);
  return [
    '<meta property="og:type" content="website">', '<meta property="og:site_name" content="Line Reaper">',
    `<meta property="og:title" content="${esc(t)}">`, `<meta property="og:description" content="${esc(d)}">`,
    url ? `<meta property="og:url" content="${esc(url)}">` : '',
    `<meta property="og:image" content="${esc(image)}">`, '<meta property="og:image:type" content="image/png">',
    `<meta property="og:image:width" content="${W}">`, `<meta property="og:image:height" content="${H}">`,
    `<meta property="og:image:alt" content="${esc(clean(alt || t).slice(0, 200))}">`,
    '<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:title" content="${esc(t)}">`,
    `<meta name="twitter:description" content="${esc(d)}">`, `<meta name="twitter:image" content="${esc(image)}">`,
  ].filter(Boolean).join('\n');
}
// put the card's tags into a page that is already built: the page keeps its
// own title, description and url (from its og: tags, else <title> and the
// description meta), its og:/twitter: image tags go (they point at the plain
// logo image), and the card's tags go in before </head>. A page with no
// </head> is left alone.
const unesc = s => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function metaOf(html, attr, name) {
  const m = html.match(new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"`, 'i'));
  return m ? unesc(m[1]) : null;
}
function injectMeta(html, meta) {
  if (typeof html !== 'string' || !/<\/head>/i.test(html)) return html;
  const title = metaOf(html, 'property', 'og:title') || (html.match(/<title>([^<]*)<\/title>/i)?.[1] ? unesc(html.match(/<title>([^<]*)<\/title>/i)[1]) : null) || meta.title;
  const description = metaOf(html, 'property', 'og:description') || metaOf(html, 'name', 'description') || meta.description;
  const url = metaOf(html, 'property', 'og:url') || meta.url || null;
  const stripped = html.replace(/[ \t]*<meta\s+(?:property|name)="(?:og|twitter):[^"]*"[^>]*>[ \t]*\n?/gi, '');
  return stripped.replace(/<\/head>/i, `${metaTags({ ...meta, title: meta.forceTitle ? meta.title : title, description: meta.forceTitle ? meta.description : description, url })}\n</head>`);
}

// the league pages (/nfl … /esports/dota2, as leagues.js serves them) and the
// board's league keys each counts; a card for one reads the odds screen and
// the shopper for those keys
const LEAGUE_PAGES = {
  nfl: { path: '/nfl', name: 'NFL', keys: ['nfl'] },
  nba: { path: '/nba', name: 'NBA', keys: ['nba'] },
  nhl: { path: '/nhl', name: 'NHL', keys: ['nhl'] },
  cfb: { path: '/cfb', name: 'College football', keys: ['ncaaf'] },
  cbb: { path: '/cbb', name: 'College basketball', keys: ['ncaab'] },
  mlb: { path: '/mlb', name: 'MLB', keys: ['mlb'] },
  soccer: { path: '/soccer', name: 'Soccer', keys: ['epl', 'laliga', 'bundesliga', 'seriea', 'ligue1', 'mls', 'ligamx', 'eredivisie', 'brasileirao', 'ucl', 'uel'] },
  tennis: { path: '/tennis', name: 'Tennis', keys: ['tennis'] },
  lol: { path: '/esports/lol', name: 'League of Legends', keys: ['lol'], esports: true },
  cs2: { path: '/esports/cs2', name: 'Counter-Strike 2', keys: ['cs2', 'cs'], esports: true },
  valorant: { path: '/esports/valorant', name: 'Valorant', keys: ['val', 'valorant'], esports: true },
  dota2: { path: '/esports/dota2', name: 'Dota 2', keys: ['dota', 'dota2'], esports: true },
};
const leagueOfPath = p => Object.keys(LEAGUE_PAGES).find(k => LEAGUE_PAGES[k].path === String(p || '').replace(/\/+$/, '').toLowerCase()) || null;

// ── the share page: /share/<kind>?… ──
// What a pasted link opens: the card itself, what it is in words, and a button
// into the app's matching view. Crawlers read the tags; people see the card.
function sharePage({ title, description, image, url, open, openLabel = 'OPEN IN LINE REAPER', note = '', origin = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(clean(title))} | Line Reaper</title>
<meta name="description" content="${esc(clean(description))}">
<meta name="robots" content="noindex">
${metaTags({ title, description, image, url, alt: description })}
<meta name="theme-color" content="#080b10">
<style>
:root { color-scheme:dark; }
* { box-sizing:border-box; }
html, body { margin:0; background:#080b10; color:#e2e8f0; font:15px/1.5 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
main { max-width:860px; margin:0 auto; padding:20px 16px 40px; }
.brand { font:700 14px 'JetBrains Mono', ui-monospace, Menlo, monospace; letter-spacing:.12em; color:#e2e8f0; text-decoration:none; }
.brand b { color:#34d399; }
img { display:block; width:100%; height:auto; border:1px solid #1e2738; border-radius:10px; margin:14px 0; background:#080b10; aspect-ratio:${W} / ${H}; }
h1 { font-size:20px; margin:14px 0 4px; overflow-wrap:anywhere; }
p { color:#94a3b8; margin:0 0 10px; overflow-wrap:anywhere; }
.btns { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0; }
a.btn { font:700 12px 'JetBrains Mono', ui-monospace, Menlo, monospace; letter-spacing:.08em; color:#06110d; background:#34d399; border-radius:6px; padding:10px 14px; text-decoration:none; }
a.btn.ghost { color:#34d399; background:transparent; border:1px solid rgba(52,211,153,.45); }
.note { font-size:12px; color:#8391a7; }
</style>
</head>
<body>
<main>
<a class="brand" href="/">LINE <b>REAPER</b></a>
<h1>${esc(clean(title))}</h1>
<p>${esc(clean(description))}</p>
<img src="${esc(image)}" alt="${esc(clean(description))}" width="${W}" height="${H}">
<div class="btns"><a class="btn" href="${esc(open)}">${esc(openLabel)}</a><a class="btn ghost" href="${esc(image)}" download>SAVE IMAGE</a></div>
${note ? `<p class="note">${esc(note)}</p>` : ''}
<p class="note">The card is drawn from the live record and prices when it is opened, with the time it was read. Prices move: check each one at the venue before you bet. Line Reaper does not take bets. 21+.${origin ? '' : ''}</p>
</main>
</body>
</html>`;
}

// an app view to open from a share page: a share-link hash (#lr&…) or a ?start=
// screen. Anything else falls back to the app's front.
function safeOpen(to) {
  const s = String(to || '');
  if (/^#lr(&[\w.~%+-]+=[\w.~%+,!*-]*){0,40}$/.test(s) && s.length <= 600) return `/app${s}`;
  if (/^\?start=[a-z]{2,20}$/.test(s)) return `/app${s}`;
  return '/app';
}

module.exports = { W, H, FONT, CHAR, fit, wrap, textW, fillText, priceCard, moveCard, leagueCard, recordCardSvg, bettorCard, boardCard, digestCard, alertsCard, emptyCard, pickSeries, chartSvg,
  renderPng, metaTags, injectMeta, LEAGUE_PAGES, leagueOfPath, sharePage, safeOpen, americanOfDec, PRICE_LABEL, MOVE_LABEL, LEAGUE_LABEL, FONT_FILES };
