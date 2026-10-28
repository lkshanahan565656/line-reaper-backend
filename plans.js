// ─── PLANS: FREE, PLUS AND PRO ────────────────────────────────────────────────
// One place that says what each plan gets. The server enforces the limits
// below (API calls, API keys per account, the Discord feed, live alerts and
// push, the alert delay), and the /pricing page, the sales page's plan lists
// and /api/plans are all rendered from the same FEATURES table, so the page
// can never promise something the server does not do.
//
//   Free  the odds screen, the record and the tools.
//   Plus  every research tab and model board in full (the server's hasPro
//         gates: fair, EV, shopper, props, esports, arbs, Sharp Tail), alerts
//         in the app ALERT_DELAY_MIN minutes late, Free's API.
//   Pro   all of Plus, plus live alerts and phone push, the Discord feed,
//         the full API and 30 days of line history.
// Plus and Pro are each sold monthly or annually (about two months free).
//
// Nothing changes until PAYWALL=on: with it off everyone is on Pro (the full
// tier), exactly as before. The admin token and comped accounts are always Pro.
//
// What a plan never changes (CFTC 4.14(a)(9), and the record rules): every
// member gets the same alerts, the same text and the same units; Plus gets the
// very same alerts, only later. Nothing is
// sized or picked per person, nothing places a bet, and paying buys the tool,
// not an edge: only what RESULTS marks proven is called proven.

const learn = require('./learn');
const { LIMITS: API_PRO } = require('./publicapi');

// minutes after Pro that a Plus member sees an alert (in the app's alert
// lists and the alert history); the same alerts and text, only later
const ALERT_DELAY_MIN = 10;
// alertDelayMin: null = no alerts at all (Free), 0 = live
const LIMITS = {
  free: { apiPerMinute: 10, apiPerDay: 500, apiKeys: 1, discordFeed: false, liveAlerts: false, pushAlerts: false, alertDelayMin: null, historyDays: 3 },
  plus: { apiPerMinute: 10, apiPerDay: 500, apiKeys: 1, discordFeed: false, liveAlerts: false, pushAlerts: false, alertDelayMin: ALERT_DELAY_MIN, historyDays: 14 },
  pro: { apiPerMinute: API_PRO.perMinute, apiPerDay: API_PRO.perDay, apiKeys: 5, discordFeed: true, liveAlerts: true, pushAlerts: true, alertDelayMin: 0, historyDays: 30 },
};
const PLAN_NAMES = { free: 'Free', plus: 'Plus', pro: 'Pro' };
const PLAN_IDS = Object.keys(LIMITS);

// One row per feature. free/plus/pro: true (included), false (not included)
// or a short string saying how much. `where` is the tab or page it lives on; `gate`
// says how the server holds it back, for the engineering record and tests.
const FEATURES = [
  { id: 'screen', group: 'Odds', label: 'Odds screen: every venue we read, side by side', where: 'ODDS SCREEN', free: true, plus: true, pro: true, gate: 'none' },
  { id: 'fair', group: 'Odds', label: 'Pinnacle no-vig fair price, EV and line history', where: 'ODDS SCREEN', free: 'How many prices sit above the fair', plus: true, pro: true, gate: 'oddsScreen.stripPro, shopper.stripPro' },
  { id: 'history', group: 'Odds', label: 'Line history: every market\'s prices at each venue, Pinnacle included, with a chart and a CSV or JSON download', where: '/lines, /api/v1/lines', free: `The last ${LIMITS.free.historyDays} days`, plus: `${LIMITS.plus.historyDays} days`, pro: `${LIMITS.pro.historyDays} days`, gate: 'limitsOf(plan).historyDays' },
  { id: 'shopper', group: 'Odds', label: 'Exchange Shopper ranked list, with what the order book fills at your stake', where: 'ODDS SCREEN > BEST PRICES ABOVE FAIR', free: 'Prices only', plus: true, pro: true, gate: 'shopper.stripPro' },
  { id: 'best', group: 'Odds', label: 'Best Plays, ranked by their own record', where: 'BEST PLAYS', free: 'Top 3', plus: 'Every play', pro: 'Every play', gate: 'BEST_FREE_PREVIEW' },
  { id: 'arbs', group: 'Odds', label: 'Arbs and middles with legs, prices and stakes', where: 'ARBS', free: 'Count and profit %', plus: true, pro: true, gate: '/api/xarbs free view' },
  { id: 'props', group: 'Models', label: 'Pick\'em and props boards, priced against the sharp number', where: 'PROPS', free: 'The board; picks on lines above the fair hidden', plus: true, pro: true, gate: 'redactForFree' },
  { id: 'esports', group: 'Models', label: 'Esports match boards and our ratings (tagged model, not an edge)', where: 'ESPORTS > MATCHUPS', free: 'Match boards', plus: true, pro: true, gate: 'redactForFree, requirePro on best slips' },
  { id: 'tail', group: 'Research', label: 'Sharp Tail (research): big accounts\' entries with the trader and price', where: 'SHARP TAIL', free: '30 minute delay', plus: 'Real time in the tab (no push)', pro: 'Real time', gate: 'TAIL_FREE_DELAY_MS' },
  { id: 'alerts', group: 'Alerts', label: 'Live alerts in the app, and phone push', where: 'CUSTOMIZE > Push alerts', free: false, plus: `In the app, ${ALERT_DELAY_MIN} minutes after Pro; the same alerts and text. No phone push`, pro: 'Live, and phone push; the same text for every member', gate: 'requireLive on /api/ev/stream, /api/esports/stream, /api/push/subscribe; alert delay on /api/ev/alerts, /api/esports/alerts' },
  { id: 'feed', group: 'Alerts', label: 'The Line Reaper feed in your Discord server (weekly digest, record changes, biggest moves)', where: '/developers#feed', free: false, plus: false, pro: 'One channel per key; the same posts for everyone', gate: 'PUT /api/v1/feed/discord, feed subscribers' },
  { id: 'bot', group: 'Alerts', label: 'Line Reaper commands in your Discord server or Telegram group (/odds, /props, /moves, /record, /lines), under your own bot', where: '/developers#bot', free: 'Within the key\'s API limits', plus: 'Within the key\'s API limits', pro: 'Within the key\'s API limits', gate: 'PUT /api/v1/bot/discord or /api/v1/bot/telegram, each command spends an API call' },
  { id: 'api', group: 'API', label: 'Public API calls', where: '/developers', free: `${LIMITS.free.apiPerMinute} a minute, ${LIMITS.free.apiPerDay.toLocaleString('en-US')} a day`, plus: `${LIMITS.plus.apiPerMinute} a minute, ${LIMITS.plus.apiPerDay.toLocaleString('en-US')} a day`, pro: `${LIMITS.pro.apiPerMinute} a minute, ${LIMITS.pro.apiPerDay.toLocaleString('en-US')} a day`, gate: 'v1Auth limiter' },
  { id: 'apiFair', group: 'API', label: 'Fair prices and EV in the API', where: '/api/v1/best-prices', free: false, plus: false, pro: false, note: 'Held back from the API for everyone once the paywall is on', gate: 'v1FullTier' },
  { id: 'keys', group: 'API', label: 'API keys per account', where: '/developers', free: String(LIMITS.free.apiKeys), plus: String(LIMITS.plus.apiKeys), pro: `Up to ${LIMITS.pro.apiKeys}`, gate: 'POST /api/v1/keys' },
  { id: 'widgets', group: 'API', label: 'Widgets for your own site (best price, line move, record)', where: '/developers', free: true, plus: true, pro: true, gate: 'none' },
  { id: 'record', group: 'Record', label: 'The full public record and the weekly digest, losers included', where: 'RESULTS', free: true, plus: true, pro: true, gate: 'none' },
  { id: 'alertHistory', group: 'Record', label: 'Every alert we sent, with each bet graded against the close', where: '/alerts, RESULTS > ALERT HISTORY', free: 'Bets shown once their games start', plus: `Bets shown ${ALERT_DELAY_MIN} minutes after they are sent`, pro: 'Live', gate: 'alertlog.view full, delayMs' },
  { id: 'bettor', group: 'Record', label: 'Your own public bettor record at /r/your-name, with CSV, JSON and a share card', where: 'MY SLIPS > PUBLISH RECORD', free: true, plus: true, pro: true, gate: 'none' },
  { id: 'leaderboard', group: 'Record', label: 'The bettor leaderboard: published records ranked by CLV against Pinnacle\'s close, ranked only at 50 graded', where: '/r', free: true, plus: true, pro: true, gate: 'none' },
  { id: 'tools', group: 'Record', label: 'Calculators, MY BETS, MY SLIPS, imports, EXPORT and PRINT', where: 'TOOLS, MY BETS, MY SLIPS', free: true, plus: true, pro: true, gate: 'none' },
  { id: 'views', group: 'Record', label: 'Saved views, favorites, My state, odds format, after-fee prices', where: 'CUSTOMIZE, ODDS SCREEN', free: true, plus: true, pro: true, gate: 'none' },
];
// The fair-in-the-API row is a rule for everyone, not a plan difference: kept
// in the table so /api/plans says it, left off the plan cards.
const CARD_FEATURES = FEATURES.filter(f => f.free !== false || f.plus !== false || f.pro !== false);

const WHAT_IT_IS_NOT = [
  'Paying buys the tool, not an edge. A price above the fair is a price, not a proven edge, and every row carries its label.',
  'Only what RESULTS marks proven is called proven: 50 graded at one venue read straight from that venue, CLV t of 2 against Pinnacle\'s no-vig close, kinds never pooled.',
  'Every member gets the same alerts, the same text and the same units. Plus gets them later, never different. Nothing is sized, picked or set up per person.',
  'Line Reaper never places a bet and never holds your money. You bet at the venue yourself.',
];

const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);
// 'free', 'plus' or 'pro'. paywall off: everyone is Pro. admin: always Pro.
// tier: the account's own (auth.tierOf, which knows comps, grace periods and
// cancellations). pro: the older yes/no (auth.isPro), read as Pro.
function planOf({ paywall = false, admin = false, tier = null, pro = false } = {}) {
  if (!paywall || admin) return 'pro';
  if (tier === 'plus' || tier === 'pro') return tier;
  return pro ? 'pro' : 'free';
}
const limitsOf = plan => LIMITS[plan] || LIMITS.free;
const planName = plan => PLAN_NAMES[plan] || PLAN_NAMES.free;

// the switch: what has to be set for PAYWALL=on to take money and keep it.
// Booleans and names only, never a value. The optional prices (annual, Plus)
// only add plans to the page; they never hold the switch back.
function readiness(env = process.env, { billingConfigured = false } = {}) {
  const set = k => !!String(env[k] || '').trim();
  const items = [
    { key: 'STRIPE_SECRET_KEY', ok: set('STRIPE_SECRET_KEY'), why: 'takes the payment' },
    { key: 'STRIPE_PRICE_ID', ok: set('STRIPE_PRICE_ID'), why: 'the monthly Pro price in Stripe' },
    { key: 'STRIPE_WEBHOOK_SECRET', ok: set('STRIPE_WEBHOOK_SECRET'), why: 'turns a payment into a plan on the account' },
    { key: 'AUTH_SECRET', ok: set('AUTH_SECRET'), why: 'keeps people signed in across restarts' },
    { key: 'DATABASE_URL', ok: set('DATABASE_URL'), why: 'keeps accounts across deploys' },
    { key: 'LEGAL_EMAIL', ok: set('LEGAL_EMAIL'), why: 'the contact on the legal pages' },
    { key: 'LEGAL_STATE', ok: set('LEGAL_STATE'), why: 'the governing state in the terms' },
  ];
  const optional = [
    { key: 'STRIPE_PRICE_ANNUAL_ID', ok: set('STRIPE_PRICE_ANNUAL_ID'), why: 'the annual Pro price; without it Pro is monthly only' },
    { key: 'STRIPE_PLUS_PRICE_ID', ok: set('STRIPE_PLUS_PRICE_ID'), why: 'the monthly Plus price; without it Plus is not on sale' },
    { key: 'STRIPE_PLUS_PRICE_ANNUAL_ID', ok: set('STRIPE_PLUS_PRICE_ANNUAL_ID'), why: 'the annual Plus price' },
    { key: 'STRIPE_INTRO_PRICE_ID', ok: set('STRIPE_INTRO_PRICE_ID'), why: 'the founding Pro price for the first members' },
  ];
  const missing = items.filter(i => !i.ok).map(i => i.key);
  return { paywall: /^(1|on|true|yes)$/i.test(String(env.PAYWALL || '')), billing: !!billingConfigured, ready: !missing.length, missing, items,
    optional, optionalMissing: optional.filter(i => !i.ok).map(i => i.key) };
}

// The prices people see. Stripe's own price wins once it has been read (so the
// page can't show a number Stripe won't charge); the PRICE_* settings until
// then. The founding price shows only while it can really be bought: before the
// paywall (a promise to early members), or with STRIPE_INTRO_PRICE_ID set and
// seats left.
//   stripe, introStripe: Pro monthly and founding (billing.prices() main, intro)
//   catalog: billing.prices() whole, for annual and Plus
//   sale: billing.onSale() ({ plus: { month, year }, pro: {...} }); with the
//         paywall off every plan and interval shows as a preview. The page
//         still says "not open" until billing is configured at all.
function priceView({ env = process.env, paywall = false, stripe = null, introStripe = null, catalog = null, sale = null, foundingTaken = 0 } = {}) {
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  const amt = (p, fallback) => (p && Number.isFinite(p.amount) ? p.amount : fallback);
  const monthly = amt(stripe || catalog?.pro?.month, num(env.PRICE_MONTHLY, 79));
  const annual = amt(catalog?.pro?.year, num(env.PRICE_ANNUAL, Math.round(monthly * 10)));
  const plusMonthly = amt(catalog?.plus?.month, num(env.PLUS_PRICE_MONTHLY, 25));
  const plusAnnual = amt(catalog?.plus?.year, num(env.PLUS_PRICE_ANNUAL, Math.round(plusMonthly * 10)));
  const introRaw = amt(introStripe || catalog?.intro, num(env.PRICE_INTRO, 49));
  const seats = Math.round(num(env.INTRO_SEATS, 100));
  const left = Math.max(0, seats - Math.max(0, foundingTaken | 0));
  const introSellable = !paywall || (!!String(env.STRIPE_INTRO_PRICE_ID || '').trim() && left > 0);
  const intro = introRaw > 0 && introRaw < monthly && seats > 0 && introSellable ? introRaw : null;
  const currency = String((stripe && stripe.currency) || 'usd').toUpperCase();
  // no sale list (an older caller): Pro monthly, the one price that was ever required
  const can = (t, i) => (!paywall ? true : sale ? !!sale[t]?.[i] : t === 'pro' && i === 'month');
  // whole months free on the annual price against twelve monthly payments
  const monthsFree = (m, y) => (m > 0 && y > 0 && y < m * 12 ? Math.round(12 - y / m) : 0);
  return {
    monthly, annual, intro, seats, seatsLeft: paywall ? left : seats, currency, symbol: currency === 'USD' ? '$' : `${currency} `,
    fromStripe: !!(stripe && Number.isFinite(stripe.amount)),
    plans: {
      plus: { monthly: plusMonthly, annual: plusAnnual, monthsFree: monthsFree(plusMonthly, plusAnnual), onSale: { month: can('plus', 'month'), year: can('plus', 'year') } },
      pro: { monthly, annual, monthsFree: monthsFree(monthly, annual), onSale: { month: can('pro', 'month'), year: can('pro', 'year') } },
    },
  };
}
const money = n => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// what /api/plans answers: the same for everyone except `viewer`
function plansBody({ paywall, billingConfigured, price, viewerPlan = null, signedIn = false }) {
  const p = price.plans || {};
  const sale = id => ({ month: !!(paywall && billingConfigured && p[id]?.onSale?.month), year: !!(paywall && billingConfigured && p[id]?.onSale?.year) });
  return {
    paywall, onSale: !!(paywall && billingConfigured),
    note: paywall ? null : 'Early access: every Pro feature is free while the paywall is off.',
    price: { monthly: price.monthly, annual: price.annual ?? null, intro: price.intro, seats: price.seats, seatsLeft: price.seatsLeft, currency: price.currency },
    plans: PLAN_IDS.map(id => ({
      id, name: planName(id),
      monthly: id === 'free' ? 0 : p[id]?.monthly ?? (id === 'pro' ? price.monthly : null),
      annual: id === 'free' ? 0 : p[id]?.annual ?? null,
      monthsFree: id === 'free' ? 0 : p[id]?.monthsFree ?? 0,
      onSale: id === 'free' ? null : sale(id),
      limits: LIMITS[id],
    })),
    features: FEATURES.map(({ gate, ...f }) => f),
    rules: WHAT_IT_IS_NOT,
    viewer: { plan: viewerPlan, signedIn },
    page: '/pricing',
  };
}

// ── the /pricing page ──
const { escHtml: esc } = require('./mathutil');
const pct = x => (x == null || !Number.isFinite(x) ? 'n/a' : `${x > 0 ? '+' : ''}${(Math.round(x * 10) / 10).toFixed(1)}%`);
const TICK = c => `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 6.5l3 3 6-7" stroke="${c}" stroke-width="1.6" fill="none"/></svg>`;
const DASH = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7" stroke="#7b8a9f" stroke-width="1.6"/></svg>';

// The plan cards' bullet lists, for the sales page too. plan: 'free' | 'plus' | 'pro'.
const PLAN_COLOR = { free: '#94a3b8', plus: '#60a5fa', pro: '#10b981' };
function planListHtml(plan) {
  const c = PLAN_COLOR[plan] || PLAN_COLOR.free;
  return CARD_FEATURES.filter(f => f[plan] !== false).map(f => {
    const v = f[plan];
    const extra = typeof v === 'string' ? `: ${esc(v)}` : '';
    return `<li>${TICK(c)}${esc(f.label)}${extra}</li>`;
  }).join('\n          ');
}

const cell = v => (v === true ? `<span class="yes">${TICK('#10b981')}<span class="sr">Included</span></span>` : v === false ? `<span class="no">${DASH}<span class="sr">Not included</span></span>` : esc(v));

const PRICING_CSS = `
main { max-width:1040px; }
.top-in { max-width:1040px; }
.early { border:1px solid rgba(52,211,153,.35); background:rgba(16,185,129,.07); border-radius:10px; padding:12px 14px; margin:0 0 20px; font-size:15px; }
.billsw { position:absolute; opacity:0; width:1px; height:1px; }
.bill { display:inline-flex; border:1px solid var(--border2); border-radius:8px; padding:3px; margin:0 0 14px; gap:3px; flex-wrap:wrap; }
.bill label { font:600 11px var(--mono); letter-spacing:.08em; color:var(--text2); padding:7px 12px; border-radius:6px; cursor:pointer; }
.bill label b { color:var(--green2); font-weight:600; }
#billM:checked ~ .bill label[for=billM], #billY:checked ~ .bill label[for=billY] { background:var(--card); color:var(--text); box-shadow:inset 0 0 0 1px var(--border2); }
#billM:focus-visible ~ .bill label[for=billM], #billY:focus-visible ~ .bill label[for=billY] { outline:2px solid var(--green2); outline-offset:2px; }
.y { display:none; }
#billY:checked ~ .cards .y { display:block; }
#billY:checked ~ .cards .m { display:none; }
.cards { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:14px; margin:0 0 22px; }
.card { border:1px solid var(--border); background:var(--card); border-radius:12px; padding:18px 18px 16px; min-width:0; display:flex; flex-direction:column; }
.card.plus { border-color:rgba(96,165,250,.45); }
.card.pro { border-color:rgba(52,211,153,.45); }
.pname { font:600 11px var(--mono); letter-spacing:.14em; color:var(--text2); }
.card.plus .pname { color:#93c5fd; }
.card.pro .pname { color:var(--green2); }
.price { font-size:40px; font-weight:700; letter-spacing:-1px; line-height:1.1; margin:6px 0 2px; }
.price span { font-size:14px; font-weight:500; color:var(--text2); letter-spacing:0; margin-left:4px; }
.intro { font-size:13px; color:var(--green2); min-height:20px; }
.card ul { list-style:none; padding:0; margin:12px 0 16px; font-size:14px; flex:1; }
.card li { display:flex; gap:8px; align-items:flex-start; overflow-wrap:anywhere; }
.card li svg { flex:0 0 12px; margin-top:6px; }
.cta { display:block; text-align:center; font:600 12px var(--mono); letter-spacing:.06em; color:var(--text); text-decoration:none; border:1px solid var(--border2); border-radius:6px; padding:10px 14px; }
.card.plus .cta { color:#06101f; background:#60a5fa; border-color:#60a5fa; }
.card.pro .cta { color:#04130c; background:var(--green); border-color:var(--green); }
.cta-note { font-size:12px; color:var(--muted); margin:8px 0 0; text-align:center; }
.cmp td, .cmp th { overflow-wrap:anywhere; }
.cmp td { font-family:inherit; font-size:13px; }
.cmp td:first-child { width:43%; }
.cmp .grp td { font:600 10px var(--mono); letter-spacing:.12em; text-transform:uppercase; color:var(--muted); padding-top:16px; }
.cmp .where { display:block; font:500 10px var(--mono); letter-spacing:.06em; color:var(--muted); text-transform:uppercase; margin-top:2px; }
.yes svg, .no svg { vertical-align:middle; }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.rec { border:1px solid var(--border); background:var(--card); border-radius:10px; padding:12px 14px; margin:0 0 16px; font-size:14px; }
.rec ul { margin:6px 0 0; }
.rules li { color:var(--text2); }
@media (max-width:860px) { .cards { grid-template-columns:minmax(0, 1fr); } .price { font-size:34px; } .cmp td:first-child { width:34%; } }
`;

// One paid card's price line for one interval. p: priceView().plans[id]
function paidBlock({ id, interval, p, price, paywall }) {
  const sym = price.symbol, year = interval === 'year';
  const amount = year ? p.annual : p.monthly;
  let sub = '';
  if (year) sub = `${sym}${money(Math.round((p.annual / 12) * 100) / 100)} a month${p.monthsFree > 0 ? `, ${p.monthsFree} month${p.monthsFree === 1 ? '' : 's'} free` : ''}`;
  else if (id === 'pro' && price.intro != null) sub = `${sym}${money(price.intro)} a month for the first ${price.seats} members${paywall ? ` (${price.seatsLeft} left)` : ''}`;
  return `<div class="${year ? 'y' : 'm'}">
      <div class="price">${sym}${money(amount)}<span>/ ${year ? 'year' : 'month'}</span></div>
      <div class="intro">${esc(sub)}</div>
    </div>`;
}
// the button half, kept apart so it sits under the list
function paidCta({ id, interval, p, paywall, onSale, legalEmail }) {
  const name = planName(id), year = interval === 'year';
  let cta, note;
  if (!paywall) {
    cta = `<a class="cta" href="/app">OPEN THE APP: ${id === 'pro' ? 'PRO IS FREE NOW' : 'FREE NOW'}</a>`;
    note = 'Early access: every Pro feature is on for everyone until the paywall goes on.';
  } else if (onSale && p.onSale[interval]) {
    cta = `<a class="cta" href="/app?start=${id}${year ? '&amp;interval=year' : ''}">GET ${name.toUpperCase()}${year ? ' ANNUAL' : ''}</a>`;
    note = `Checkout is Stripe, billed ${year ? 'once a year' : 'monthly'}. Cancel any time in BILLING in the app.`;
  } else {
    cta = `<a class="cta" href="${esc(legalEmail ? `mailto:${legalEmail}` : '/legal#contact')}">ASK ABOUT ${name.toUpperCase()}</a>`;
    note = `${name}${year ? ' annual' : ''} checkout is not open yet.`;
  }
  return `<div class="${year ? 'y' : 'm'}">${cta}<p class="cta-note">${esc(note)}</p></div>`;
}

// claims: the /api/claims body (claims.publicClaims), so the page says what
// the record proves today, read from the same place as the sales page
function pricingPage({ origin = '', paywall = false, billingConfigured = false, accounts = false, price, claims = null, legalEmail = '' } = {}) {
  const o = String(origin).replace(/[^\w.:/-]/g, '');
  const sym = price.symbol;
  const onSale = paywall && billingConfigured;
  // the older priceView shape (no plans): Pro monthly only
  const plansP = price.plans || { pro: { monthly: price.monthly, annual: null, monthsFree: 0, onSale: { month: !paywall || onSale, year: false } } };
  const paid = ['plus', 'pro'].filter(id => plansP[id]);
  // the annual switch shows when an annual price can be bought (or, before the
  // paywall, as the preview of what it will be)
  const annual = paid.some(id => plansP[id].annual > 0 && (!paywall || (onSale && plansP[id].onSale.year)));
  const freeCta = accounts ? '<a class="cta" href="/app?start=signup">CREATE A FREE ACCOUNT</a>' : '<a class="cta" href="/app">START FREE</a>';
  const card = id => {
    const p = plansP[id];
    const blocks = i => paidBlock({ id, interval: i, p, price, paywall });
    const ctas = i => paidCta({ id, interval: i, p, paywall, onSale, legalEmail });
    return `<div class="card ${id}" id="plan${planName(id)}">
    <div class="pname">${planName(id).toUpperCase()}</div>
    ${blocks('month')}${annual && p.annual > 0 ? blocks('year') : ''}
    <ul>
          ${planListHtml(id)}
    </ul>
    ${ctas('month')}${annual && p.annual > 0 ? ctas('year') : ''}
  </div>`;
  };
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
  const cols = ['free', ...paid];
  let lastGroup = '';
  const rows = FEATURES.map(f => {
    const g = f.group !== lastGroup ? `<tr class="grp"><td colspan="${cols.length + 1}">${esc(f.group)}</td></tr>` : '';
    lastGroup = f.group;
    const none = cols.every(c => f[c] === false);
    return `${g}<tr><td>${esc(f.label)}<span class="where">${esc(f.where)}</span></td>${none ? `<td colspan="${cols.length}">${esc(f.note || 'Not offered')}</td>` : cols.map(c => `<td>${cell(f[c])}</td>`).join('')}</tr>`;
  }).join('');
  const plus = plansP.plus;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pricing: Free, Plus and Pro | Line Reaper</title>
<meta name="description" content="Line Reaper's plans: a free odds screen and public record; Plus with every research tab, fair prices and EV; Pro with live alerts, the Discord feed and the full API. Monthly or annual. Paying buys the tool, not an edge.">
${o ? `<link rel="canonical" href="${esc(o)}/pricing">` : ''}
<meta name="theme-color" content="#080b10">
<link rel="icon" href="${learn.FAVICON}">
<style>${learn.CSS}${PRICING_CSS}</style>
</head>
<body>
<header class="top"><div class="top-in"><a class="brand" href="/">${learn.LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app">OPEN THE APP</a></div></header>
<main>
<p class="kicker">Pricing</p>
<h1>Free, Plus and Pro</h1>
<p class="lead">Start free with the odds screen and the full public record.${plus ? ` Plus (${sym}${money(plus.monthly)} a month) opens every research tab with the fair price and EV, and sends the same alerts ${ALERT_DELAY_MIN} minutes later.` : ''} Pro adds live alerts and phone push, the Discord feed and the full API.</p>
${paywall ? '' : '<div class="early" id="early"><b>Early access:</b> every Pro feature is free while we finish launch. Nobody is charged until the paywall goes on.</div>'}
${annual ? `<input class="billsw" type="radio" name="bill" id="billM" checked><input class="billsw" type="radio" name="bill" id="billY">
<div class="bill" role="group" aria-label="Billing period"><label for="billM">MONTHLY</label><label for="billY">ANNUAL <b>${esc(billSaving(plansP))}</b></label></div>` : ''}
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
  ${paid.map(card).join('\n  ')}
</div>

<h2 id="record">What the record backs today</h2>
<div class="rec" id="rec">${rec}<p class="note" style="margin:6px 0 0">Read live from the close scoreboard, the same test as the sales page. <a href="/app?start=results">See every record in the app</a>, <a href="/alerts">every alert we sent, graded</a>, and <a href="/r#board">bettors ranked by CLV against Pinnacle's close</a>.</p></div>

<h2 id="compare">Compare the plans</h2>
<div class="scroll"><table class="cmp"><thead><tr><th>Feature</th>${cols.map(c => `<th>${planName(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>

<h2 id="rules">What a plan never changes</h2>
<ul class="rules">${WHAT_IT_IS_NOT.map(r => `<li>${esc(r)}</li>`).join('')}</ul>

<h2 id="billing">Billing</h2>
<ul class="rules">
<li>Billed through Stripe, monthly${annual ? ' or once a year' : ''}. Cancel any time in BILLING in the app; you keep your plan until the end of the period you paid for.</li>
<li>Switch between Plus and Pro, or monthly and annual, in BILLING. Stripe credits what is left of the period you paid for.</li>
<li>A full refund within 72 hours of your first payment: see the <a href="/refunds">refund policy</a>.</li>
<li>Some data sources are not shown to paying members until their owners give written permission; the app says which where it applies. See <a href="/data-sources">data sources</a>.</li>
</ul>
</main>
<footer><div class="in"><nav><a href="/">Home</a><a href="/app">App</a><a href="/learn">Learn</a><a href="/developers">API</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refunds">Refunds</a><a href="/disclaimer">Disclaimer</a><a href="/responsible-gambling">Responsible gambling</a></nav>Line Reaper is an information service, not a sportsbook. It does not take or place bets. 21+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></footer>
</body>
</html>`;
}
// "2 months free" when every annual price gives the same; "up to 2" otherwise
function billSaving(plansP) {
  const m = Object.values(plansP).map(p => p.monthsFree || 0).filter(n => n > 0);
  if (!m.length) return '';
  const lo = Math.min(...m), hi = Math.max(...m);
  return lo === hi ? `${hi} MONTH${hi === 1 ? '' : 'S'} FREE` : `UP TO ${hi} MONTHS FREE`;
}

module.exports = { LIMITS, PLAN_IDS, PLAN_NAMES, ALERT_DELAY_MIN, FEATURES, CARD_FEATURES, WHAT_IT_IS_NOT, PAID_STATUSES, planOf, planName, limitsOf, readiness, priceView, plansBody, planListHtml, pricingPage, money };
