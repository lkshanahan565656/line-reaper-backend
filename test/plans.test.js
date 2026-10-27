// plans.js on its own: who is on which plan, the limits, the price the pages
// show, the readiness list, and the /pricing page's wording.
const test = require('node:test');
const assert = require('node:assert/strict');
const plans = require('../plans');
const billingLib = require('../billing');

test('planOf: paywall off is Pro for everyone; on, only paid accounts and the admin', () => {
  assert.equal(plans.planOf({ paywall: false }), 'pro');
  assert.equal(plans.planOf({ paywall: false, pro: false }), 'pro');
  assert.equal(plans.planOf({ paywall: true }), 'free');
  assert.equal(plans.planOf({ paywall: true, pro: true }), 'pro');
  assert.equal(plans.planOf({ paywall: true, admin: true }), 'pro');
  assert.equal(plans.limitsOf('nonsense'), plans.LIMITS.free, 'an unknown plan gets the Free limits');
});

test('limits: Pro keeps what everyone has today; Free is lower on every limit', () => {
  const { free, pro } = plans.LIMITS;
  assert.equal(pro.apiPerMinute, require('../publicapi').LIMITS.perMinute);
  assert.equal(pro.apiPerDay, require('../publicapi').LIMITS.perDay);
  assert.ok(free.apiPerMinute < pro.apiPerMinute && free.apiPerDay < pro.apiPerDay && free.apiKeys < pro.apiKeys);
  assert.equal(free.discordFeed, false);
  assert.equal(pro.discordFeed, true);
});

test('features: every row says what each plan gets, and no row is per-person', () => {
  for (const f of plans.FEATURES) {
    assert.ok(f.id && f.label && f.where && f.gate, `feature ${f.id} is missing a field`);
    for (const k of ['free', 'pro']) assert.ok(f[k] === true || f[k] === false || typeof f[k] === 'string', `${f.id}.${k}`);
  }
  const txt = JSON.stringify(plans.FEATURES) + plans.WHAT_IT_IS_NOT.join(' ');
  assert.doesNotMatch(txt, /guaranteed|risk[- ]free|sure thing|winning picks|beat the books/i);
  assert.ok(plans.WHAT_IT_IS_NOT.some(r => /same alerts/.test(r)) && plans.WHAT_IT_IS_NOT.some(r => /not an edge/.test(r)));
  assert.ok(plans.WHAT_IT_IS_NOT.some(r => /never places a bet/.test(r)));
});

test('priceView: Stripe\'s amount wins; the founding price shows only while it can be bought', () => {
  assert.equal(plans.priceView({ env: {} }).monthly, 79);
  assert.equal(plans.priceView({ env: {} }).intro, 49, 'before the paywall the founding price is the promise to early members');
  assert.equal(plans.priceView({ env: { PRICE_MONTHLY: '59' }, stripe: { amount: 99, currency: 'usd' } }).monthly, 99);
  // paywall on: no intro price id in Stripe, no founding price on the page
  assert.equal(plans.priceView({ env: {}, paywall: true }).intro, null);
  const on = { STRIPE_INTRO_PRICE_ID: 'price_intro', INTRO_SEATS: '3' };
  assert.equal(plans.priceView({ env: on, paywall: true, foundingTaken: 2 }).intro, 49);
  assert.equal(plans.priceView({ env: on, paywall: true, foundingTaken: 2 }).seatsLeft, 1);
  assert.equal(plans.priceView({ env: on, paywall: true, foundingTaken: 3 }).intro, null, 'seats gone: no founding price');
  assert.equal(plans.priceView({ env: { PRICE_INTRO: '0' } }).intro, null);
  assert.equal(plans.priceView({ env: { PRICE_INTRO: '90' } }).intro, null, 'an intro at or above the price is not an intro');
});

test('readiness: names what is missing, never a value', () => {
  const r = plans.readiness({ PAYWALL: 'on', STRIPE_SECRET_KEY: 'sk_test_secret', STRIPE_PRICE_ID: 'price_1' }, { billingConfigured: true });
  assert.equal(r.paywall, true);
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing, ['STRIPE_WEBHOOK_SECRET', 'AUTH_SECRET', 'DATABASE_URL', 'LEGAL_EMAIL', 'LEGAL_STATE']);
  assert.doesNotMatch(JSON.stringify(r), /sk_test_secret|price_1/);
  const all = Object.fromEntries(['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'AUTH_SECRET', 'DATABASE_URL', 'LEGAL_EMAIL', 'LEGAL_STATE'].map(k => [k, 'x']));
  assert.equal(plans.readiness(all).ready, true);
  assert.equal(plans.readiness(all).paywall, false);
});

const CLAIMS = { proven: [{ kindLabel: 'EV · main lines', bookName: 'BetRivers', graded: 373, clv: 2.8, profitShown: false, texas: false }], texas: { name: 'Texas', proven: [] } };

test('pricing page: each switch position has a working button and honest words', () => {
  const price = plans.priceView({ env: {} });
  const off = plans.pricingPage({ paywall: false, price, claims: CLAIMS });
  assert.match(off, /id="early"/);
  assert.match(off, /href="\/app">OPEN THE APP: PRO IS FREE NOW</);
  assert.match(off, /\$79<span>/);
  assert.match(off, /\$49 a month for the first 100 members/);
  assert.match(off, /BetRivers: 373 graded, CLV \+2\.8% against the close, profit not shown yet/);
  assert.match(off, /Nothing is proven yet at a venue a Texas resident can use/);
  const sale = plans.pricingPage({ paywall: true, billingConfigured: true, accounts: true, price: plans.priceView({ env: {}, paywall: true }), claims: { proven: [], texas: { proven: [] } } });
  assert.doesNotMatch(sale, /id="early"/);
  assert.match(sale, /href="\/app\?start=pro">GET PRO</);
  assert.match(sale, /href="\/app\?start=signup">CREATE A FREE ACCOUNT</);
  assert.match(sale, /Nothing is proven yet\./);
  const notYet = plans.pricingPage({ paywall: true, billingConfigured: false, price, legalEmail: 'help@example.com' });
  assert.match(notYet, /href="mailto:help@example.com">ASK ABOUT PRO</);
  assert.match(notYet, /could not be read just now/);
  for (const p of [off, sale, notYet]) {
    assert.doesNotMatch(p, /guaranteed|risk[- ]free|sure thing|undefined|NaN|\{\{/);
    assert.match(p, /Paying buys the tool, not an edge/);
    assert.match(p, /<td>Public API calls<span class="where">\/developers<\/span><\/td><td>10 a minute, 500 a day<\/td><td>60 a minute, 5,000 a day<\/td>/);
    assert.ok(!/href="#"/.test(p), 'no dead links');
  }
});

test('plan lists for the sales page come from the same table', () => {
  const free = plans.planListHtml('free'), pro = plans.planListHtml('pro');
  assert.match(free, /Sharp Tail \(research\).*: 30 minute delay/);
  assert.doesNotMatch(free, /Live alerts in the app/);
  assert.match(pro, /Live alerts in the app, and phone push: Same text for every member/);
  assert.doesNotMatch(free + pro, /Fair prices and EV in the API/, 'a rule for everyone is not a plan bullet');
});

test('billing: the founding price is used for checkout while seats are left, and Stripe prices are read and cached', async () => {
  const posts = [], gets = [];
  const users = new Map([['u1', { id: 'u1', email: 'a@b.co' }], ['u2', { id: 'u2', email: 'c@d.co', subscriptionId: 'sub_old', stripeCustomerId: 'cus_2' }]]);
  const store = { get: async id => users.get(id), put: async u => users.set(u.id, u), byCustomer: async c => [...users.values()].find(u => u.stripeCustomerId === c) };
  let open = true;
  const http = {
    post: async (url, body) => { posts.push({ url, body: new URLSearchParams(body) }); return { data: url.endsWith('/customers') ? { id: 'cus_1' } : { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' } }; },
    get: async url => { gets.push(url); return { data: { unit_amount: url.includes('price_intro') ? 4900 : 7900, currency: 'usd', recurring: { interval: 'month' } } }; },
  };
  const b = billingLib.createBilling({ http, secretKey: 'sk_test', priceId: 'price_main', introPriceId: 'price_intro', introOpen: async () => open, store, log: { warn() {} } });
  await b.checkout(users.get('u1'), { successUrl: 'https://x/ok', cancelUrl: 'https://x/' });
  assert.equal(posts.at(-1).body.get('line_items[0][price]'), 'price_intro');
  await b.checkout(users.get('u2'), { successUrl: 'https://x/ok', cancelUrl: 'https://x/' });
  assert.equal(posts.at(-1).body.get('line_items[0][price]'), 'price_main', 'an account that subscribed before pays the full price');
  open = false;
  await b.checkout(users.get('u1'), { successUrl: 'https://x/ok', cancelUrl: 'https://x/' });
  assert.equal(posts.at(-1).body.get('line_items[0][price]'), 'price_main', 'seats gone: the full price');
  const p = await b.prices();
  assert.deepEqual(p.main, { amount: 79, currency: 'usd', interval: 'month', active: true });
  assert.equal(p.intro.amount, 49);
  await b.prices();
  assert.equal(gets.length, 2, 'cached for an hour');
  // the webhook marks a founding seat taken
  users.get('u1').stripeCustomerId = 'cus_1';
  await b.handleEvent({ type: 'customer.subscription.created', created: 100, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: 2e9, items: { data: [{ price: { id: 'price_intro' } }] } } } });
  assert.equal(users.get('u1').founding, true);
  assert.equal(users.get('u1').plan, 'pro');
});
