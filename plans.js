// ─── PLANS: FREE AND PRO ──────────────────────────────────────────────────────
// One place that says what each plan gets. The server enforces the limits
// below (API calls, API keys per account, the Discord feed, live alerts and
// push), and the /pricing page, the sales page's plan lists and /api/plans are
// all rendered from the same FEATURES table, so the page can never promise
// something the server does not do.
//
// Nothing changes until PAYWALL=on: with it off everyone is on Pro (the full
// tier), exactly as before. The admin token and comped accounts are always Pro.
//
// What a plan never changes (CFTC 4.14(a)(9), and the record rules): every
// member gets the same alerts, the same text and the same units. Nothing is
// sized or picked per person, nothing places a bet, and paying buys the tool,
// not an edge: only what RESULTS marks proven is called proven.

const learn = require('./learn');
const { LIMITS: API_PRO } = require('./publicapi');

const LIMITS = {
  free: { apiPerMinute: 10, apiPerDay: 500, apiKeys: 1, discordFeed: false, liveAlerts: false, pushAlerts: false, historyDays: 3 },
  pro: { apiPerMinute: API_PRO.perMinute, apiPerDay: API_PRO.perDay, apiKeys: 5, discordFeed: true, liveAlerts: true, pushAlerts: true, historyDays: 30 },
};
const PLAN_IDS = Object.keys(LIMITS);

// One row per feature. free/pro: true (included), false (not included) or a
// short string saying how much. `where` is the tab or page it lives on; `gate`
// says how the server holds it back, for the engineering record and tests.
const FEATURES = [
  { id: 'screen', group: 'Odds', label: 'Odds screen: every venue we read, side by side', where: 'ODDS SCREEN', free: true, pro: true, gate: 'none' },
  { id: 'fair', group: 'Odds', label: 'Pinnacle no-vig fair price, EV and line history', where: 'ODDS SCREEN, SHOPPER', free: 'How many prices sit above the fair', pro: true, gate: 'oddsScreen.stripPro, shopper.stripPro' },
  { id: 'history', group: 'Odds', label: 'Line history: every market\'s prices at each venue, Pinnacle included, with a chart and a CSV or JSON download', where: '/lines, /api/v1/lines', free: `The last ${LIMITS.free.historyDays} days`, pro: `${LIMITS.pro.historyDays} days`, gate: 'limitsOf(plan).historyDays' },
  { id: 'shopper', group: 'Odds', label: 'Exchange Shopper ranked list, with what the order book fills at your stake', where: 'SHOPPER', free: 'Prices only', pro: true, gate: 'shopper.stripPro' },
  { id: 'best', group: 'Odds', label: 'Best Plays, ranked by their own record', where: 'BEST PLAYS', free: 'Top 3', pro: 'Every play', gate: 'BEST_FREE_PREVIEW' },
  { id: 'arbs', group: 'Odds', label: 'Arbs and middles with legs, prices and stakes', where: 'ARBS', free: 'Count and profit %', pro: true, gate: '/api/xarbs free view' },
  { id: 'props', group: 'Models', label: 'Pick\'em and props boards, priced against the sharp number', where: 'PROPS', free: 'The board; picks on lines above the fair hidden', pro: true, gate: 'redactForFree' },
  { id: 'esports', group: 'Models', label: 'Esports match boards and our ratings (tagged model, not an edge)', where: 'MATCHUPS', free: 'Match boards', pro: true, gate: 'redactForFree, requirePro on best slips' },
  { id: 'tail', group: 'Research', label: 'Sharp Tail (research): big accounts\' entries with the trader and price', where: 'SHARP TAIL', free: '30 minute delay', pro: 'Real time', gate: 'TAIL_FREE_DELAY_MS' },
  { id: 'alerts', group: 'Alerts', label: 'Live alerts in the app, and phone push', where: 'CUSTOMIZE > Push alerts', free: false, pro: 'Same text for every member', gate: 'requirePro on /api/ev/stream, /api/esports/stream, /api/push/subscribe' },
  { id: 'feed', group: 'Alerts', label: 'The Line Reaper feed in your Discord server (weekly digest, record changes, biggest moves)', where: '/developers#feed', free: false, pro: 'One channel per key; the same posts for everyone', gate: 'PUT /api/v1/feed/discord, feed subscribers' },
  { id: 'bot', group: 'Alerts', label: 'Line Reaper commands in your Discord server or Telegram group (/odds, /props, /moves, /record, /lines), under your own bot', where: '/developers#bot', free: 'Within the key\'s API limits', pro: 'Within the key\'s API limits', gate: 'PUT /api/v1/bot/discord or /api/v1/bot/telegram, each command spends an API call' },
  { id: 'api', group: 'API', label: 'Public API calls', where: '/developers', free: `${LIMITS.free.apiPerMinute} a minute, ${LIMITS.free.apiPerDay.toLocaleString('en-US')} a day`, pro: `${LIMITS.pro.apiPerMinute} a minute, ${LIMITS.pro.apiPerDay.toLocaleString('en-US')} a day`, gate: 'v1Auth limiter' },
  { id: 'apiFair', group: 'API', label: 'Fair prices and EV in the API', where: '/api/v1/best-prices', free: false, pro: false, note: 'Held back from the API for everyone once the paywall is on', gate: 'v1FullTier' },
  { id: 'keys', group: 'API', label: 'API keys per account', where: '/developers', free: String(LIMITS.free.apiKeys), pro: `Up to ${LIMITS.pro.apiKeys}`, gate: 'POST /api/v1/keys' },
  { id: 'widgets', group: 'API', label: 'Widgets for your own site (best price, line move, record)', where: '/developers', free: true, pro: true, gate: 'none' },
  { id: 'record', group: 'Record', label: 'The full public record and the weekly digest, losers included', where: 'RESULTS', free: true, pro: true, gate: 'none' },
  { id: 'alertHistory', group: 'Record', label: 'Every alert we sent, with each bet graded against the close', where: '/alerts, RESULTS > ALERT HISTORY', free: 'Bets shown once their games start', pro: 'Live', gate: 'alertlog.view full' },
  { id: 'bettor', group: 'Record', label: 'Your own public bettor record at /r/your-name, with CSV, JSON and a share card', where: 'MY SLIPS > PUBLISH RECORD', free: true, pro: true, gate: 'none' },
  { id: 'leaderboard', group: 'Record', label: 'The bettor leaderboard: published records ranked by CLV against Pinnacle\'s close, ranked only at 50 graded', where: '/r', free: true, pro: true, gate: 'none' },
  { id: 'tools', group: 'Record', label: 'Calculators, MY BETS, MY SLIPS, imports, EXPORT and PRINT', where: 'TOOLS, MY BETS, MY SLIPS', free: true, pro: true, gate: 'none' },
  { id: 'views', group: 'Record', label: 'Saved views, favorites, My state, odds format, after-fee prices', where: 'CUSTOMIZE, SHOPPER', free: true, pro: true, gate: 'none' },
];
// The fair-in-the-API row is a rule for everyone, not a plan difference: kept
// in the table so /api/plans says it, left off the plan cards.
const CARD_FEATURES = FEATURES.filter(f => f.free !== false || f.pro !== false);

const WHAT_IT_IS_NOT = [
  'Paying buys the tool, not an edge. A price above the fair is a price, not a proven edge, and every row carries its label.',
  'Only what RESULTS marks proven is called proven: 50 graded at one venue read straight from that venue, CLV t of 2 against Pinnacle\'s no-vig close, kinds never pooled.',
  'Every member gets the same alerts, the same text and the same units. Nothing is sized, picked or set up per person.',
  'Line Reaper never places a bet and never holds your money. You bet at the venue yourself.',
];

const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);
// 'pro' or 'free'. paywall off: everyone is Pro. admin: always Pro.
// pro: whether the account counts as paid (auth.isPro, which knows comps,
// grace periods and cancellations).
function planOf({ paywall = false, admin = false, pro = false } = {}) {
  if (!paywall || admin || pro) return 'pro';
  return 'free';
}
const limitsOf = plan => LIMITS[plan] || LIMITS.free;

// the switch: what has to be set for PAYWALL=on to take money and keep it.
// Booleans and names only, never a value.
function readiness(env = process.env, { billingConfigured = false } = {}) {
  const set = k => !!String(env[k] || '').trim();
  const items = [
    { key: 'STRIPE_SECRET_KEY', ok: set('STRIPE_SECRET_KEY'), why: 'takes the payment' },
    { key: 'STRIPE_PRICE_ID', ok: set('STRIPE_PRICE_ID'), why: 'the monthly Pro price in Stripe' },
    { key: 'STRIPE_WEBHOOK_SECRET', ok: set('STRIPE_WEBHOOK_SECRET'), why: 'turns a payment into Pro on the account' },
    { key: 'AUTH_SECRET', ok: set('AUTH_SECRET'), why: 'keeps people signed in across restarts' },
    { key: 'DATABASE_URL', ok: set('DATABASE_URL'), why: 'keeps accounts across deploys' },
    { key: 'LEGAL_EMAIL', ok: set('LEGAL_EMAIL'), why: 'the contact on the legal pages' },
    { key: 'LEGAL_STATE', ok: set('LEGAL_STATE'), why: 'the governing state in the terms' },
  ];
  const missing = items.filter(i => !i.ok).map(i => i.key);
  return { paywall: /^(1|on|true|yes)$/i.test(String(env.PAYWALL || '')), billing: !!billingConfigured, ready: !missing.length, missing, items };
}

// The price people see. Stripe's own price wins once it has been read (so the
// page can't show a number Stripe won't charge); PRICE_MONTHLY until then.
// The founding price shows only while it can really be bought: before the
// paywall (a promise to early members), or with STRIPE_INTRO_PRICE_ID set and
// seats left.
function priceView({ env = process.env, paywall = false, stripe = null, introStripe = null, foundingTaken = 0 } = {}) {
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  const monthly = stripe && Number.isFinite(stripe.amount) ? stripe.amount : num(env.PRICE_MONTHLY, 79);
  const introRaw = introStripe && Number.isFinite(introStripe.amount) ? introStripe.amount : num(env.PRICE_INTRO, 49);
  const seats = Math.round(num(env.INTRO_SEATS, 100));
  const left = Math.max(0, seats - Math.max(0, foundingTaken | 0));
  const introSellable = !paywall || (!!String(env.STRIPE_INTRO_PRICE_ID || '').trim() && left > 0);
  const intro = introRaw > 0 && introRaw < monthly && seats > 0 && introSellable ? introRaw : null;
  const currency = String((stripe && stripe.currency) || 'usd').toUpperCase();
  return { monthly, intro, seats, seatsLeft: paywall ? left : seats, currency, symbol: currency === 'USD' ? '$' : `${currency} `, fromStripe: !!(stripe && Number.isFinite(stripe.amount)) };
}
const money = n => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// what /api/plans answers: the same for everyone except `viewer`
function plansBody({ paywall, billingConfigured, price, viewerPlan = null, signedIn = false }) {
  return {
    paywall, onSale: !!(paywall && billingConfigured),
    note: paywall ? null : 'Early access: every Pro feature is free while the paywall is off.',
    price: { monthly: price.monthly, intro: price.intro, seats: price.seats, seatsLeft: price.seatsLeft, currency: price.currency },
    plans: PLAN_IDS.map(id => ({ id, name: id === 'pro' ? 'Pro' : 'Free', monthly: id === 'pro' ? price.monthly : 0, limits: LIMITS[id] })),
    features: FEATURES.map(({ gate, ...f }) => f),
    rules: WHAT_IT_IS_NOT,
    viewer: { plan: viewerPlan, signedIn },
    page: '/pricing',
  };
}

// ── the /pricing page ──
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = x => (x == null || !Number.isFinite(x) ? 'n/a' : `${x > 0 ? '+' : ''}${(Math.round(x * 10) / 10).toFixed(1)}%`);
const TICK = c => `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 6.5l3 3 6-7" stroke="${c}" stroke-width="1.6" fill="none"/></svg>`;
const DASH = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7" stroke="#7b8a9f" stroke-width="1.6"/></svg>';

// The plan cards' bullet lists, for the sales page too. plan: 'free' | 'pro'.
function planListHtml(plan) {
  const c = plan === 'pro' ? '#10b981' : '#94a3b8';
  return CARD_FEATURES.filter(f => f[plan] !== false).map(f => {
    const v = f[plan];
    const extra = typeof v === 'string' ? `: ${esc(v)}` : '';
    return `<li>${TICK(c)}${esc(f.label)}${extra}</li>`;
  }).join('\n          ');
}

const cell = v => (v === true ? `<span class="yes">${TICK('#10b981')}<span class="sr">Included</span></span>` : v === false ? `<span class="no">${DASH}<span class="sr">Not included</span></span>` : esc(v));

const PRICING_CSS = `
main { max-width:900px; }
.top-in { max-width:900px; }
.early { border:1px solid rgba(52,211,153,.35); background:rgba(16,185,129,.07); border-radius:10px; padding:12px 14px; margin:0 0 20px; font-size:15px; }
.cards { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px; margin:0 0 22px; }
.card { border:1px solid var(--border); background:var(--card); border-radius:12px; padding:18px 18px 16px; min-width:0; display:flex; flex-direction:column; }
.card.pro { border-color:rgba(52,211,153,.45); }
.pname { font:600 11px var(--mono); letter-spacing:.14em; color:var(--text2); }
.card.pro .pname { color:var(--green2); }
.price { font-size:40px; font-weight:700; letter-spacing:-1px; line-height:1.1; margin:6px 0 2px; }
.price span { font-size:14px; font-weight:500; color:var(--text2); letter-spacing:0; margin-left:4px; }
.intro { font-size:13px; color:var(--green2); min-height:20px; }
.card ul { list-style:none; padding:0; margin:12px 0 16px; font-size:14px; flex:1; }
.card li { display:flex; gap:8px; align-items:flex-start; overflow-wrap:anywhere; }
.card li svg { flex:0 0 12px; margin-top:6px; }
.cta { display:block; text-align:center; font:600 12px var(--mono); letter-spacing:.06em; color:var(--text); text-decoration:none; border:1px solid var(--border2); border-radius:6px; padding:10px 14px; }
.card.pro .cta { color:#04130c; background:var(--green); border-color:var(--green); }
.cta-note { font-size:12px; color:var(--muted); margin:8px 0 0; text-align:center; }
.cmp td, .cmp th { overflow-wrap:anywhere; }
.cmp td { font-family:inherit; font-size:13px; }
.cmp td:first-child { width:52%; }
.cmp .grp td { font:600 10px var(--mono); letter-spacing:.12em; text-transform:uppercase; color:var(--muted); padding-top:16px; }
.cmp .where { display:block; font:500 10px var(--mono); letter-spacing:.06em; color:var(--muted); text-transform:uppercase; margin-top:2px; }
.yes svg, .no svg { vertical-align:middle; }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.rec { border:1px solid var(--border); background:var(--card); border-radius:10px; padding:12px 14px; margin:0 0 16px; font-size:14px; }
.rec ul { margin:6px 0 0; }
.rules li { color:var(--text2); }
@media (max-width:640px) { .cards { grid-template-columns:minmax(0, 1fr); } .price { font-size:34px; } .cmp td:first-child { width:46%; } }
`;

// claims: the /api/claims body (claims.publicClaims), so the page says what
// the record proves today, read from the same place as the sales page
function pricingPage({ origin = '', paywall = false, billingConfigured = false, accounts = false, price, claims = null, legalEmail = '' } = {}) {
  const o = String(origin).replace(/[^\w.:/-]/g, '');
  const sym = price.symbol;
  const onSale = paywall && billingConfigured;
  let proCta, proNote;
  if (!paywall) { proCta = '<a class="cta" href="/app">OPEN THE APP: PRO IS FREE NOW</a>'; proNote = 'Early access: every Pro feature is on for everyone until the paywall goes on.'; }
  else if (onSale) { proCta = '<a class="cta" href="/app?start=pro">GET PRO</a>'; proNote = 'Checkout is Stripe. Cancel any time in BILLING in the app.'; }
  else { proCta = `<a class="cta" href="${esc(legalEmail ? `mailto:${legalEmail}` : '/legal#contact')}">ASK ABOUT PRO</a>`; proNote = 'Pro checkout is not open yet.'; }
  const freeCta = accounts ? '<a class="cta" href="/app?start=signup">CREATE A FREE ACCOUNT</a>' : '<a class="cta" href="/app">START FREE</a>';
  const intro = price.intro != null
    ? `${sym}${money(price.intro)} a month for the first ${price.seats} members${paywall ? ` (${price.seatsLeft} left)` : ''}`
    : '';
  // the record today, from claims.publicClaims
  let rec = '<p class="note">The record could not be read just now. RESULTS in the app always shows it.</p>';
  if (claims) {
    const proven = claims.proven || [];
    const tx = claims.texas?.proven || [];
    rec = proven.length
      ? `<p>What RESULTS marks proven today:</p><ul>${proven.map(p => `<li>${esc(p.kindLabel)} at ${esc(p.bookName)}: ${p.graded} graded, CLV ${pct(p.clv)} against the close, ${p.profitShown ? 'profit shown' : 'profit not shown yet (it has not cleared chance)'}${p.texas ? '' : '; not open to Texas residents'}</li>`).join('')}</ul>`
      : '<p>Nothing is proven yet. Every tool is labelled a price, a model or research until its own record clears the test.</p>';
    if (proven.length && !tx.length) rec += `<p class="note">Nothing is proven yet at a venue a ${esc(claims.texas?.name || 'Texas')} resident can use.</p>`;
  }
  let lastGroup = '';
  const rows = FEATURES.map(f => {
    const g = f.group !== lastGroup ? `<tr class="grp"><td colspan="3">${esc(f.group)}</td></tr>` : '';
    lastGroup = f.group;
    const both = f.free === false && f.pro === false;
    return `${g}<tr><td>${esc(f.label)}<span class="where">${esc(f.where)}</span></td>${both ? `<td colspan="2">${esc(f.note || 'Not offered')}</td>` : `<td>${cell(f.free)}</td><td>${cell(f.pro)}</td>`}</tr>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pricing: Free and Pro | Line Reaper</title>
<meta name="description" content="Line Reaper's plans: a free odds screen and public record, and Pro with fair prices, EV, live alerts and more API calls. Paying buys the tool, not an edge.">
${o ? `<link rel="canonical" href="${esc(o)}/pricing">` : ''}
<meta name="theme-color" content="#080b10">
<link rel="icon" href="${learn.FAVICON}">
<style>${learn.CSS}${PRICING_CSS}</style>
</head>
<body>
<header class="top"><div class="top-in"><a class="brand" href="/">${learn.LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app">OPEN THE APP</a></div></header>
<main>
<p class="kicker">Pricing</p>
<h1>Free and Pro</h1>
<p class="lead">Start free with the odds screen and the full public record. Pro adds the fair price and EV on every line, live alerts, the Discord feed and more API calls.</p>
${paywall ? '' : '<div class="early" id="early"><b>Early access:</b> every Pro feature is free while we finish launch. Nobody is charged until the paywall goes on.</div>'}
<div class="cards">
  <div class="card" id="planFree">
    <div class="pname">FREE</div>
    <div class="price">${sym}0<span>/ month</span></div>
    <div class="intro"></div>
    <ul>
          ${planListHtml('free')}
    </ul>
    ${freeCta}
  </div>
  <div class="card pro" id="planPro">
    <div class="pname">PRO</div>
    <div class="price">${sym}${money(price.monthly)}<span>/ month</span></div>
    <div class="intro">${esc(intro)}</div>
    <ul>
          ${planListHtml('pro')}
    </ul>
    ${proCta}
    <p class="cta-note">${esc(proNote)}</p>
  </div>
</div>

<h2 id="record">What the record backs today</h2>
<div class="rec" id="rec">${rec}<p class="note" style="margin:6px 0 0">Read live from the close scoreboard, the same test as the sales page. <a href="/app?start=results">See every record in the app</a>, <a href="/alerts">every alert we sent, graded</a>, and <a href="/r#board">bettors ranked by CLV against Pinnacle's close</a>.</p></div>

<h2 id="compare">Compare the plans</h2>
<div class="scroll"><table class="cmp"><thead><tr><th>Feature</th><th>Free</th><th>Pro</th></tr></thead><tbody>${rows}</tbody></table></div>

<h2 id="rules">What a plan never changes</h2>
<ul class="rules">${WHAT_IT_IS_NOT.map(r => `<li>${esc(r)}</li>`).join('')}</ul>

<h2 id="billing">Billing</h2>
<ul class="rules">
<li>Billed monthly through Stripe. Cancel any time in BILLING in the app; you keep Pro until the end of the period you paid for.</li>
<li>A full refund within 72 hours of your first payment: see the <a href="/refunds">refund policy</a>.</li>
<li>Some data sources are not shown to paying members until their owners give written permission; the app says which where it applies. See <a href="/data-sources">data sources</a>.</li>
</ul>
</main>
<footer><div class="in"><nav><a href="/">Home</a><a href="/app">App</a><a href="/learn">Learn</a><a href="/developers">API</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refunds">Refunds</a><a href="/disclaimer">Disclaimer</a><a href="/responsible-gambling">Responsible gambling</a></nav>Line Reaper is an information service, not a sportsbook. It does not take or place bets. 21+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></footer>
</body>
</html>`;
}

module.exports = { LIMITS, PLAN_IDS, FEATURES, CARD_FEATURES, WHAT_IT_IS_NOT, PAID_STATUSES, planOf, limitsOf, readiness, priceView, plansBody, planListHtml, pricingPage, money };
