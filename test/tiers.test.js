// The Plus tier and annual billing on their own: which account is on which
// tier, which Stripe price each plan and period uses, the webhook writing the
// tier, the prices the pages show, the /pricing switch, and the alert delay.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const plans = require('../plans');
const auth = require('../auth');
const billingLib = require('../billing');
const alertlog = require('../alertlog');

const DAY = 86400e3;
const paid = (plan, extra = {}) => ({ id: 'u', plan, planStatus: 'active', subscriptionId: 'sub_1', currentPeriodEnd: new Date(Date.now() + 30 * DAY).toISOString(), ...extra });

test('tierOf: the plan on the subscription, Pro for old and comped accounts, Free once lapsed', () => {
  assert.equal(auth.tierOf(null), 'free');
  assert.equal(auth.tierOf({ plan: 'free' }), 'free');
  assert.equal(auth.tierOf(paid('plus')), 'plus');
  assert.equal(auth.tierOf(paid('pro')), 'pro');
  assert.equal(auth.tierOf({ comp: true, plan: 'plus' }), 'pro', 'comped by the owner: everything');
  assert.equal(auth.tierOf(paid('plus', { planStatus: 'unpaid' })), 'free');
  assert.equal(auth.tierOf(paid('plus', { planStatus: 'canceled', currentPeriodEnd: new Date(Date.now() - DAY).toISOString() })), 'free');
  assert.equal(auth.publicUser(paid('plus')).tier, 'plus');
  assert.equal(plans.planOf({ paywall: true, tier: 'plus' }), 'plus');
  assert.equal(plans.planOf({ paywall: true, tier: 'free' }), 'free');
  assert.equal(plans.planOf({ paywall: false, tier: 'free' }), 'pro', 'paywall off: everyone is Pro');
  assert.equal(plans.planOf({ paywall: true, admin: true, tier: 'plus' }), 'pro');
});

test('limits: Plus has Free\'s API, a delayed alert, more history; Pro has the rest', () => {
  const { free, plus, pro } = plans.LIMITS;
  assert.equal(plus.apiPerMinute, free.apiPerMinute);
  assert.equal(plus.apiKeys, free.apiKeys);
  assert.equal(plus.discordFeed, false);
  assert.equal(plus.liveAlerts, false);
  assert.equal(plus.alertDelayMin, plans.ALERT_DELAY_MIN);
  assert.equal(free.alertDelayMin, null);
  assert.equal(pro.alertDelayMin, 0);
  assert.ok(free.historyDays < plus.historyDays && plus.historyDays < pro.historyDays);
  assert.ok(plans.FEATURES.every(f => 'plus' in f), 'every feature says what Plus gets');
  // the app's copy of the delay matches
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.equal(Number(/const ALERT_DELAY_MIN = (\d+);/.exec(app)[1]), plans.ALERT_DELAY_MIN);
});

function fakeStripe() {
  const posts = [];
  const users = new Map([['u1', { id: 'u1', email: 'a@b.co' }]]);
  const store = { get: async id => users.get(id), put: async u => users.set(u.id, u), byCustomer: async c => [...users.values()].find(u => u.stripeCustomerId === c) };
  const amounts = { price_pro_m: 7900, price_pro_y: 79000, price_plus_m: 2500, price_plus_y: 25000, price_intro: 4900 };
  const http = {
    post: async (url, body) => { posts.push({ url, body: new URLSearchParams(body) }); return { data: url.endsWith('/customers') ? { id: 'cus_1' } : { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' } }; },
    get: async url => ({ data: { unit_amount: amounts[url.split('/').pop()], currency: 'usd', recurring: { interval: url.endsWith('_y') ? 'year' : 'month' } } }),
  };
  return { posts, users, store, http };
}

test('billing: each plan and period checks out on its own price; unset prices are not on sale', async () => {
  const s = fakeStripe();
  const b = billingLib.createBilling({ http: s.http, secretKey: 'sk_test', priceId: 'price_pro_m', annualPriceId: 'price_pro_y', plusPriceId: 'price_plus_m', introPriceId: 'price_intro', introOpen: async () => true, store: s.store, log: { warn() {} } });
  assert.deepEqual(b.onSale(), { plus: { month: true, year: false }, pro: { month: true, year: true } });
  const u = s.users.get('u1');
  const go = async (plan, interval) => { await b.checkout(u, { successUrl: 'https://x/ok', cancelUrl: 'https://x/', plan, interval }); return s.posts.at(-1).body; };
  let body = await go('plus', 'month');
  assert.equal(body.get('line_items[0][price]'), 'price_plus_m');
  assert.equal(body.get('metadata[plan]'), 'plus');
  body = await go('pro', 'year');
  assert.equal(body.get('line_items[0][price]'), 'price_pro_y', 'annual Pro: never the founding monthly price');
  body = await go('pro', 'month');
  assert.equal(body.get('line_items[0][price]'), 'price_intro', 'Pro monthly: the founding price while seats are left');
  body = await go(undefined, undefined);
  assert.equal(body.get('line_items[0][price]'), 'price_intro', 'no plan named: Pro monthly, as before');
  await assert.rejects(go('plus', 'year'), e => e.status === 400 && /Plus annual is not on sale/.test(e.message));
  await assert.rejects(go('gold', 'month'), e => e.status === 400);
  // a live subscription switches in Billing, never a second checkout
  Object.assign(u, { subscriptionId: 'sub_9', planStatus: 'active' });
  await assert.rejects(go('pro', 'month'), e => e.status === 409 && /Change or cancel it in Billing/.test(e.message));
  const p = await b.prices();
  assert.deepEqual([p.pro.month.amount, p.pro.year.amount, p.plus.month.amount, p.plus.year], [79, 790, 25, null]);
});

test('billing: the webhook writes the tier and period from the price, and a portal switch moves it', async () => {
  const s = fakeStripe();
  s.users.get('u1').stripeCustomerId = 'cus_1';
  const b = billingLib.createBilling({ http: s.http, secretKey: 'sk_test', priceId: 'price_pro_m', annualPriceId: 'price_pro_y', plusPriceId: 'price_plus_m', plusAnnualPriceId: 'price_plus_y', introPriceId: 'price_intro', store: s.store, log: { warn() {} } });
  const sub = price => ({ id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, items: { data: [{ price: { id: price } }] } });
  const u = () => s.users.get('u1');
  await b.handleEvent({ type: 'customer.subscription.created', created: 100, data: { object: sub('price_plus_y') } });
  assert.deepEqual([u().plan, u().planInterval, auth.tierOf(u())], ['plus', 'year', 'plus']);
  await b.handleEvent({ type: 'customer.subscription.updated', created: 200, data: { object: sub('price_pro_m') } });
  assert.deepEqual([u().plan, u().planInterval, auth.tierOf(u())], ['pro', 'month', 'pro'], 'upgraded in the portal');
  await b.handleEvent({ type: 'customer.subscription.updated', created: 300, data: { object: sub('price_intro') } });
  assert.equal(u().plan, 'pro');
  await b.handleEvent({ type: 'customer.subscription.updated', created: 400, data: { object: sub('price_made_by_hand') } });
  assert.equal(u().plan, 'pro', 'a price we do not know counts as Pro, as every subscription did before tiers');
  await b.handleEvent({ type: 'customer.subscription.deleted', created: 500, data: { object: sub('price_plus_m') } });
  assert.deepEqual([u().plan, u().planInterval, auth.tierOf(u())], ['free', null, 'free']);
  assert.equal(b.planOfPrice('price_plus_m').tier, 'plus');
});

test('prices: annual is about two months free, Stripe wins, and only what can be bought is offered', () => {
  const pv = plans.priceView({ env: {} });
  assert.deepEqual([pv.plans.pro.monthly, pv.plans.pro.annual, pv.plans.pro.monthsFree], [79, 790, 2]);
  assert.deepEqual([pv.plans.plus.monthly, pv.plans.plus.annual, pv.plans.plus.monthsFree], [25, 250, 2]);
  assert.equal(pv.plans.plus.onSale.year, true, 'paywall off: every plan shows as the preview');
  const st = plans.priceView({ env: { PLUS_PRICE_MONTHLY: '20' }, paywall: true, catalog: { pro: { month: { amount: 79 }, year: { amount: 699 } }, plus: { month: { amount: 29.99 }, year: null } }, sale: { plus: { month: true, year: false }, pro: { month: true, year: true } } });
  assert.equal(st.plans.plus.monthly, 29.99, 'Stripe\'s amount beats PLUS_PRICE_MONTHLY');
  assert.equal(st.plans.pro.annual, 699);
  assert.equal(st.plans.pro.monthsFree, 3);
  assert.deepEqual(st.plans.plus.onSale, { month: true, year: false });
  const old = plans.priceView({ env: {}, paywall: true });
  assert.deepEqual(old.plans.plus.onSale, { month: false, year: false }, 'no sale list: only Pro monthly, as before');
  assert.deepEqual(old.plans.pro.onSale, { month: true, year: false });
});

test('/pricing: three cards, a monthly/annual switch, and a button only where checkout works', () => {
  const sale = { plus: { month: true, year: true }, pro: { month: true, year: true } };
  const page = plans.pricingPage({ paywall: true, billingConfigured: true, accounts: true, price: plans.priceView({ env: {}, paywall: true, sale }) });
  assert.match(page, /<h1>Free, Plus and Pro<\/h1>/);
  assert.match(page, /id="planPlus"/);
  assert.match(page, /<label for="billY">ANNUAL <b>2 MONTHS FREE<\/b><\/label>/);
  assert.match(page, /href="\/app\?start=plus">GET PLUS</);
  assert.match(page, /href="\/app\?start=plus&amp;interval=year">GET PLUS ANNUAL</);
  assert.match(page, /href="\/app\?start=pro&amp;interval=year">GET PRO ANNUAL</);
  assert.match(page, /\$790<span>\/ year/);
  assert.match(page, /\$65\.83 a month, 2 months free/);
  assert.match(page, /<th>Free<\/th><th>Plus<\/th><th>Pro<\/th>/);
  assert.match(page, /10 minutes after Pro; the same alerts and text/);
  // only monthly on sale: no switch, no annual buttons
  const monthly = plans.pricingPage({ paywall: true, billingConfigured: true, price: plans.priceView({ env: {}, paywall: true, sale: { plus: { month: true, year: false }, pro: { month: true, year: false } } }) });
  assert.doesNotMatch(monthly, /id="billY"|interval=year|\/ year/);
  // Plus not on sale yet: no Plus button pretends to work
  const noPlus = plans.pricingPage({ paywall: true, billingConfigured: true, price: plans.priceView({ env: {}, paywall: true, sale: { plus: { month: false, year: false }, pro: { month: true, year: false } } }), legalEmail: 'a@b.co' });
  assert.match(noPlus, /ASK ABOUT PLUS/);
  assert.match(noPlus, /Plus checkout is not open yet/);
  assert.doesNotMatch(noPlus, /start=plus/);
  for (const p of [page, monthly, noPlus]) assert.doesNotMatch(p, /undefined|NaN|\{\{|href="#"/);
});

test('readiness: the annual and Plus prices are optional and listed by name', () => {
  const r = plans.readiness({ STRIPE_SECRET_KEY: 'sk', STRIPE_PRICE_ID: 'p', STRIPE_PLUS_PRICE_ID: 'pp' });
  assert.ok(!r.missing.includes('STRIPE_PLUS_PRICE_ANNUAL_ID'), 'never holds the switch back');
  assert.deepEqual(r.optionalMissing, ['STRIPE_PRICE_ANNUAL_ID', 'STRIPE_PLUS_PRICE_ANNUAL_ID', 'STRIPE_INTRO_PRICE_ID']);
  assert.doesNotMatch(JSON.stringify(r), /"sk"|"pp"/);
});

test('alert history: Plus sees an open alert once the delay has passed, Free once the game starts', () => {
  const now = Date.parse('2026-10-28T18:00:00Z');
  const start = new Date(now + 3600e3).toISOString();
  const doc = (id, minsAgo) => ({ type: 'alert', id, kind: 'ev', title: 'EV alerts', sentAt: new Date(now - minsAgo * 60e3).toISOString(), lines: ['x'], items: [{ kind: 'ev', key: id, book: 'betrivers', start }] });
  const docs = [doc('a', 2), doc('b', 15)];
  const masked = o => Object.fromEntries(alertlog.view(docs, { now, ...o }).alerts.map(a => [a.id, !!a.masked]));
  assert.deepEqual(masked({ full: true }), { a: false, b: false }, 'Pro: live');
  assert.deepEqual(masked({ full: false, delayMs: 10 * 60e3 }), { a: true, b: false }, 'Plus: 10 minutes late');
  assert.deepEqual(masked({ full: false }), { a: true, b: true }, 'Free: after the start');
});
