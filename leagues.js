// ─── LEAGUE PAGES: ONE PUBLIC PAGE PER LEAGUE FOR SEARCH ─────────────────────
// /nfl, /nba, /nhl, /cfb, /cbb, /mlb, /soccer, /tennis and /esports/lol, /cs2,
// /valorant, /dota2, with /leagues listing them. Server-rendered from the live
// board when the page is asked for, the same for everyone (never the viewer's
// cookies or settings):
//   - the board: games and markets in the next 48 hours, how many have a fair
//     (Pinnacle's no-vig price), the venues a resident of the picked state
//     can use (?state=XX, Texas when none; venues.js), and the best prices
//     there above that fair with what the exchange book fills.
//     Every row is labelled research: a price above fair is not a record.
//   - the record: only what the strict public record (claims.js, the same test
//     as RESULTS and the sales page) marks proven. The record is kept per kind
//     and venue, never per league, so a proven kind shows its whole count and
//     how many of those graded games were in this league; nothing is pooled
//     or re-scored here.
//   - links into the matching app view with the share-link scheme
//     (/app#lr&t=...), so the visitor lands on the same league.
// With PAYWALL on, a visitor who is not signed in sees prices and counts, not
// the fair or the EV: the same split as the app's free view.
//
// Pure: render(slug, data, { origin }) and index(data, { origin }) → HTML;
// the server builds `data` from its own state (leagueData in server.js).

const { CSS, LOGO, FAVICON, esc } = require('./learn');
const oddsFmt = require('./oddsfmt');

// keys: the board's league keys (oddsscreen/shopper) and the record's sport
// keys; props: the PROPS tab's sport chip; lines: the game-lines league (one
// key); es: the esports board's game and the matchups engine, where there is one
const LEAGUES = {
  nfl: { path: '/nfl', name: 'NFL', long: 'NFL', noun: 'NFL games', keys: ['nfl'], lines: 'nfl', props: 'NFL',
    labels: ['Exchange Shopper', 'NFL model', 'Pick\'em leg flags'] },
  nba: { path: '/nba', name: 'NBA', long: 'NBA', noun: 'NBA games', keys: ['nba'], lines: 'nba', props: 'NBA', propsView: 'model',
    labels: ['Exchange Shopper', 'NBA, CFB and CBB props models', 'Injury news', 'Pick\'em leg flags'] },
  nhl: { path: '/nhl', name: 'NHL', long: 'NHL', noun: 'NHL games', keys: ['nhl'], lines: 'nhl', props: 'NHL',
    labels: ['Exchange Shopper', 'Kalshi maker bids', 'Pick\'em leg flags'] },
  cfb: { path: '/cfb', name: 'CFB', long: 'college football', noun: 'college football games', keys: ['ncaaf'], lines: 'ncaaf', props: 'CFB', propsView: 'cfbmodel',
    labels: ['Exchange Shopper', 'NBA, CFB and CBB props models', 'Pick\'em leg flags'] },
  cbb: { path: '/cbb', name: 'CBB', long: 'college basketball', noun: 'college basketball games', keys: ['ncaab'], lines: 'ncaab', propsView: 'cbbmodel',
    labels: ['Exchange Shopper', 'NBA, CFB and CBB props models', 'Pick\'em leg flags'] },
  mlb: { path: '/mlb', name: 'MLB', long: 'MLB', noun: 'MLB games', keys: ['mlb'], lines: 'mlb', props: 'MLB', propsView: 'mlb',
    labels: ['Exchange Shopper', 'Pick\'em leg flags'] },
  soccer: { path: '/soccer', name: 'Soccer', long: 'soccer', noun: 'soccer matches',
    keys: ['epl', 'laliga', 'bundesliga', 'seriea', 'ligue1', 'mls', 'ligamx', 'eredivisie', 'brasileirao', 'ucl', 'uel'], props: 'SOCCER', es: { emu: 'SOCCER' },
    labels: ['Exchange Shopper', 'Esports matchups (LoL, CS2, Valorant, Dota 2) and soccer', 'Pick\'em leg flags'] },
  tennis: { path: '/tennis', name: 'Tennis', long: 'tennis', noun: 'tennis matches', keys: ['tennis'], lines: 'tennis', props: 'TENNIS',
    labels: ['Exchange Shopper', 'Pick\'em leg flags'] },
  lol: { path: '/esports/lol', name: 'LoL', long: 'League of Legends', noun: 'League of Legends matches', esports: true, keys: ['LOL', 'lol'], props: 'LOL', es: { game: 'LOL', emu: 'LOL' },
    labels: ['Esports matchups (LoL, CS2, Valorant, Dota 2) and soccer', 'Pick\'em leg flags'] },
  cs2: { path: '/esports/cs2', name: 'CS2', long: 'Counter-Strike 2', noun: 'CS2 matches', esports: true, keys: ['CS2', 'cs2', 'CS', 'cs'], props: 'CS', es: { game: 'CS2', emu: 'CS2' },
    labels: ['Esports matchups (LoL, CS2, Valorant, Dota 2) and soccer', 'Pick\'em leg flags'] },
  valorant: { path: '/esports/valorant', name: 'Valorant', long: 'Valorant', noun: 'Valorant matches', esports: true, keys: ['VAL', 'val', 'valorant'], props: 'VAL', es: { game: 'VAL', emu: 'VAL' },
    labels: ['Esports matchups (LoL, CS2, Valorant, Dota 2) and soccer', 'Pick\'em leg flags'] },
  dota2: { path: '/esports/dota2', name: 'Dota 2', long: 'Dota 2', noun: 'Dota 2 matches', esports: true, keys: ['DOTA', 'dota', 'dota2'], props: 'DOTA', es: { game: 'DOTA' },
    labels: ['Esports matchups (LoL, CS2, Valorant, Dota 2) and soccer', 'Pick\'em leg flags'] },
};
const ORDER = Object.keys(LEAGUES);
const bySlug = slug => (Object.prototype.hasOwnProperty.call(LEAGUES, slug) ? LEAGUES[slug] : null);
const byPath = p => ORDER.find(k => LEAGUES[k].path === p) || null;

// links into the app, in the share-link format the app decodes (LRShare in
// public/index.html; test/leagues.test.js runs them through it)
function appLinks(cfg, st = null) {
  const out = [];
  if (!cfg.esports) {
    out.push({ label: 'Best prices above fair', href: `/app#lr&t=odds&m=opps&lg=${cfg.keys.join(',')}` });
    if (cfg.lines) out.push({ label: 'Every venue side by side', href: `/app#lr&t=odds&lg=${cfg.lines}` });
  }
  if (cfg.es?.game) out.push({ label: 'Match board', href: `/app#lr&t=esports&g=${cfg.es.game}` });
  if (cfg.es?.emu) out.push({ label: cfg.es.emu === 'SOCCER' ? 'Soccer model (not an edge)' : 'Matchup model (not an edge)', href: `/app#lr&t=esports&em=matchups&eg=${cfg.es.emu}` });
  if (cfg.props) out.push({ label: 'Pick\'em lines', href: `/app#lr&t=props&sp=${cfg.props}` });
  if (cfg.propsView) out.push({ label: cfg.propsView === 'mlb' ? 'MLB vs Pinnacle (research)' : 'Props model (not an edge)', href: `/app#lr&t=props&pv=${cfg.propsView}` });
  // a state picked on the page opens the app on it too (for that visit, as a share link does)
  return st && /^[A-Z]{2}$/.test(st) && st !== 'TX' ? out.map(l => ({ ...l, href: `${l.href}&st=${st.toLowerCase()}` })) : out;
}

// American odds in the page's format (?odds=, the app's CUSTOMIZE > Odds format; American when none)
const am = (a, fmt = 'american') => (a == null || !Number.isFinite(a) ? '—' : oddsFmt.fromAm(a, fmt));
const pct = (x, n = 1) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(n)}%`);
const spct = (x, n = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(n)}%`);
const cents = p => (p == null || !Number.isFinite(p) ? '—' : `${(p * 100).toFixed(1).replace(/\.0$/, '')}¢`);
const usd = n => `$${Math.round(n).toLocaleString('en-US')}`;
const when = (t, now) => {
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return '—';
  const m = Math.round((ms - now) / 60000);
  if (m <= 0) return 'started';
  if (m < 60) return `in ${m} min`;
  if (m < 1440) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return new Date(ms).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
};
const readAgo = (t, now) => {
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return 'not read yet';
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return `${new Date(ms).toISOString().slice(11, 16)} UTC (${m < 1 ? 'just now' : `${m} min ago`})`;
};

// what an exchange book fills at the shown price (depthbook tiers), in words.
// A sportsbook posts no size; a book not read yet says so
function sizeText(size, { exchange = false } = {}) {
  if (!size) return exchange ? 'size not read' : 'no size posted';
  if (size.unread) return 'book not read yet';
  const tiers = size.tiers || {};
  const full = Object.keys(tiers).map(Number).filter(k => tiers[k] && tiers[k].full).sort((a, b) => b - a);
  if (full.length) return `fills ${usd(full[0])}${full[0] >= 1000 ? '+' : ''}`;
  if (size.topUsd > 0) return `only ${usd(size.topUsd)} at this price`;
  return 'nothing at this price';
}

const head = ({ title, description, canonical, origin }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index,follow">
<meta name="theme-color" content="#080b10">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Line Reaper">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}
${origin ? `<meta property="og:image" content="${esc(origin)}/og.png">` : ''}
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${FAVICON}">
<style>${CSS}${PAGE_CSS}</style>
</head>`;

const PAGE_CSS = `
.stats { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:10px; margin:0 0 20px; }
.stat { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:10px 12px; min-width:0; }
.stat b { display:block; font:700 20px var(--mono); color:var(--text); }
.stat span { font:600 10px var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.tag { display:inline-block; font:600 10px var(--mono); letter-spacing:.08em; text-transform:uppercase; border:1px solid var(--border2); color:var(--text2); border-radius:4px; padding:1px 6px; white-space:nowrap; }
.tag.pv { color:var(--green2); border-color:rgba(52,211,153,.5); }
.links { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 20px; }
.links .go { margin:0; }
.venues { color:var(--text2); font-size:14px; }
.sub { display:block; color:var(--muted); font-size:11px; font-family:var(--mono); }
.st-pick { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0 0 16px; font:500 12px var(--mono); color:var(--muted); }
.st-pick select, .st-pick button { background:var(--card); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px 8px; font:600 12px var(--mono); max-width:100%; }
.st-pick button { cursor:pointer; letter-spacing:1px; }
.st-pick span { flex-basis:100%; font-size:11px; }
.lg-list { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; list-style:none; padding:0; margin:0 0 20px; }
.lg-list a { display:block; background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 12px; color:var(--text); text-decoration:none; font-weight:600; }
.lg-list a span { display:block; font:500 11px var(--mono); color:var(--muted); }
.lg-list a:hover { border-color:var(--text2); }
.empty { background:var(--card); border:1px dashed var(--border2); border-radius:10px; padding:14px 16px; color:var(--text2); margin:0 0 18px; }
@media (max-width:600px) {
  table.bd thead { display:none; }
  table.bd tr { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:6px 10px; padding:10px 0; border-bottom:1px solid var(--border); }
  table.bd td { border:0; padding:0; min-width:0; overflow-wrap:anywhere; }
  table.bd td:first-child { grid-column:1 / -1; }
  table.bd td[data-l]:not(:first-child)::before { content:attr(data-l); display:block; font:600 9px var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .stats { grid-template-columns:repeat(2, minmax(0, 1fr)); } .stat b { font-size:18px; } }
`;

const foot = () => `<footer><div class="in"><nav><a href="/">Line Reaper</a><a href="/leagues">Leagues</a>${ORDER.map(k => `<a href="${LEAGUES[k].path}">${esc(LEAGUES[k].name)}</a>`).join('')}<a href="/learn">Learn</a><a href="/status">Status</a><a href="/terms">Terms</a><a href="/responsible-gambling">Responsible gambling</a></nav>
<div>Line Reaper is an information service, not a sportsbook. It does not take or place bets. Prices are what each feed showed at its last read: check the price at the venue before you bet. Nothing on this page is a proven edge unless the record below says proven. 21+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></div></footer>`;
const top = () => `<header class="top"><div class="top-in"><a class="brand" href="/">${LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app">OPEN THE APP</a></div></header>`;

// the query a page keeps on its links to other league pages: the picked state
// and odds format, each only when it is not the default (Texas, American)
const keepQs = (st, fmt) => {
  const p = new URLSearchParams();
  if (st && st.code && st.code !== 'TX') p.set('state', st.code);
  if (fmt && fmt !== 'american') p.set('odds', fmt);
  const q = p.toString();
  return q ? `?${q}` : '';
};
// the picked state: { code, name, kalshi (its status there), states: [[code, name]] }; Texas when none
const TX = { code: 'TX', name: 'Texas', kalshi: 'yes', states: [] };
const stateOf = s => (s && s.code && s.name ? { ...TX, ...s } : TX);
// a plain GET form, so it works without JavaScript; the canonical URL stays the league's own
const statePicker = (path, st, fmt = 'american') => (st.states?.length ? `<form class="st-pick" method="get" action="${esc(path)}#board"><label for="stp">Betting from</label><select id="stp" name="state">${st.states.map(([c, n]) => `<option value="${esc(c)}"${c === st.code ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select><label for="sto">Odds</label><select id="sto" name="odds">${oddsFmt.OPTIONS.map(([v, n]) => `<option value="${esc(v)}"${v === fmt ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select><button type="submit">SHOW</button><span>Venues a resident can use, from our venue table (dated ${esc(st.asOf || '')}). Check with the venue before you deposit. Odds: the format the prices show in; exchange contracts stay in cents.</span></form>` : '');

// the record: proven kinds only, each with its whole count and this league's share of it
function recordHtml(cfg, rec, st = TX) {
  if (!rec) return '<div class="empty">The record could not be read just now. The full record is on <a href="/app?start=results">RESULTS</a>.</div>';
  const rows = (rec.proven || []).map(p => [
    `${esc(p.bookName)} ${esc(String(p.kindLabel || p.kind).toLowerCase())} <span class="tag pv">proven</span>`,
    `${p.graded} graded across every league${p.inLeague != null ? `; ${p.inLeague} of its graded flags in the public file were ${esc(cfg.noun)}` : ''}`,
    (p.inState ?? p.texas) ? `${esc(st.name)}: yes` : `Not a ${esc(st.name)} venue`,
    p.profitShown ? `profit ${p.units > 0 ? '+' : ''}${p.units}u` : 'Profit not shown yet',
  ]);
  const table = rows.length
    ? `<div class="scroll"><table><thead><tr><th>Kind</th><th>Graded</th><th>${esc(st.name)}</th><th>Profit</th></tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">Nothing is proven yet. The record shows every kind and why it is not proven on <a href="/app?start=results">RESULTS</a>.</div>';
  const tx = rows.length && !(rec.proven || []).some(p => p.inState ?? p.texas) ? `<p class="note">Nothing is proven yet at a venue a ${esc(st.name)} resident can use.</p>` : '';
  const labels = (rec.labels || []).filter(l => (cfg.labels || []).some(x => l.tool.startsWith(x)));
  const lab = labels.length ? `<h2 id="labels">Everything else on this page and in the app</h2>
<div class="scroll"><table><thead><tr><th>Tool</th><th>Label</th><th>Why</th></tr></thead><tbody>${labels.map(l => `<tr><td>${esc(l.tool)}<span class="sub">${esc(l.where)}</span></td><td><span class="tag">${esc(l.tag)}</span></td><td style="font-family:inherit">${esc(l.why)}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<p class="note">${esc(rec.ruleText || 'A kind is marked proven only with 50 graded games at one venue we read ourselves and a CLV t of 2 or more against Pinnacle\'s close.')} The record is kept per kind and venue, not per league.</p>${table}${tx}${lab}`;
}

// the board for a sports league: the state's best prices above Pinnacle's fair
function sportBoardHtml(cfg, b, now, st = TX, fmt = 'american') {
  if (!b || !b.markets) return `<div class="empty">No ${esc(cfg.noun)} on the board in the next 48 hours${b && b.stale ? ', and the feeds are behind right now' : ''}. The page fills in when the books post lines.</div>`;
  const stats = `<div class="stats"><div class="stat"><b>${b.games}</b><span>games, 48 h</span></div><div class="stat"><b>${b.markets}</b><span>markets</span></div><div class="stat"><b>${b.priced}</b><span>with a fair</span></div><div class="stat"><b>${b.pro ? b.above : '—'}</b><span>above fair, ${esc(st.code)}</span></div></div>`;
  const venues = b.venues?.length ? `<p class="venues">${esc(st.name)} venues on this board: ${b.venues.map(v => esc(v)).join(', ')}. Pinnacle is the reference for the fair and is not a US venue.</p>` : `<p class="venues">No ${esc(st.name)} venue prices these games right now; only the reference books do.</p>`;
  let rows = '';
  if (!b.pro) rows = `<div class="empty">${b.locked ? `${b.locked} ${esc(st.name)} price${b.locked === 1 ? ' sits' : 's sit'} above the fair right now.` : 'Nothing sits above the fair right now.'} The fair and the EV are in the app with Pro.</div>`;
  else if (!b.opps.length) rows = `<div class="empty">No ${esc(st.name)} price sits above Pinnacle's fair right now. That is the usual state: the exchanges track Pinnacle closely.</div>`;
  else {
    rows = `<div class="scroll"><table class="bd"><thead><tr><th>Game and pick</th><th>Venue</th><th>Price</th><th>Fair</th><th>EV</th><th>Fill</th><th>Label</th></tr></thead><tbody>${b.opps.map(o => `<tr>
<td>${esc(o.selection)}<span class="sub">${esc(o.event)} · ${esc(o.marketName)} · ${esc(when(o.start, now))}</span></td>
<td data-l="Venue">${esc(o.providerName)}</td><td data-l="Price">${esc(am(o.american, fmt))}</td><td data-l="Fair">${esc(am(o.fairAmerican, fmt))}<span class="sub">${esc(pct(o.fair))}</span></td><td data-l="EV">${esc(spct(o.ev))}</td>
<td data-l="Fill" style="font-family:inherit;font-size:13px">${esc(sizeText(o.size, { exchange: o.exchange }))}</td><td data-l="Label"><span class="tag${o.label === 'proven' ? ' pv' : ''}">${o.label === 'proven' ? 'proven kind' : 'research'}</span></td></tr>`).join('')}</tbody></table></div>
<p class="note">Price: the venue's price${b.anyExchange ? ', an exchange\'s all-in cost with its taker fee in' : ''}. Fair: Pinnacle's no-vig price (power method). EV at a $100 stake. Fill: what the exchange's book held at this price when it was last read. A price above fair is research: exchange flags have not beaten the close on our record.</p>`;
  }
  return stats + venues + rows;
}

// the board for an esports title: Kalshi's price beside the sharp reference
function esportsBoardHtml(cfg, b, now, st = TX) {
  if (!b || !b.matches?.length) return `<div class="empty">No ${esc(cfg.noun)} on the board right now. Kalshi lists ${esc(cfg.long)} matches a day or two ahead; the page fills in when it does.</div>`;
  const stats = `<div class="stats"><div class="stat"><b>${b.matches.length}</b><span>matches</span></div><div class="stat"><b>${b.kalshi}</b><span>on Kalshi</span></div><div class="stat"><b>${b.sharp}</b><span>with a sharp price</span></div><div class="stat"><b>${b.pro ? b.above : '—'}</b><span>under the sharp price</span></div></div>`;
  const row = m => `<tr><td data-l="">${esc(m.teams.join(' vs '))}<span class="sub">${esc(m.tournament || cfg.long)}${m.bestOf ? ` · Bo${m.bestOf}` : ''} · ${m.live ? 'live' : esc(when(m.start, now))}</span></td>
${m.sides.map((s, i) => `<td data-l="Side ${i + 1}">${esc(s.name)}<span class="sub">${s.cost != null ? `Kalshi ${esc(cents(s.cost))} fee in` : 'no Kalshi price'}${b.pro && s.ref != null ? ` · sharp ${esc(cents(s.ref))}` : ''}${b.pro && s.ev != null ? ` · EV ${esc(spct(s.ev))}` : ''}</span></td>`).join('')}</tr>`;
  return `${stats}<div class="scroll"><table class="bd"><thead><tr><th>Match</th><th>Side 1</th><th>Side 2</th></tr></thead><tbody>${b.matches.map(row).join('')}</tbody></table></div>
<p class="note">Kalshi is a CFTC exchange${st.kalshi === 'yes' ? ` a ${esc(st.name)} resident can use` : st.kalshi === 'no' ? `, not open to a ${esc(st.name)} resident on our venue table` : `; check with Kalshi whether a ${esc(st.name)} resident can trade sports there`}; its price is the all-in cost of one contract with the taker fee in. The sharp price is Pinnacle's no-vig chance where Pinnacle prices the match; most esports matches have none, and then nothing is judged. Our matchup model is a model, not an edge: the exchanges' prices beat it in walk-forward tests.</p>`;
}

function render(slug, data = {}, { origin = '' } = {}) {
  const cfg = bySlug(slug);
  if (!cfg) return null;
  const o = String(origin).replace(/[^\w.:/-]/g, '');
  const now = data.now ?? Date.now();
  const st = stateOf(data.state);
  const fmt = oddsFmt.fmtOf(data.fmt);
  const keep = keepQs(st, fmt);
  const title = cfg.esports ? `${cfg.long} odds: Kalshi prices vs the sharp line | Line Reaper` : `${cfg.name} odds comparison: best prices vs Pinnacle's fair | Line Reaper`;
  const description = cfg.esports
    ? `Live ${cfg.long} match prices on Kalshi beside Pinnacle's no-vig price where one exists, with our matchup model labelled a model, not an edge. Read live, the same for everyone.`
    : `Live ${cfg.long} odds from the exchanges a ${st.name} resident can use against Pinnacle's no-vig fair, with what each exchange book fills. Only what the record proves is called proven.`;
  const links = appLinks(cfg, st.code).map(l => `<a class="go" href="${esc(l.href)}">${esc(l.label)} →</a>`).join('');
  const board = cfg.esports ? esportsBoardHtml(cfg, data.board, now, st) : sportBoardHtml(cfg, data.board, now, st, fmt);
  return `${head({ title, description, canonical: o ? `${o}${cfg.path}` : null, origin: o })}
<body>
${top()}
<main>
<p class="kicker"><a href="/leagues${esc(keep)}" style="color:inherit;text-decoration:none">Leagues</a> · ${esc(cfg.name)}</p>
<h1>${esc(cfg.esports ? `${cfg.long} odds` : `${cfg.name} odds comparison`)}</h1>
<p class="lead">${esc(cfg.esports ? `Every ${cfg.long} match Kalshi lists, with the sharp price beside it where there is one.` : `Every ${cfg.long} price we read, against Pinnacle's no-vig fair, cut to the venues a ${st.name} resident can use.`)} Board read ${esc(readAgo(data.board?.readAt, now))}.</p>
<div class="links">${links}</div>
${statePicker(cfg.path, st, fmt)}
<h2 id="board">${cfg.esports ? 'Match board' : `Best ${esc(st.name)} prices above the fair`}</h2>
${board}
<h2 id="record">What the record says</h2>
${recordHtml(cfg, data.record, st)}
<h2 id="more">More leagues</h2>
${leagueList(cfg, keep)}
</main>
${foot()}
</body>
</html>`;
}

const leagueList = (cur = null, keep = '') => `<ul class="lg-list">${ORDER.filter(k => !cur || LEAGUES[k] !== cur).map(k => `<li><a href="${LEAGUES[k].path}${esc(keep)}">${esc(LEAGUES[k].name)}<span>${esc(LEAGUES[k].esports ? 'esports' : LEAGUES[k].long)}</span></a></li>`).join('')}</ul>`;

function index(data = {}, { origin = '' } = {}) {
  const o = String(origin).replace(/[^\w.:/-]/g, '');
  const st = stateOf(data.state);
  const fmt = oddsFmt.fmtOf(data.fmt);
  const keep = keepQs(st, fmt);
  const title = 'Odds by league: NFL, NBA, college, soccer, tennis and esports | Line Reaper';
  const description = 'One page per league with live prices from the venues a Texas resident can use against Pinnacle\'s no-vig fair, and only what the record proves called proven.';
  return `${head({ title, description, canonical: o ? `${o}/leagues` : null, origin: o })}
<body>
${top()}
<main>
<p class="kicker">Leagues</p>
<h1>Odds by league</h1>
<p class="lead">Each page reads the live board when you open it: the venues a ${esc(st.name)} resident can use, Pinnacle's no-vig fair, and the record's verdict, the same for everyone.</p>
${statePicker('/leagues', st, fmt)}
${leagueList(null, keep)}
<h2 id="record">What the record says</h2>
${recordHtml({ noun: 'games', labels: ['Exchange Shopper', 'Pick\'em leg flags'] }, data.record ? { ...data.record, proven: (data.record.proven || []).map(p => ({ ...p, inLeague: null })) } : null, st)}
</main>
${foot()}
</body>
</html>`;
}

module.exports = { LEAGUES, ORDER, bySlug, byPath, appLinks, sizeText, render, index };
