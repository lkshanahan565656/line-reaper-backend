// The forms, step by step, with what each step must leave behind: log a bet
// by hand and from the ODDS SCREEN, edit and settle it, export and import the
// CSV, log a slip from PROPS, paste slips, import a Pikkit CSV and an app's
// history (a file and copied text) with its import summary, save and load
// a shopper view, star a venue (and keep it after a reload), turn on push
// alerts without a real push service, use the TOOLS calculator, and move and
// hide a tab in CUSTOMIZE, the keyboard shortcuts and compact rows, share a
// view by link and open it cold on a fresh device, export and print a screen,
// and open a label's glossary definition. The crawl clicks everything; these check results.
'use strict';
/* global pk, renderPkTray, pkClear -- the app's own slip tray, read in page.evaluate */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { watch, settle, openTab, enterApp, newAppPage, checkText, checkOverflow, issue } = require('./crawl');

const ls = (page, k) => page.evaluate(key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }, k);
const text = (page, sel) => page.locator(sel).first().innerText({ timeout: 4000 }).catch(() => '');
function expect(cond, msg) { if (!cond) throw new Error(msg); }

// the Pikkit export the import reads: one row per bet, legs split by |
function pikkitCsv(now) {
  const d = n => new Date(now - n * 86400e3).toISOString();
  return `Bet ID,Time Placed,Sportsbook,Bet Type,League,Description,Odds,Amount,Profit,Status
e2e1,${d(1)},PrizePicks,Parlay,NFL,"Josh Allen Over 245.5 Pass Yds | Stefon Diggs Under 64.5 Rec Yds",+260,10,26,Won
e2e2,${d(2)},DK Pick6,Parlay,NBA,"LeBron James Over 25.5 Points | Anthony Davis Over 11.5 Rebounds",+500,5,-5,Lost
e2e3,${d(20)},Underdog Fantasy,Parlay,MLB,Aaron Judge Over 1.5 Total Bases,+300,10,-10,Lost`;
}

// open a closed <details> panel by tapping its summary, as a viewer would
async function openPanel(page, w, opts, id) {
  if (await page.locator(`#${id}`).evaluate(d => d.open)) return;
  await page.locator(`#${id} > summary`).click();
  await settle(page, w, opts, 60);
}

// open a share link in a fresh browser (no storage, no welcome yet) and check what it restored
async function openCold(opts, link, check) {
  const local = new URL(opts.base).origin;
  const ctx = await opts.coldContext();
  const p2 = await newAppPage(ctx, opts);
  const r2 = { issues: [], requests: 0 };
  const w2 = watch(p2, r2, opts);
  try {
    await p2.goto(link.replace(/^https?:\/\/[^/]+/, local), { waitUntil: 'domcontentloaded' });
    await settle(p2, w2, opts, 400);
    const st = await p2.evaluate(() => ({
      welcome: document.getElementById('welcome')?.classList.contains('open'), tour: document.getElementById('tour')?.classList.contains('open'),
      page: document.querySelector('.page.active')?.id, hash: location.hash, toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '),
      // eslint-disable-next-line no-undef
      shp: window.shpUi && { ...shpUi.opts }, os: { ...osUi, data: null, timer: null }, overflow: document.documentElement.scrollWidth - window.innerWidth,
      chips: [...document.querySelectorAll('#shpModes .active, #oddsModes .active')].map(b => b.textContent),
      osState: document.getElementById('osState')?.value, osSort: document.getElementById('osSort')?.value,
      // eslint-disable-next-line no-undef
      pb: { ...pbState, data: null, record: null, shopRecord: null, card: null, nbm: null, cbm: null, cfm: null }, es: { ...esmState, data: null, open: null }, emu: { game: emuState.game, league: emuState.league },
      pbInputs: ['pbSearch', 'pbSort', 'pbShow', 'pbMarket'].map(id => document.getElementById(id)?.value),
      socShown: document.getElementById('socPane')?.style.display === '',
      esChips: [...document.querySelectorAll('#esModeMatches.active, #esModeProps.active, #esModeMatchups.active')].map(b => b.textContent),
    }));
    expect(!st.welcome && !st.tour, `the welcome screen or tour covered the shared screen (${link})`);
    expect(st.hash === '', `the link stayed in the address bar: ${st.hash}`);
    expect(st.overflow <= 0, `the shared screen is ${st.overflow} px too wide`);
    await checkOverflow(p2, r2, 'odds', `share link ${link}`, opts);
    check(st);
    if (r2.issues.length) throw new Error(`opening ${link}: ${r2.issues[0].kind} ${JSON.stringify(r2.issues[0]).slice(0, 200)}`);
  } finally { await ctx.close(); }
}

const FLOWS = {
  async 'log a bet by hand, edit it, settle it'(page, w, opts) {
    await openTab(page, 'betlog', w, opts);
    const before = (await ls(page, 'lr_bets'))?.length || 0;
    await page.getByRole('button', { name: 'ADD BET' }).click();
    await page.locator('#mybModal.open').waitFor({ timeout: 4000 });
    await page.fill('#mb_pick', 'E2E Chiefs -3');
    await page.fill('#mb_event', 'Raiders @ Chiefs');
    await page.fill('#mb_odds', '-110');
    await page.fill('#mb_stake', '25');
    await page.fill('#mb_book', 'Kalshi');
    await page.fill('#mb_sport', 'NFL');
    await settle(page, w, opts, 60);
    const hint = await text(page, '#mbHint');
    expect(/to win \$22\.73/.test(hint), `the form's hint should read "to win $22.73", read "${hint}"`);
    await page.locator('#mybModal button.primary').click();
    await settle(page, w, opts, 120);
    expect(!(await page.locator('#mybModal.open').count()), 'the form stayed open after Log bet');
    const after = await ls(page, 'lr_bets');
    expect(after?.length === before + 1, `lr_bets went from ${before} to ${after?.length}`);
    expect(/E2E Chiefs -3/.test(await text(page, '#mybList')), 'the new bet is not in the list');
    // edit: settle it as a win
    await page.locator('#mybList .mb-more', { hasText: 'Edit' }).first().click();
    await page.locator('#mybModal.open').waitFor({ timeout: 4000 });
    await page.selectOption('#mb_result', 'win');
    await page.locator('#mybModal button.primary').click();
    await settle(page, w, opts, 120);
    const bet = (await ls(page, 'lr_bets')).find(b => b.pick === 'E2E Chiefs -3');
    expect(bet?.result === 'win', `the bet's result is ${bet?.result}, not win`);
    const stats = await text(page, '#mybStats');
    expect(/22\.73/.test(stats), `the stats should show the $22.73 profit: "${stats.slice(0, 200)}"`);
  },

  async 'download the public record from RESULTS'(page, w, opts) {
    await openTab(page, 'results', w, opts);
    await page.locator('#recordContent .rec-tiles').waitFor({ timeout: 6000 });
    const tiles = await text(page, '#recordContent');
    expect(/PROVEN/.test(tiles) && /GRADED GAMES/.test(tiles), `the record's summary did not render: "${tiles.slice(0, 160)}"`);
    // the 30-day window carries over to the download
    await page.locator('#page-results [data-days="30"]').click();
    await settle(page, w, opts, 150);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.locator('#recCsv').click()]);
    expect(/^line-reaper-record-30d-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename()), `the CSV is named "${dl.suggestedFilename()}"`);
    const file = path.join(os.tmpdir(), `lr-e2e-record-${process.pid}-${opts.viewportName}.csv`);
    await dl.saveAs(file);
    const csv = fs.readFileSync(file, 'utf8');
    fs.rmSync(file, { force: true });
    const head = csv.split(/\r?\n/)[0].split(',');
    for (const c of ['flaggedAt', 'book', 'priceDecimal', 'fillUsd', 'closeProb', 'clvPct', 'result', 'units']) expect(head.includes(c), `the CSV has no ${c} column: "${head.join(',')}"`);
    const [dj] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.locator('#recJson').click()]);
    expect(/\.json$/.test(dj.suggestedFilename()), `the JSON download is named "${dj.suggestedFilename()}"`);
    await page.locator('#page-results [data-days="0"]').click();
    await settle(page, w, opts, 150);
  },

  async 'every priced row links to its venue, and a tap is counted'(page, w, opts) {
    // TEST DATA, not a recording, for the two views the recording has no rows
    // for (MATCHUPS and the public record): labelled made-up rows, so the
    // links are checked on real markup. Everything else reads the recording.
    const TEST_MATCHUPS = { game: 'LOL', label: 'LoL', status: { ready: true, series: 100 }, matchups: [
      { id: 'e2e-mu-1', game: 'LOL', league: 'LCK', start: new Date((opts.now || Date.now()) + 5 * 3600e3).toISOString(), bestOf: 3,
        teams: [{ name: 'E2E Alpha', code: 'EA' }, { name: 'E2E Bravo', code: 'EB' }], teamViews: [], model: { priced: true, win: 0.55, confidence: 'ok' },
        markets: { kalshi: { prob: 0.52, url: 'https://kalshi.com/markets/kxlolgame-26oct25eaeb', sides: [{ cost: 0.53 }, { cost: 0.49 }] },
          pmus: { prob: 0.51, slug: 'aec-lol-ea-eb-2026-10-25', sides: [{ cost: 0.52 }, { cost: 0.5 }] } } }] };
    const TEST_RECORD = { rule: { text: 'TEST DATA.' }, proven: 0, overall: { graded: 60, clv: 0.4 }, labels: [], columns: ['flaggedAt'], rows: [
      { recorded: true, label: 'building', kind: 'e2e', kindLabel: 'E2E kind', book: 'kalshi', bookName: 'Kalshi', texas: true, graded: 12, target: 50, clv: 0.5, clvT: 0.4, beatPct: 55, wins: 6, losses: 6, units: -0.4 },
      { recorded: true, label: 'too early', kind: 'e2e', kindLabel: 'E2E kind', book: 'prizepicks', bookName: 'PrizePicks', texas: true, graded: 3, target: 50, clv: null, wins: 1, losses: 2, units: -1 }] };
    await page.route(/\/api\/esports\/matchups\?/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEST_MATCHUPS) }));
    await page.route(/\/api\/record(\?|$)/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEST_RECORD) }));
    const views = [];
    const look = async label => {
      await settle(page, w, opts, 300);
      const r = await page.evaluate(() => {
        const pg = document.querySelector('.page.active'), vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
        const rows = [...pg.querySelectorAll('[data-vrow]')].filter(vis), links = [...pg.querySelectorAll('a.vlink')].filter(vis);
        const bad = links.filter(a => !window.LRVenue.validFor(a.dataset.venue, a.getAttribute('href')) || a.target !== '_blank').map(a => a.getAttribute('href'));
        return { rows: rows.length, bare: rows.filter(x => !x.querySelector('a.vlink')).length, links: links.length, bad, hosts: [...new Set(links.map(a => new URL(a.href).hostname))] };
      });
      views.push({ label, ...r });
      expect(r.rows > 0, `${label}: no priced row rendered`);
      expect(!r.bare, `${label}: ${r.bare} of ${r.rows} priced rows have no venue link`);
      expect(!r.bad.length, `${label}: venue links with a wrong host or window: ${r.bad.slice(0, 3).join(' ')}`);
      expect(!r.hosts.some(h => /(^|\.)polymarket\.com$/.test(h)), `${label}: a link to polymarket.com`);
    };
    await openTab(page, 'odds', w, opts);
    for (const m of ['lines', 'opps', 'markets', 'maker', 'outrights', 'nflmodel']) {
      await page.evaluate(m => window.shpSet('mode', m), m);
      await look(`ODDS SCREEN ${m}`);
    }
    // the tap: a new tab opens on the venue, and the count goes up (the live check sends no POST)
    const before = (await (await page.request.get(`${opts.base}/api/ops`)).json()).venueTaps?.total || 0;
    await page.evaluate(() => window.shpSet('mode', 'lines'));
    await settle(page, w, opts, 200);
    const link = page.locator('#page-odds a.vlink[data-venue="kalshi"]').first();
    const [pop] = await Promise.all([page.waitForEvent('popup', { timeout: 4000 }).catch(() => null), link.click()]);
    expect(pop, 'tapping a venue link opened no new tab');
    await pop?.close().catch(() => {});
    if (!opts.live) {
      // a tap from an earlier crawl click can land late, so the count must rise by at least one
      let after = null;
      for (let i = 0; i < 15; i++) {
        await settle(page, w, opts, 200);
        after = (await (await page.request.get(`${opts.base}/api/ops`)).json()).venueTaps;
        if (after && after.total > before) break;
      }
      expect(after && after.total > before && after.byVenue?.kalshi?.total >= 1, `the tap was not counted in /api/ops: ${JSON.stringify(after)}`);
    }
    await page.evaluate(() => window.shpSet('mode', 'lines'));
    await openTab(page, 'esports', w, opts);
    await page.evaluate(() => window.setEsMode('matches'));
    await look('ESPORTS matches');
    await page.evaluate(() => window.setEsMode('matchups'));
    await look('MATCHUPS');
    await openTab(page, 'props', w, opts);
    for (const v of ['lines', 'shop']) { await page.evaluate(v => window.pbSet('view', v), v); await look(`PROPS ${v}`); }
    await page.evaluate(() => window.pbSet('view', 'lines'));
    await openTab(page, 'results', w, opts);
    await page.evaluate(() => window.resultsView('record'));
    await look('RESULTS record');
    await page.unroute(/\/api\/esports\/matchups\?/); await page.unroute(/\/api\/record(\?|$)/);
  },

  async 'feeds down or empty: each view says what is happening'(page, w, opts) {
    // Railway's answer while a deploy swaps in: a 502 with an HTML page
    const DOWN = r => (r.request().method() === 'GET' && !/\/stream\b/.test(r.request().url()) ? r.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Application failed to respond</body></html>' }) : r.continue());
    // every list in every answer emptied: the shape of a quiet board
    const hollow = x => (Array.isArray(x) ? [] : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, hollow(v)])) : x);
    const EMPTY = async r => {
      if (r.request().method() !== 'GET' || /\/stream\b/.test(r.request().url())) return r.continue();
      const res = await r.fetch(); let body = await res.text();
      try { body = JSON.stringify(hollow(JSON.parse(body))); } catch { /* not JSON: as it came */ }
      return r.fulfill({ status: res.status(), contentType: res.headers()['content-type'] || 'application/json', body });
    };
    const RAW = /\bHTTP \d{3}\b|Unexpected token|is not valid JSON|Failed to fetch|\[object|\bundefined\b|Railway logs|BACKEND_URL/;
    const VIEWS = [['odds', null], ['odds', ['shpSet', 'mode', 'opps']], ['odds', ['shpSet', 'mode', 'maker']], ['odds', ['shpSet', 'mode', 'outrights']], ['odds', ['shpSet', 'mode', 'lines']],
      ['best', null], ['tail', null], ['arb', null], ['big', null], ['gas', null], ['esports', ['setEsMode', 'matches']], ['esports', ['setEsMode', 'matchups']], ['esports', ['setEsMode', 'matches']],
      ['results', null], ['props', ['pbSet', 'view', 'shop']], ['props', ['pbSet', 'view', 'model']], ['props', ['pbSet', 'view', 'lines']], ['ev', null], ['sharp', null]];
    try {
    for (const [mode, handler, want] of [['down', DOWN, /restarting for an update|Couldn't reach the server|Could not refresh/], ['empty', EMPTY, null]]) {
      await page.route('**/api/**', handler);
      w.forced5xx = mode === 'down';
      try {
      for (const [tab, call] of VIEWS) {
        // only a view that asked the server and got the 502 owes a word about it (one on cached data may not ask)
        const failed = [];
        // background pollers that run on every tab (the sharp feed says so on its own view) don't count against this view
        const onRes = r => { const p = new URL(r.url()).pathname; if (r.status() === 502 && r.url().startsWith(opts.base) && !/^\/api\/(sharp-moves|health|ops)\b/.test(p)) failed.push(p); };
        page.on('response', onRes);
        await openTab(page, tab, w, opts);
        if (call) await page.evaluate(([f, ...a]) => window[f](...a), call);
        await settle(page, w, opts, 400);
        page.off('response', onRes);
        const t = await page.evaluate(() => { const pg = document.querySelector('.page.active'); return pg ? pg.innerText.replace(/\s+/g, ' ') : ''; });
        const where = `${mode}: ${tab}${call ? ' ' + call.slice(1).join(' ') : ''}`;
        expect(t.trim().length > 80, `${where}: the view is blank`);
        const raw = RAW.exec(t);
        expect(!raw, `${where}: shows a raw error "${raw && t.slice(Math.max(0, raw.index - 60), raw.index + 60)}"`);
        if (want && failed.length) expect(want.test(t), `${where}: no word on the server being down (${[...new Set(failed)].join(' ')} got 502): "${t.slice(-200)}"`);
      }
      } finally {
        await page.unroute('**/api/**', handler);
        w.forced5xx = false;
      }
    }
    } finally {
      // back to the recording: reload, so later flows see its data, not the emptied copy
      await page.goto(`${opts.base}/app`, { waitUntil: 'domcontentloaded' });
      await settle(page, w, opts, 300);
    }
  },

  async 'read the weekly digest from RESULTS'(page, w, opts) {
    // TEST DATA, not a recording: digest.js run on a labelled made-up record
    // (one venue proven this week, one losing to the close), so the view is
    // checked against known numbers. The live check reads the real API.
    const D = require('../digest');
    const W0 = Date.parse('2026-10-19T00:00:00Z');
    const row = (i, book, start, clv) => ({ id: `e2e-${book}-${i}`, book, sport: 'nfl', event: `E2E Away${i} @ E2E Home${i}`, market: 'h2h', side: 'E2E', status: 'closed', closeOk: true,
      flaggedAt: new Date(start - 3 * 3600e3).toISOString(), start: new Date(start).toISOString(), decimal: 2.1, clv: clv + (i % 3) * 0.2, closeFair: 50, outcome: i % 2 ? 'loss' : 'win' });
    const ev = [];
    for (let i = 0; i < 55; i++) ev.push(row(i, 'fanduel', i < 40 ? W0 - 20 * 86400e3 + i * 18e6 : W0 + 86400e3 + (i - 40) * 18e6, 3));
    for (let i = 0; i < 20; i++) ev.push(row(i, 'betrivers', W0 + 2 * 86400e3 + i * 18e6, -4));
    const TEST_WEEK = { digest: D.build({ lists: { ev }, week: '2026-10-19', now: Date.parse('2026-10-26T13:00:00Z') }), frozen: true, sentAt: '2026-10-26T13:00:04Z', pushed: 2, share: '/digest/2026-10-19' };
    const TEST_NOW = { digest: D.build({ lists: { ev }, week: '2026-10-26', now: Date.parse('2026-10-27T09:00:00Z') }), frozen: false, sentAt: null, pushed: null, share: '/digest/2026-10-26' };
    const TEST_LIST = { at: '2026-10-27T09:00:00Z', current: '2026-10-26', sendsAt: 'Monday 13:00 UTC', nextSend: '2026-11-02T13:00:00Z', weeks: [
      { week: '2026-10-26', name: 'Oct 26 to Nov 1', partial: true, frozen: false, sentAt: null, graded: null, share: '/digest/2026-10-26' },
      { week: '2026-10-19', name: 'Oct 19 to 25', partial: false, frozen: true, sentAt: '2026-10-26T13:00:04Z', graded: 35, share: '/digest/2026-10-19' }] };
    if (!opts.live) {
      await page.route('**/api/digest', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEST_LIST) }));
      await page.route('**/api/digest/*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(/2026-10-26/.test(r.request().url()) ? TEST_NOW : TEST_WEEK) }));
    }
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    try {
      await openTab(page, 'results', w, opts);
      await page.locator('#page-results [data-recview="digest"]').click();
      await page.locator('#digestContent .rec-tiles').waitFor({ timeout: 6000 });
      await settle(page, w, opts, 150);
      const body = await text(page, '#digestContent');
      expect(/WEEK OF/.test(body) && /GRADED THIS WEEK/.test(body) && /BY KIND AND VENUE/.test(body), `the digest did not render: "${body.slice(0, 200)}"`);
      expect(await page.locator('#recView').isHidden(), 'the record table still shows under the digest');
      const share = await page.locator('#digestShare').getAttribute('href');
      expect(/^\/digest\/\d{4}-\d{2}-\d{2}$/.test(share || ''), `the share link is "${share}"`);
      expect(await fits(), 'the digest scrolls sideways at this size');
      if (!opts.live) {
        expect(/WEEK OF OCT 19 TO 25/.test(body), 'the last published week opens first');
        expect(/Published .* and frozen/.test(body) && /push reached 2 devices/.test(body), 'a published week says it is frozen and how many phones got it');
        const rows = await page.locator('#digestContent .rec-tbl tbody tr').allInnerTexts();
        expect(rows.length === 2, `${rows.length} rows for 2 venues`);
        const fd = rows.find(r => /FanDuel/.test(r)) || '', br = rows.find(r => /BetRivers/.test(r)) || '';
        expect(/NEWLY PROVEN/.test(fd) && /40 → 55\/50/.test(fd) && /\b15\b/.test(fd), `FanDuel row: "${fd.replace(/\s+/g, ' ')}"`);
        expect(/LOSING TO THE CLOSE/.test(br) && /0 → 20\/50/.test(br), `BetRivers row: "${br.replace(/\s+/g, ' ')}"`);
        expect(/\+[\d.]+u\*/.test(fd), 'units on a record that does not clear chance carry the * (not a profit claim)');
        expect(/profit not shown yet/.test(body), 'the proven line must say profit is not shown');
        // this week so far
        await page.locator('#digestWeeks [data-week="2026-10-26"]').click();
        await page.waitForFunction(() => /This week so far/.test(document.getElementById('digestContent').textContent), null, { timeout: 4000 });
        expect(await fits(), 'the week so far scrolls sideways at this size');
        await page.locator('#digestWeeks [data-week="2026-10-19"]').click();
        await settle(page, w, opts, 120);
      }
      await page.locator('#page-results [data-recview="record"]').click();
      await settle(page, w, opts, 150);
      expect(await page.locator('#recView').isVisible(), 'RECORD did not come back');
    } finally {
      if (!opts.live) { await page.unroute('**/api/digest').catch(() => {}); await page.unroute('**/api/digest/*').catch(() => {}); }
    }
    // the share page itself, from the server (the offline server's own record in tests)
    const list = opts.live ? await (await page.request.get(`${opts.base}/api/digest`)).json() : null;
    const wk = list ? (list.weeks.find(x => !x.partial) || list.weeks[0]).week : D.weekId(Date.now());
    try {
      const res = await page.goto(`${opts.base}/digest/${wk}`, { waitUntil: 'domcontentloaded' });
      expect(res && res.status() === 200, `the share page answered ${res && res.status()}`);
      const h1 = await text(page, 'h1');
      expect(/^Week of /.test(h1), `the share page heading is "${h1}"`);
      expect(await fits(), 'the share page scrolls sideways at this size');
      const all = await page.evaluate(() => document.body.innerText);
      expect(!/guaranteed|risk[- ]free|undefined|NaN/i.test(all), 'the share page shows a claim or broken text');
    } finally {
      await page.goto(`${opts.base}/app`, { waitUntil: 'domcontentloaded' });
      await settle(page, w, opts, 300);
    }
  },

  async 'export the bets CSV and import it back'(page, w, opts) {
    await openTab(page, 'betlog', w, opts);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.getByRole('button', { name: 'EXPORT CSV' }).click()]);
    const file = path.join(os.tmpdir(), `lr-e2e-bets-${process.pid}-${opts.viewportName}.csv`);
    await dl.saveAs(file);
    const csv = fs.readFileSync(file, 'utf8');
    expect(/E2E Chiefs -3/.test(csv), 'the export does not hold the logged bet');
    // the same file again: nothing new, and the toast says so
    const before = (await ls(page, 'lr_bets')).length;
    await page.locator('#page-betlog input[type=file]').setInputFiles(file);
    await settle(page, w, opts, 150);
    expect((await ls(page, 'lr_bets')).length === before, 'importing the same CSV added bets twice');
    // a file from another tracker, with its own column names
    fs.writeFileSync(file, `Date,Game,Selection,American Odds,Risk,Sportsbook,Status\n${new Date(opts.now).toISOString()},Yankees @ Red Sox,E2E Imported Over 8.5,+120,10,Kalshi,pending\n`);
    await page.locator('#page-betlog input[type=file]').setInputFiles(file);
    await settle(page, w, opts, 150);
    const list = await ls(page, 'lr_bets');
    expect(list.length === before + 1 && list.some(b => /E2E Imported/.test(b.pick)), `the imported row did not come in (${list.length} bets)`);
    fs.rmSync(file, { force: true });
  },

  async 'log a bet from the ODDS SCREEN'(page, w, opts) {
    await openTab(page, 'odds', w, opts);
    const games = page.locator('#oddsModes button', { hasText: 'GAME LINES' });
    if (await games.count()) await games.first().click();
    await settle(page, w, opts, 200);
    const log = page.locator('#page-odds button.os-log').first();
    await log.waitFor({ timeout: 6000 });
    const before = (await ls(page, 'lr_bets'))?.length || 0;
    await log.click();
    await page.locator('#mybModal.open').waitFor({ timeout: 4000 });
    const pick = await page.inputValue('#mb_pick');
    expect(pick, 'the bet form opened without the pick filled in');
    expect(await page.locator('#mybModal .mb-venues button').count() > 0, 'the form shows no venues to pick a price from');
    await page.locator('#mybModal .mb-venues button').first().click();
    if (!(await page.inputValue('#mb_stake'))) await page.fill('#mb_stake', '20');
    await page.locator('#mybModal button.primary').click();
    await settle(page, w, opts, 200);
    const list = await ls(page, 'lr_bets');
    expect(list?.length === before + 1, 'the bet from the odds screen was not logged');
    const bet = list.find(b => b.pick === pick);
    expect(bet?.track?.kind === 'line', `the odds screen bet is not tracked as a line (${JSON.stringify(bet?.track)})`);
  },

  async 'log a slip from PROPS'(page, w, opts) {
    await openTab(page, 'props', w, opts);
    const lines = page.locator('#page-props button', { hasText: /^LINES$/ });
    if (await lines.count()) { await lines.first().click(); await settle(page, w, opts, 200); }
    const add = page.locator('#pbContent button.ln-add');
    await add.first().waitFor({ timeout: 6000 });
    expect(await add.count() >= 2, `PROPS > LINES shows ${await add.count()} legs to add`);
    // two different players
    const names = await page.locator('#pbContent .ln-row').evaluateAll(rows => rows.slice(0, 40).map(r => (r.querySelector('.ln-player, b, .c')?.innerText || '').split('\n')[0]));
    const second = Math.max(1, names.findIndex((n, i) => i > 0 && n !== names[0]));
    await add.nth(0).click();
    await settle(page, w, opts, 80);
    await add.nth(second).click();
    await settle(page, w, opts, 80);
    const tray = page.locator('#pkTray');
    expect(await tray.isVisible(), 'the slip tray did not open');
    expect(/2 PICKS/.test(await tray.innerText()), `the tray should say 2 PICKS: "${(await tray.innerText()).slice(0, 120)}"`);
    const before = (await ls(page, 'lr_slips'))?.length || 0;
    // a pick whose game has started is refused in words, and nothing is logged
    const start0 = await page.evaluate(() => { const s = pk.legs[0].start; pk.legs[0].start = new Date(Date.now() - 3600e3).toISOString(); return s; });
    await page.locator('#pkTray button', { hasText: 'LOG SLIP' }).click();
    await settle(page, w, opts, 150);
    expect(/Not logged\..*started at/.test(await tray.innerText()), `a started pick should be refused in the tray: "${(await tray.innerText()).slice(0, 200)}"`);
    expect(((await ls(page, 'lr_slips'))?.length || 0) === before, 'a slip with a started pick was logged');
    // back to the real start; the offline recording is days old, so its games read as started:
    // there they are moved two hours ahead (live, the board's own starts are ahead already)
    await page.evaluate(s => { const ahead = new Date(Date.now() + 2 * 3600e3).toISOString(); for (const l of pk.legs) if (!(Date.parse(l.start) > Date.now())) l.start = ahead; if (Date.parse(s) > Date.now()) pk.legs[0].start = s; pk.refused = ''; renderPkTray(); }, start0);
    // offline, the server's board is the recording, days old, so it rightly refuses
    // these games as started: TEST DATA, its stamp answer is replaced by one that
    // passes every leg (test/slipstamp.test.js and slipgrade-server cover the server)
    const fakeStamp = async route => { const b = route.request().postDataJSON(); await route.fulfill({ json: { at: new Date().toISOString(), ok: true, started: 0, unmatched: 0, why: null, app: b.app,
      legs: b.legs.map((l, i) => ({ i, ...l, status: 'ok', start: l.start, matchTitle: 'TEST', fair: 0.55, pin: 0.54, mult: null, appLine: l.line })) } }); };
    if (!opts.live) await page.route('**/api/slips/stamp', fakeStamp);
    // type the stake the way a viewer does, then tap LOG SLIP straight away
    await tray.locator('input[type=number]').first().click();
    await page.keyboard.type('10');
    await page.locator('#pkTray button', { hasText: 'LOG SLIP' }).click();
    await settle(page, w, opts, 250);
    if (!opts.live) await page.unroute('**/api/slips/stamp', fakeStamp);
    // live, a row whose game is under way is refused in words: the right answer, not a failure
    if (opts.live && /Not logged\..*started at/.test(await tray.innerText().catch(() => ''))) { await page.evaluate(() => pkClear()); return; }
    const slips = await ls(page, 'lr_slips');
    expect(slips?.length === before + 1, `lr_slips went from ${before} to ${slips?.length}`);
    expect(slips[0].legs.length === 2 && slips[0].stake === 10, `the logged slip has ${slips[0].legs.length} legs, stake ${slips[0].stake}`);
    // checked by the server at the tap: its clock, a verdict for every pick
    expect(slips[0].stamp?.at && Math.abs(Date.parse(slips[0].stamp.at) - Date.parse(slips[0].placedAt)) < 1000 && slips[0].stamp.legs.length === 2, `the logged slip carries no server stamp: ${JSON.stringify(slips[0].stamp)}`);
    await openTab(page, 'myslips', w, opts);
    expect((await text(page, '#msList')).includes(slips[0].legs[0].player), 'MY SLIPS does not show the logged slip');
  },

  async 'LOG A SLIP: a copied app slip checked and logged, an old one refused, one shared to the app'(page, w, opts) {
    await openTab(page, 'myslips', w, opts);
    const before = (await ls(page, 'lr_slips'))?.length || 0;
    await page.locator('#msLogcBtn').click();
    // TEST DATA: made-up players, as PrizePicks' entry text reads when copied
    await page.fill('#msLogcText', 'PrizePicks 2-Pick Power Play\nTesta Onefake\nMore 24.5 Points\nTesta Twofake\nLess 7.5 Rebounds');
    await page.locator('#msLogcGo').click();
    await settle(page, w, opts, 250);
    const out = await text(page, '#msLogcOut');
    expect(/logged at/.test(out) && /NOT ON A BOARD/.test(out), `LOG A SLIP should log the slip and say the picks aren't on a board: "${out.slice(0, 300)}"`);
    const slips = await ls(page, 'lr_slips');
    expect(slips?.length === before + 1 && slips[0].stamp?.at && slips[0].source === 'paste', `LOG A SLIP saved ${slips?.length - before} slips, stamp ${JSON.stringify(slips?.[0]?.stamp)?.slice(0, 80)}`);
    expect(/checked by the server/.test(await text(page, '#msList')), 'MY SLIPS does not say the slip was checked by the server');
    // a slip whose text shows an old placing time is history, not a fresh log
    await page.fill('#msLogcText', 'PrizePicks Oct 1, 2026, 12:58 PM\nTesta Onefake\nMore 24.5 Points\nTesta Twofake\nLess 7.5 Rebounds');
    await page.locator('#msLogcGo').click();
    await settle(page, w, opts, 150);
    expect(/not logged/.test(await text(page, '#msLogcOut')) && ((await ls(page, 'lr_slips'))?.length === before + 1), 'an old slip should be refused by LOG A SLIP');
    // shared from the app's Share sheet to the installed app
    await page.goto(`${opts.base}/app?share_text=${encodeURIComponent('Underdog\nTesta Threefake\nHigher 1.5 Kills\nTesta Fourfake\nLower 30.5 Kills')}`, { waitUntil: 'domcontentloaded' });
    await settle(page, w, opts, 300);
    expect(await page.locator('#msLogc').isVisible(), 'a shared slip should open LOG A SLIP');
    expect(/Testa Threefake/.test(await page.locator('#msLogcText').inputValue()), 'the shared text is not in the box');
    expect(!/share_text/.test(page.url()), 'the shared text stays in the address bar');
  },

  async 'paste slips into MY SLIPS'(page, w, opts) {
    await openTab(page, 'myslips', w, opts);
    const before = (await ls(page, 'lr_slips'))?.length || 0;
    await page.locator('#page-myslips .mb-actions button', { hasText: 'PASTE SLIPS' }).click();
    await page.fill('#msText', 'PrizePicks $10 to win $30\nJosh Allen Over 245.5 Pass Yds\nStefon Diggs Under 64.5 Rec Yds\n\nUnderdog $5\nAaron Judge Under 1.5 Total Bases\nJuan Soto Over 0.5 Hits');
    await page.getByRole('button', { name: 'ADD SLIPS' }).click();
    await settle(page, w, opts, 250);
    const slips = await ls(page, 'lr_slips');
    expect(slips?.length === before + 2, `pasting two slips made ${slips?.length - before}`);
    expect(/Josh Allen/.test(await text(page, '#msList')), 'the pasted slip is not listed');
  },

  async 'PUBLISH RECORD: a public page of my slips, opened and unpublished'(page, w, opts) {
    await openTab(page, 'myslips', w, opts);
    // TEST DATA: a made-up slip, so the record has something to show
    await page.locator('#page-myslips .mb-actions button', { hasText: 'PASTE SLIPS' }).click();
    await page.fill('#msText', 'PrizePicks\nJosh Allen Over 245.5 Pass Yds\nStefon Diggs Under 64.5 Rec Yds');
    await page.getByRole('button', { name: 'ADD SLIPS' }).click();
    await settle(page, w, opts, 200);
    await page.locator('#msPubBtn').click();
    await settle(page, w, opts, 100);
    expect(await page.locator('#msPub').isVisible(), 'PUBLISH RECORD opened nothing');
    const handle = `e2e_${opts.viewportName.slice(0, 4)}_${String(Date.now()).slice(-6)}`;
    await page.fill('#msPubHandle', handle);
    await page.locator('#msPub button', { hasText: /^PUBLISH$/ }).click();
    await settle(page, w, opts, 600);
    const pub = await ls(page, 'lr_pub_record');
    const slips = await ls(page, 'lr_slips');
    expect(pub?.handle === handle && /^lrr_/.test(pub.key || ''), `no record saved after PUBLISH: ${JSON.stringify(pub)?.slice(0, 120)}`);
    expect((pub.sent || []).length === slips.length, `${(pub.sent || []).length} of ${slips.length} slips sent`);
    const panel = await text(page, '#msPub');
    expect(panel.includes(`/r/${handle}`) && /COPY KEY/.test(panel), `the panel does not show the page link and key: "${panel.slice(0, 160)}"`);
    expect(/RECORD @/.test(await text(page, '#msPubBtn')), 'the button should name the published handle');
    // the page: the same for everyone, the disclosure, every slip, nothing broken, fits a phone
    const p2 = await page.context().newPage();
    try {
      await p2.setViewportSize(page.viewportSize());
      const r = await p2.goto(`${opts.base}/r/${handle}`, { waitUntil: 'domcontentloaded' });
      expect(r.status() === 200, `/r/${handle} answered ${r.status()}`);
      const body = await p2.locator('body').innerText();
      expect(/not placed through Line Reaper/.test(body) && /Josh Allen/.test(body), 'the record page lacks the disclosure or the slip');
      expect(!/undefined|NaN|guaranteed|risk[- ]free/i.test(body), 'the record page shows broken text or a claim');
      const over = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over <= 0, `the record page is ${over} px too wide`);
      const og = await p2.locator('meta[property="og:image"]').getAttribute('content');
      expect(new RegExp(`/card/record-${handle}\\.png`).test(og || ''), `og:image is not the record card: ${og}`);
      const csv = await p2.request.get(`${opts.base}/api/records/${handle}/slips.csv`);
      const rows = csv.ok() ? (await csv.text()).split('\n').filter(Boolean) : [];
      expect(/^slip_id,/.test(rows[0] || '') && rows.filter(x => /Josh Allen|Stefon Diggs/.test(x)).length >= 2, 'the CSV should hold the pasted legs');
    } finally { await p2.close(); }
    // unpublish: the first tap asks, the second removes the page
    await page.locator('#msPub button', { hasText: 'UNPUBLISH' }).click();
    await settle(page, w, opts, 80);
    await page.locator('#msPub button', { hasText: 'TAP AGAIN TO UNPUBLISH' }).click();
    await settle(page, w, opts, 300);
    expect((await ls(page, 'lr_pub_record'))?.unpublished === true, 'UNPUBLISH did not take');
    const gone = await (await page.request.get(`${opts.base}/r/${handle}`)).text();
    expect(/unpublished/.test(gone) && !/Josh Allen/.test(gone), 'the unpublished page still shows slips');
    // leave the next flow a browser with no record
    await page.locator('#msPub button', { hasText: 'FORGET THIS HANDLE' }).click();
    await page.locator('#msPub button', { hasText: 'CLOSE' }).click();
    await settle(page, w, opts, 60);
  },

  async 'import a Pikkit CSV'(page, w, opts) {
    await openTab(page, 'myslips', w, opts);
    const file = path.join(os.tmpdir(), `lr-e2e-pikkit-${process.pid}-${opts.viewportName}.csv`);
    fs.writeFileSync(file, pikkitCsv(opts.now));
    await page.locator('#page-myslips input[type=file]').setInputFiles(file);
    await settle(page, w, opts, 300);
    fs.rmSync(file, { force: true });
    const pk = await ls(page, 'lr_pikkit');
    expect(pk?.bets?.length === 3, `lr_pikkit holds ${pk?.bets?.length} bets, not 3`);
    const shown = await text(page, '#msPikkit');
    expect(/PrizePicks/i.test(shown) && /Pick6/i.test(shown), `the Pikkit breakdown does not list the apps: "${shown.slice(0, 160)}"`);
    const slips = await ls(page, 'lr_slips');
    expect(slips.some(s => s.id === 'pk-e2e1') && !slips.some(s => s.id === 'pk-e2e3'), 'the recent Pikkit slips should be added, the 20-day-old one not');
    // the older bets go to the box-score grader on one tap, with Pikkit's result kept
    const more = page.locator('#msPikkit button', { hasText: 'FROM BOX SCORES' });
    expect(await more.count() === 1, 'no GRADE MORE FROM BOX SCORES button under the Pikkit history');
    await more.first().click();
    await settle(page, w, opts, 300);
    const after = await ls(page, 'lr_slips');
    const old = after.find(s => s.id === 'pk-e2e3');
    expect(old && old.result === 'loss' && old.legs[0].sport === 'MLB', 'the 20-day-old Pikkit bet should be added with its result and league');
    expect(await page.locator('#msPikkit button', { hasText: 'FROM BOX SCORES' }).count() === 0, 'the button should go once every bet is in');
  },

  async 'import an Underdog history file and pasted Sleeper text'(page, w, opts) {
    await openTab(page, 'myslips', w, opts);
    const d = n => new Date(opts.now - n * 3600e3).toISOString();
    // a test file in the per-leg layout (entry id, player, stat, line, Higher/Lower); one leg row has no line
    const csv = `Entry ID,Created At,Entry Type,Entry Fee,Payout,Status,Sport,Player,Stat,Line,Higher/Lower
e2eU1,${d(5)},Standard,10,0,Lost,NFL,Josh Allen,Passing Yards,245.5,Higher
e2eU1,${d(5)},Standard,10,0,Lost,NFL,James Cook,Rushing Yards,62.5,Lower
e2eU2,${d(4)},Standard,5,17.5,Won,NBA,LeBron James,Points,,Higher`;
    const file = path.join(os.tmpdir(), `lr-e2e-underdog-${process.pid}-${opts.viewportName}.csv`);
    fs.writeFileSync(file, csv);
    await page.locator('#page-myslips input[type=file]').setInputFiles(file);
    await settle(page, w, opts, 300);
    fs.rmSync(file, { force: true });
    const imps = await ls(page, 'lr_slip_imports');
    const ud = imps?.find(x => x.format === 'underdog');
    expect(ud && ud.rows === 3 && ud.unread.length === 1, `the Underdog import was kept as ${JSON.stringify(ud)?.slice(0, 160)}`);
    const slips = await ls(page, 'lr_slips');
    expect(slips.some(s => s.id === 'ud-e2eU1' && s.legs.length === 2 && s.importId === ud.id), 'the Underdog entry with two legs should be a slip');
    const card = page.locator('#msImports .ms-imp', { hasText: 'Underdog CSV' }).first();
    const shown = await card.innerText({ timeout: 4000 }).catch(() => '');
    expect(/Bets read/i.test(shown) && /Legs matched/i.test(shown) && /Record/i.test(shown) && /1-1/.test(shown), `the Underdog import card reads "${shown.slice(0, 200)}"`);
    // the leg with no line is listed by its row
    await card.locator('summary').first().click();
    await settle(page, w, opts, 60);
    const list = await card.innerText({ timeout: 4000 }).catch(() => '');
    expect(/Row 4/.test(list) && /no line on this row/.test(list), `the unmatched row is not listed: "${list.slice(-200)}"`);
    // Sleeper history pasted as copied text
    await page.locator('#page-myslips .mb-actions button', { hasText: 'PASTE SLIPS' }).click();
    await page.fill('#msText', 'Sleeper Picks\n$10 · 2 picks · Won $30\nConnor McDavid\nOver 1.5 Points\nAuston Matthews\nUnder 3.5 Shots');
    await page.getByRole('button', { name: 'ADD SLIPS' }).click();
    await settle(page, w, opts, 250);
    const after = await ls(page, 'lr_slips');
    const sl = after.find(s => s.app === 'sleeper' && s.legs[0]?.player === 'Connor McDavid');
    expect(sl && sl.legs.length === 2 && sl.result === 'win' && sl.source === 'import', `the pasted Sleeper slip came in as ${JSON.stringify(sl)?.slice(0, 160)}`);
    expect(await page.locator('#msImports .ms-imp', { hasText: 'Sleeper (copied text)' }).count() === 1, 'no import card for the pasted Sleeper text');
    // remove takes two taps and takes the import's slips with it
    const drop = card.locator('button', { hasText: 'REMOVE' });
    await drop.click();
    await settle(page, w, opts, 60);
    await page.locator('#msImports .ms-imp', { hasText: 'Underdog CSV' }).first().locator('button', { hasText: 'TAP AGAIN TO REMOVE' }).click();
    await settle(page, w, opts, 120);
    const gone = await ls(page, 'lr_slips');
    expect(!gone.some(s => s.id === 'ud-e2eU1'), 'removing the import should remove its slips');
  },

  async 'save a shopper view, load it, clear it'(page, w, opts) {
    await openTab(page, 'odds', w, opts);
    const best = page.locator('#oddsModes button', { hasText: 'BEST PRICES' });
    await best.first().click();
    await settle(page, w, opts, 250);
    await openPanel(page, w, opts, 'shpFilters');
    await page.locator('#shpPresetName').waitFor({ timeout: 6000 });
    // pick a sort, save the view as "E2E view"
    await page.locator('#shpBar select').filter({ has: page.locator('option[value="hold"]') }).selectOption('hold');
    await settle(page, w, opts, 250);
    await page.fill('#shpPresetName', 'E2E view');
    await page.getByRole('button', { name: 'SAVE VIEW' }).click();
    await settle(page, w, opts, 150);
    const views = await ls(page, 'lr_shopper_views');
    expect(views?.[0]?.name === 'E2E view' && views[0].opts.sort === 'hold', `saved views: ${JSON.stringify(views)?.slice(0, 200)}`);
    // change the sort, then load the view back
    await page.locator('#shpBar select').filter({ has: page.locator('option[value="hold"]') }).selectOption('start');
    await settle(page, w, opts, 250);
    const pickView = page.locator('#shpBar select').filter({ has: page.locator('option', { hasText: 'E2E view' }) });
    await pickView.selectOption({ label: 'E2E view' });
    await settle(page, w, opts, 300);
    const sort = await page.locator('#shpBar select').filter({ has: page.locator('option[value="hold"]') }).inputValue();
    expect(sort === 'hold', `loading the view left the sort on ${sort}`);
    await page.getByRole('button', { name: 'CLEAR VIEWS' }).click();
    await settle(page, w, opts, 150);
    expect(!(await ls(page, 'lr_shopper_views'))?.length, 'CLEAR VIEWS left views saved');
  },

  async 'share a saved view and open the link cold'(page, w, opts) {
    if (!opts.coldContext) return; // the live smoke reads only
    await openTab(page, 'odds', w, opts);
    await page.locator('#oddsModes button', { hasText: 'BEST PRICES' }).first().click();
    await settle(page, w, opts, 250);
    await openPanel(page, w, opts, 'shpFilters');
    await page.locator('#shpModes button', { hasText: 'All venues' }).click();
    await settle(page, w, opts, 250);
    await page.locator('#shpModes button', { hasText: /^Spread$/ }).click();
    await settle(page, w, opts, 250);
    await page.locator('#shpBar select').filter({ has: page.locator('option[value="hold"]') }).selectOption('ev');
    await settle(page, w, opts, 250);
    await page.fill('#shpPresetName', 'Share E2E');
    await page.getByRole('button', { name: 'SAVE VIEW' }).click();
    await settle(page, w, opts, 150);
    await page.getByRole('button', { name: 'SHARE VIEW' }).click();
    await settle(page, w, opts, 150);
    const toast = page.locator('.toast').last();
    expect(/^Link copied: view "Share E2E"/.test(await toast.innerText()), `SHARE VIEW toast: ${await toast.innerText()}`);
    const vw = page.viewportSize().width, box = await toast.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= vw, `the toast runs off a ${vw} px screen: ${JSON.stringify(box)}`);
    const viewLink = await page.evaluate(() => lrShareLast); // eslint-disable-line no-undef
    expect(/\/app#lr&t=odds&m=opps&st=all&mk=sp&n=Share\+E2E$/.test(viewLink) && viewLink.length < 200, `view link: ${viewLink}`);
    // the bar's LINK button: the same screen, without the view's name
    await page.locator('#linkBtn').click();
    await settle(page, w, opts, 100);
    const screenLink = await page.evaluate(() => lrShareLast); // eslint-disable-line no-undef
    expect(screenLink === viewLink.replace('&n=Share+E2E', ''), `LINK: ${screenLink}`);
    await page.getByRole('button', { name: 'CLEAR VIEWS' }).click();
    await settle(page, w, opts, 100);

    // a fresh device: no welcome screen or tour on top, the exact view, nothing of the sender's
    const local = new URL(opts.base).origin;
    const cold = (link, check) => openCold(opts, link, check);
    await cold(viewLink, st => {
      expect(st.page === 'page-odds', `opened on ${st.page}`);
      expect(st.shp.mode === 'opps' && st.shp.state === '' && st.shp.markets === 'spread' && st.shp.sort === 'ev', `shopper: ${JSON.stringify(st.shp).slice(0, 200)}`);
      expect(st.chips.includes('BEST PRICES ABOVE FAIR') && st.chips.includes('All venues') && st.chips.includes('Spread'), `chips: ${st.chips}`);
      expect(st.shp.stake === '100' && st.shp.fmt === 'american' && !st.shp.favOnly, 'the link changed the stake, odds format or favorites');
      expect(/Opened a shared view: Share E2E/.test(st.toast), `toast: ${st.toast}`);
    });
    // a GAME LINES link and another tab, written by hand as a person would paste them
    await cold(`${local}/app#lr&t=odds&lg=nba&mk=sp&so=ev`, st => {
      expect(st.page === 'page-odds' && st.shp.mode === 'lines', `opened ${st.page} ${st.shp.mode}`);
      expect(st.os.league === 'nba' && st.os.market === 'spread' && st.os.sort === 'ev' && st.osSort === 'ev', `game lines: ${JSON.stringify(st.os)}`);
      expect(st.chips.includes('GAME LINES'), `chips: ${st.chips}`);
    });
    await cold(`${local}/app#lr&t=results`, st => {
      expect(st.page === 'page-results', `opened on ${st.page}`);
      expect(/Opened a shared screen/.test(st.toast), `toast: ${st.toast}`);
    });
  },

  async 'share PROPS and ESPORTS views and open them cold'(page, w, opts) {
    if (!opts.coldContext) return; // the live smoke reads only
    // the LINK button on PROPS writes the view, app, sport and search
    await openTab(page, 'props', w, opts);
    await page.evaluate(() => pbSet('q', 'a')); // eslint-disable-line no-undef
    await settle(page, w, opts, 250);
    await page.locator('#linkBtn').click();
    await settle(page, w, opts, 100);
    const propsLink = await page.evaluate(() => lrShareLast); // eslint-disable-line no-undef
    const pv = await page.evaluate(() => pbState.view); // eslint-disable-line no-undef
    expect(/\/app#lr&t=props/.test(propsLink) && /[&]q=a(&|$)/.test(propsLink), `PROPS link: ${propsLink}`);
    expect(pv === 'lines' ? !/pv=/.test(propsLink) : propsLink.includes(`pv=${pv}`), `PROPS link misses the ${pv} view: ${propsLink}`);
    await page.evaluate(() => pbSet('q', '')); // eslint-disable-line no-undef
    await settle(page, w, opts, 200);
    const local = new URL(opts.base).origin;
    // Lines view on Underdog with a prop picked
    await openCold(opts, `${local}/app#lr&t=props&mk=Receptions&q=a`, st => {
      expect(st.page === 'page-props', `opened on ${st.page}`);
      expect(st.pb.view === 'lines' && st.pb.lineBook === 'underdog' && st.pb.market === 'Receptions' && st.pb.q === 'a', `props: ${JSON.stringify(st.pb).slice(0, 200)}`);
      expect(st.pbInputs[0] === 'a' && st.pbInputs[3] === 'Receptions', `PROPS boxes: ${st.pbInputs}`);
    });
    // the every-app view with a sport, sort and show picked
    await openCold(opts, `${local}/app#lr&t=props&pv=cards&sp=TENNIS&so=gap&sh=multi&q=a`, st => {
      expect(st.pb.view === 'cards' && st.pb.sport === 'TENNIS' && st.pb.sort === 'gap' && st.pb.show === 'multi', `props: ${JSON.stringify(st.pb).slice(0, 200)}`);
      expect(st.pbInputs[1] === 'gap' && st.pbInputs[2] === 'multi', `PROPS selects: ${st.pbInputs}`);
    });
    // ESPORTS: LINK on MATCHUPS, then matchups for one game and SOCCER cold
    await openTab(page, 'esports', w, opts);
    await page.locator('#esModeMatchups').click();
    await settle(page, w, opts, 250);
    await page.locator('#linkBtn').click();
    await settle(page, w, opts, 100);
    const esLink = await page.evaluate(() => lrShareLast); // eslint-disable-line no-undef
    expect(/\/app#lr&t=esports(&st=[a-z]+)?&em=matchups/.test(esLink), `ESPORTS link: ${esLink}`);
    await page.locator('#esModeMatches').click();
    await settle(page, w, opts, 150);
    await openCold(opts, `${local}/app#lr&t=esports&em=matchups&eg=CS2`, st => {
      expect(st.page === 'page-esports' && st.es.mode === 'matchups' && st.emu.game === 'CS2', `esports: ${JSON.stringify({ es: st.es, emu: st.emu })}`);
      expect(st.esChips.join() === 'MATCHUPS', `ESPORTS chips: ${st.esChips}`);
    });
    await openCold(opts, `${local}/app#lr&t=esports&em=matchups&eg=SOCCER`, st => {
      expect(st.emu.game === 'SOCCER' && st.socShown, `soccer: ${JSON.stringify(st.emu)} shown ${st.socShown}`);
    });
  },

  async 'star a venue and keep it after a reload'(page, w, opts) {
    await openTab(page, 'odds', w, opts);
    await page.locator('#oddsModes button', { hasText: 'BEST PRICES' }).first().click();
    await settle(page, w, opts, 250);
    await openPanel(page, w, opts, 'shpFilters');
    await openPanel(page, w, opts, 'shpVenues');
    const star = page.locator('#shpVenueGrid .shp-star').first();
    await star.waitFor({ timeout: 6000 });
    const was = await star.evaluate(e => e.classList.contains('on'));
    await star.click();
    await settle(page, w, opts, 250);
    const now = await page.locator('#shpVenueGrid .shp-star').first().evaluate(e => e.classList.contains('on'));
    expect(now !== was, 'the star did not change');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page, w, opts, 300);
    await openTab(page, 'odds', w, opts);
    await openPanel(page, w, opts, 'shpFilters');
    await openPanel(page, w, opts, 'shpVenues');
    await page.locator('#shpVenueGrid .shp-star').first().waitFor({ timeout: 6000 });
    const kept = await page.locator('#shpVenueGrid .shp-star').first().evaluate(e => e.classList.contains('on'));
    expect(kept === now, 'the starred venue was lost on reload');
    expect(await page.locator('#shpModes button', { hasText: 'Favorites' }).count() === (now ? 1 : 0), 'the Favorites chip should show only while something is starred');
  },

  async 'turn on push alerts (no push service here)'(page, w, opts) {
    await page.locator('.tab-row .tab-end').click();
    await page.locator('#layModal.open').waitFor({ timeout: 4000 });
    const btn = page.locator('#pushBtn');
    const label = (await btn.innerText()).trim();
    if (await btn.isDisabled()) {
      const note = await text(page, '#pwaNote');
      expect(/NOT AVAILABLE|BLOCKED/.test(label) && note.length > 10, `the push button is disabled and says "${label}" with no reason`);
    } else {
      expect(label === 'TURN ON', `the push button reads "${label}"`);
      await btn.click();
      // the browser has no push service in tests: the note must say what went wrong and the button come back
      for (let i = 0; i < 40 && (await btn.isDisabled()); i++) await settle(page, w, opts, 100);
      expect(!(await btn.isDisabled()), 'the push button stayed disabled');
      const note = await text(page, '#pwaNote');
      expect(note.length > 10, 'turning push on said nothing');
    }
    await page.keyboard.press('Escape');
    await settle(page, w, opts, 80);
    expect(!(await page.locator('#layModal.open').count()), 'Escape did not close CUSTOMIZE');
  },

  async 'move and hide a tab in CUSTOMIZE, then reset'(page, w, opts) {
    const order = () => page.locator('.tab-row > .tab').evaluateAll(b => b.map(x => x.textContent.trim()));
    const first = (await order())[0];
    await page.locator('.tab-row .tab-end').click();
    await page.locator('#layModal.open').waitFor({ timeout: 4000 });
    await page.locator('#layList .lay-row').first().locator('button', { hasText: 'DOWN' }).click();
    await settle(page, w, opts, 80);
    expect((await order())[0] !== first, `moving ${first} down did not change the bar`);
    await page.locator('#layList .lay-row').first().locator('button', { hasText: 'SHOWN' }).click();
    await settle(page, w, opts, 80);
    const hidden = await page.locator('#layList .lay-row').first().innerText();
    expect(/HIDDEN/.test(hidden), 'hiding a tab did not mark it HIDDEN');
    const reset = page.locator('#layModal button', { hasText: /RESET/ });
    await reset.first().click();
    await settle(page, w, opts, 120);
    await page.keyboard.press('Escape');
    expect((await order())[0] === first, 'RESET did not bring the order back');
  },

  async 'keyboard shortcuts and compact rows'(page, w, opts) {
    const active = () => page.locator('.tab.active').first().evaluate(b => (/showTab\('([^']+)'/.exec(b.getAttribute('onclick') || '') || [])[1] || '');
    const bar = await page.locator('.tab-row > .tab:not(.tab-end)').evaluateAll(bs => bs.map(b => (/showTab\('([^']+)'/.exec(b.getAttribute('onclick') || '') || [])[1]).filter(Boolean));
    await page.locator('body').click({ position: { x: 2, y: 2 } }).catch(() => {});
    await page.keyboard.press('Shift+Slash');
    await page.locator('#kbdModal.open').waitFor({ timeout: 4000 });
    expect(/Previous or next tab/.test(await text(page, '#kbdList')), 'the ? list is empty');
    await page.keyboard.press('2');
    await settle(page, w, opts, 60);
    expect(await active() !== bar[1] || bar.length < 2, 'a number key switched tabs under the ? list');
    await page.keyboard.press('Escape');
    await settle(page, w, opts, 60);
    expect(!(await page.locator('#kbdModal.open').count()), 'Escape did not close the ? list');
    if (bar.length >= 2) {
      await page.keyboard.press('2');
      await settle(page, w, opts, 120);
      expect(await active() === bar[1], `2 did not open ${bar[1]}`);
      await page.keyboard.press(']');
      await settle(page, w, opts, 120);
      expect(await active() !== bar[1], '] did not move to the next tab');
      await page.keyboard.press('[');
      await settle(page, w, opts, 120);
      expect(await active() === bar[1], '[ did not move back');
    }
    await openTab(page, 'odds', w, opts);
    const box = page.locator('#osSearch');
    if (await box.isVisible()) {
      await page.keyboard.press('/');
      expect(await box.evaluate(el => el === document.activeElement), '/ did not focus the search box');
      await page.keyboard.type('1c');
      await settle(page, w, opts, 80);
      expect(await active() === 'odds', 'typing in the search box switched tabs');
      expect(!(await page.locator('#layModal.open').count()), 'typing c in the search box opened CUSTOMIZE');
      await box.fill('');
      await box.evaluate(el => { el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); });
      await settle(page, w, opts, 80);
    }
    await page.keyboard.press('c');
    await page.locator('#layModal.open').waitFor({ timeout: 4000 });
    await page.locator('#layCompact').click();
    await settle(page, w, opts, 80);
    expect(await page.evaluate(() => document.body.classList.contains('compact')), 'Compact rows did not turn on');
    expect((await ls(page, 'lr_layout'))?.compact === true, 'Compact rows was not saved');
    await page.locator('#layCompact').click();
    await settle(page, w, opts, 80);
    expect(!(await page.evaluate(() => document.body.classList.contains('compact'))), 'Compact rows did not turn off');
    await page.keyboard.press('Escape');
    await settle(page, w, opts, 60);
  },

  async 'AFTER FEES: every price after the venue fee, with the FEES sources'(page, w, opts) {
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const shot = name => page.screenshot({ path: path.join(__dirname, 'out', `after-fees-${name}-${opts.viewportName}.png`), fullPage: false }).catch(() => {});
    fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
    await openTab(page, 'odds', w, opts);
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('body').click({ position: { x: 2, y: 2 } }).catch(() => {});
    await page.keyboard.press('c');
    await page.locator('#layModal.open').waitFor({ timeout: 4000 });
    expect((await text(page, '#layAfterFees')) === 'OFF', 'After fees should start OFF');
    await page.locator('#layAfterFees').click();
    await settle(page, w, opts, 250);
    expect((await text(page, '#layAfterFees')) === 'ON', 'After fees did not turn ON');
    expect((await page.evaluate(() => localStorage.getItem('lr_after_fees'))) === '1', 'After fees was not saved');
    await page.keyboard.press('Escape');
    await page.locator('#oddsModes button', { hasText: 'GAME LINES' }).first().click();
    await settle(page, w, opts, 300);
    // GAME LINES: venue cells read as the after-fee chance, an exchange cell carries its fee
    await page.locator('#osContent .af-v').first().waitFor({ timeout: 6000 });
    const os = await page.evaluate(() => ({ n: document.querySelectorAll('#osContent .af-v').length, subs: [...document.querySelectorAll('#osContent .af-sub')].map(e => e.textContent) }));
    expect(os.n > 0 && os.subs.every(t => /^(fee \d+(\.\d)?¢|no fee|fee unknown)$/.test(t)), `game lines after fees: ${JSON.stringify(os).slice(0, 300)}`);
    expect(await wide() <= 0, `ODDS SCREEN after fees is ${await wide()} px too wide`);
    await shot('lines');
    // FEES footnote: every schedule, its status and source
    const foot = page.locator('#afFoot details');
    await foot.waitFor({ timeout: 4000 });
    await foot.locator('summary').click();
    await settle(page, w, opts, 80);
    const ft = await text(page, '#afFoot');
    for (const want of ['Kalshi', 'VERIFIED', 'UNVERIFIED', 'Polymarket US', 'PrizePicks', 'oblin and demon', 'kalshi.com/docs/kalshi-fee-schedule.pdf', 'Sleeper'])
      expect(ft.includes(want), `FEES footnote misses "${want}"`);
    expect(await wide() <= 0, `FEES footnote is ${await wide()} px too wide`);
    await page.locator('#afFoot details').evaluate(el => el.scrollIntoView());
    await shot('fees');
    await foot.locator('summary').click();
    // BEST PRICES (Exchange Shopper): the after-fee chance on screen is the cost the shopper ranks on
    await page.locator('#oddsModes button', { hasText: 'BEST PRICES' }).first().click();
    await settle(page, w, opts, 300);
    const shp = await page.evaluate(() => {
      const d = window.shpUi?.data, out = { cells: 0, bad: [] };
      for (const m of d?.markets || []) for (const sd of m.sides) for (const c of sd.prices) {
        if (!(c.effective > 1)) continue;
        // eslint-disable-next-line no-undef
        const a = LRFees.afterFee({ venue: c.provider, decimal: c.effective });
        if (!a || a.implied == null) continue;
        out.cells++;
        if (Math.abs(a.implied - c.implied) > 2e-4) out.bad.push(`${c.provider} ${a.implied} vs ${c.implied}`);
      }
      out.shown = document.querySelectorAll('#shpContent .af-v').length;
      return out;
    });
    expect(!shp.bad.length, `shopper after-fee chance differs from the ranked cost: ${shp.bad.slice(0, 3).join('; ')}`);
    expect(shp.cells === 0 || shp.shown > 0, 'BEST PRICES shows no after-fee prices');
    expect(await wide() <= 0, `BEST PRICES after fees is ${await wide()} px too wide`);
    await shot('shopper');
    // PROPS: each app's line carries its own break-even
    await openTab(page, 'props', w, opts);
    await settle(page, w, opts, 400);
    const be = await page.locator('#page-props .af-be').count();
    if (await page.locator('#page-props .pb-bk, #page-props .ln-row').count()) expect(be > 0, 'PROPS lines show no break-even with After fees on');
    expect(await wide() <= 0, `PROPS after fees is ${await wide()} px too wide`);
    await shot('props');
    // off again: raw prices back
    await openTab(page, 'odds', w, opts);
    await page.locator('#oddsModes button', { hasText: 'GAME LINES' }).first().click().catch(() => {});
    await settle(page, w, opts, 200);
    await page.keyboard.press('c');
    await page.locator('#layModal.open').waitFor({ timeout: 4000 });
    await page.locator('#layAfterFees').click();
    await settle(page, w, opts, 200);
    await page.keyboard.press('Escape');
    await settle(page, w, opts, 200);
    expect(!(await page.locator('#osContent .af-v').count()), 'After fees off still shows after-fee prices');
    expect(!(await page.locator('#afFoot details').count()), 'After fees off still shows the FEES footnote');
    // leave the odds screen on the view the flows before this one left it on
    await page.locator('#oddsModes button', { hasText: 'BEST PRICES' }).first().click().catch(() => {});
    await settle(page, w, opts, 200);
    await page.evaluate(() => window.scrollTo(0, 0));
  },

  async 'EXPORT and PRINT a screen, and the glossary ? and long press'(page, w, opts) {
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const shot = name => page.screenshot({ path: path.join(__dirname, 'out', `export-${name}-${opts.viewportName}.png`), fullPage: false }).catch(() => {});
    const wait = async ms => { if (opts.clock) await page.clock.runFor(ms).catch(() => {}); else await page.waitForTimeout(ms); };
    fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
    const parse = csv => {
      const rows = [];
      let row = [], f = '', q = false;
      for (let i = 0; i < csv.length; i++) {
        const c = csv[i];
        if (q) { if (c === '"' && csv[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; continue; }
        if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += c;
      }
      if (f || row.length) { row.push(f); rows.push(row); }
      const [head, ...body] = rows;
      return { head, rows: body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))) };
    };
    const exportNow = async (pageId, name) => {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 6000 }), page.locator(`#page-${pageId} > .xp-bar button`, { hasText: 'EXPORT' }).click()]);
      expect(/^line-reaper-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/.test(dl.suggestedFilename()), `the export is named "${dl.suggestedFilename()}"`);
      const file = path.join(os.tmpdir(), `lr-e2e-xp-${process.pid}-${opts.viewportName}-${name}.csv`);
      await dl.saveAs(file);
      const csv = fs.readFileSync(file, 'utf8');
      fs.rmSync(file, { force: true });
      await settle(page, w, opts, 60);
      return { name: dl.suggestedFilename(), ...parse(csv) };
    };
    const tagged = sel => page.evaluate(s => [...document.querySelectorAll(`${s} [data-xp]`)].filter(e => e.getClientRects().length).length, sel);
    // GAME LINES: one row a venue price, exactly the cells on screen
    await openTab(page, 'odds', w, opts);
    await page.locator('#oddsModes button', { hasText: 'GAME LINES' }).first().click();
    await settle(page, w, opts, 300);
    await page.locator('#osContent [data-xp]').first().waitFor({ timeout: 6000 });
    let n = await tagged('#osContent');
    let x = await exportNow('odds', 'lines');
    for (const c of ['venue', 'price', 'after_fee_breakeven', 'fair', 'fair_source', 'close', 'fill_size_usd', 'read_at', 'filters', 'exported_at'])
      expect(x.head.includes(c), `the export has no ${c} column: ${x.head.join(',')}`);
    expect(x.rows.length === n, `GAME LINES shows ${n} prices, the file has ${x.rows.length}`);
    expect(x.rows.every(r => r.venue && r.price && r.screen === 'ODDS SCREEN' && r.view === 'GAME LINES'), `a row misses its venue or price: ${JSON.stringify(x.rows.find(r => !r.venue || !r.price))}`);
    expect(x.rows.some(r => /%$/.test(r.after_fee_breakeven)), 'no row carries a break-even after fees');
    expect(x.rows.some(r => r.read_at), 'no row carries when it was read');
    expect(x.rows.every(r => r.prices_shown === 'as listed'), 'AFTER FEES is off, so the prices are as listed');
    // a filter narrows the file the same way it narrows the screen
    await page.selectOption('#osMarket', 'ml');
    await settle(page, w, opts, 200);
    n = await tagged('#osContent');
    x = await exportNow('odds', 'lines-ml');
    expect(x.rows.length === n && n > 0, `moneyline only: ${n} on screen, ${x.rows.length} in the file`);
    expect(new Set(x.rows.map(r => r.market)).size === 1, `moneyline only, but the file holds ${[...new Set(x.rows.map(r => r.market))].join(', ')}`);
    expect(x.rows.every(r => /Moneyline/.test(r.filters)), `the filter is not written with the rows: "${x.rows[0]?.filters}"`);
    await page.selectOption('#osMarket', '');
    await settle(page, w, opts, 200);
    // BEST PRICES (Exchange Shopper): the ranked rows, venue and fill size where a book was read
    await page.locator('#oddsModes button', { hasText: 'BEST PRICES' }).first().click();
    await settle(page, w, opts, 400);
    n = await tagged('#shpContent');
    if (n) {
      x = await exportNow('odds', 'opps');
      expect(x.rows.length === n, `BEST PRICES shows ${n} rows, the file has ${x.rows.length}`);
      expect(x.rows.every(r => r.venue && r.decimal_odds), 'a ranked row misses its venue or odds');
    }
    // PROPS: each app's line on the board
    await openTab(page, 'props', w, opts);
    await settle(page, w, opts, 400);
    n = await tagged('#page-props');
    if (n) {
      x = await exportNow('props', 'props');
      expect(x.rows.length === n, `PROPS shows ${n} lines, the file has ${x.rows.length}`);
      expect(x.rows.some(r => /%$/.test(r.after_fee_breakeven)), "no prop carries its app's break-even");
    }
    // RESULTS: a screen with plain tables exports its columns
    await openTab(page, 'results', w, opts);
    await settle(page, w, opts, 300);
    const tables = await page.evaluate(() => [...document.querySelectorAll('#page-results table')].filter(t => t.getClientRects().length).length);
    if (tables) {
      x = await exportNow('results', 'results');
      expect(x.rows.length > 0 && x.head.includes('screen') && x.head.includes('loaded_at'), `RESULTS export: ${x.head.join(',')}`);
    }
    // PRINT: a light view with no nav and no controls, the screen and filters at the top
    await openTab(page, 'odds', w, opts);
    await page.locator('#oddsModes button', { hasText: 'GAME LINES' }).first().click();
    await settle(page, w, opts, 300);
    await page.locator('#page-odds > .xp-bar button', { hasText: 'PRINT' }).click();
    await settle(page, w, opts, 150);
    const pv = await page.evaluate(() => ({
      head: document.getElementById('xpHead')?.innerText || '', nav: getComputedStyle(document.querySelector('.nav')).display, bg: getComputedStyle(document.body).backgroundColor,
      chips: [...document.querySelectorAll('#page-odds .sport-chip, #page-odds select')].filter(e => e.getClientRects().length).length,
      rows: [...document.querySelectorAll('#osContent [data-xp]')].filter(e => e.getClientRects().length).length,
      cell: getComputedStyle(document.querySelector('#osContent td') || document.body).color,
    }));
    expect(/LINE REAPER · ODDS SCREEN · GAME LINES/.test(pv.head) && /Printed/.test(pv.head), `the print view header reads "${pv.head.slice(0, 160)}"`);
    expect(pv.nav === 'none' && pv.chips === 0, `the print view still shows the nav (${pv.nav}) or ${pv.chips} controls`);
    expect(pv.bg === 'rgb(255, 255, 255)' && pv.cell === 'rgb(17, 17, 17)', `the print view is not light: body ${pv.bg}, text ${pv.cell}`);
    expect(pv.rows > 0, 'the print view shows no prices');
    expect(await wide() <= 0, `the print view is ${await wide()} px too wide`);
    await shot('print-view');
    await page.emulateMedia({ media: 'print' });
    const pr = await page.evaluate(() => ({ btns: [...document.querySelectorAll('#xpHead button')].filter(e => e.getClientRects().length).length, bar: [...document.querySelectorAll('.xp-bar')].filter(e => e.getClientRects().length).length }));
    expect(pr.btns === 0 && pr.bar === 0, `printed, the page still shows ${pr.btns} print buttons and ${pr.bar} export bars`);
    await page.emulateMedia({ media: null });
    await page.locator('#xpHead button', { hasText: 'PRINT / SAVE AS PDF' }).click();
    await settle(page, w, opts, 120);
    expect(/Save as PDF/.test(await text(page, '#xpHeadSay')), 'PRINT / SAVE AS PDF did not say what it opens');
    await page.locator('#xpHead button', { hasText: 'CLOSE PRINT VIEW' }).click();
    await settle(page, w, opts, 120);
    expect(!(await page.locator('#xpHead').count()) && (await page.locator('.nav').isVisible()), 'CLOSE PRINT VIEW did not bring the app back');
    // GLOSSARY: the ? beside a label opens its definition, with a link to /learn
    const q = page.locator('#osContent .gl-q').first();
    await q.waitFor({ timeout: 6000 });
    await q.scrollIntoViewIfNeeded();
    await q.click();
    await settle(page, w, opts, 80);
    const pop = await page.evaluate(() => { const p = document.getElementById('glPop'); const r = p?.getBoundingClientRect(); return p && { shown: getComputedStyle(p).display !== 'none', text: p.innerText, href: p.querySelector('a')?.getAttribute('href'), left: r.left, right: r.right }; });
    expect(pop?.shown && pop.text.length > 40 && /^\/learn#g-[a-z0-9-]+$/.test(pop.href || ''), `the ? did not open a definition: ${JSON.stringify(pop)}`);
    expect(pop.left >= 0 && pop.right <= (await page.evaluate(() => innerWidth)), 'the definition sticks out of the screen');
    await shot('glossary-q');
    await page.locator('#glPop .gl-x').click();
    expect(!(await page.locator('#glPop').isVisible()), 'the definition did not close');
    // a long press on a chip opens its definition and does not switch the view
    const chip = page.locator('#oddsModes button', { hasText: 'MAKER' }).first();
    await chip.scrollIntoViewIfNeeded();
    const box = await chip.boundingBox();
    const before = await page.evaluate(() => window.shpUi?.opts?.mode);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await wait(700);
    await page.mouse.up();
    await settle(page, w, opts, 120);
    const lp = await page.evaluate(() => ({ shown: getComputedStyle(document.getElementById('glPop')).display !== 'none', text: document.getElementById('glPop').innerText, mode: window.shpUi?.opts?.mode }));
    expect(lp.shown && /Maker/i.test(lp.text), `a long press on MAKER did not open its definition: ${JSON.stringify(lp).slice(0, 200)}`);
    expect(lp.mode === before, `the long press also switched the view to ${lp.mode}`);
    await page.keyboard.press('Escape');
    // the GLOSSARY on /learn: every term at its anchor, on a phone too
    try {
      const res = await page.goto(`${opts.base}/learn#g-clv`, { waitUntil: 'domcontentloaded' });
      expect(res && res.status() === 200, `/learn answered ${res && res.status()}`);
      const g = await page.evaluate(() => ({ n: document.querySelectorAll('#glossary ~ dl .gl-i, dl.gloss .gl-i').length, clv: document.getElementById('g-clv')?.innerText || '', wide: document.documentElement.scrollWidth - innerWidth }));
      expect(g.n >= 40 && /closing line value/i.test(g.clv), `the glossary on /learn: ${JSON.stringify(g).slice(0, 200)}`);
      expect(g.wide <= 0, `the glossary is ${g.wide} px too wide`);
      await shot('learn-glossary');
    } finally {
      await page.goto(`${opts.base}/app`, { waitUntil: 'domcontentloaded' });
      await settle(page, w, opts, 300);
    }
  },

  async 'SHARE CARD: pick a row, see the card, copy a link that unfurls, save the image'(page, w, opts) {
    const shot = name => page.screenshot({ path: path.join(__dirname, 'out', `sharecard-${name}-${opts.viewportName}.png`), fullPage: false }).catch(() => {});
    fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const imgReady = () => page.waitForFunction(() => { const i = document.querySelector('#scPrev img'); return !i || (i.complete && i.naturalWidth > 0); }, null, { timeout: 15000 }).catch(() => {});
    await openTab(page, 'odds', w, opts);
    await page.locator('#oddsModes button', { hasText: 'BEST PRICES' }).first().click();
    await settle(page, w, opts, 300);
    await page.locator('#page-odds > .xp-bar button', { hasText: 'SHARE CARD' }).click();
    await settle(page, w, opts, 150);
    const kinds = await page.locator('#scSheet .sc-opt b').allInnerTexts();
    expect(kinds.includes('RESULTS'), `the record is always offered: ${kinds}`);
    expect(await wide() <= 0, 'the SHARE CARD sheet is wider than the screen');
    // a row's card when the screen has one, else the record
    const pick = kinds.indexOf('BEST PRICE') >= 0 ? kinds.indexOf('BEST PRICE') : kinds.indexOf('RESULTS');
    await page.locator('#scSheet .sc-opt').nth(pick).click();
    await imgReady();
    const img = await page.evaluate(() => { const i = document.querySelector('#scPrev img'); return i ? { w: i.naturalWidth, h: i.naturalHeight, src: i.getAttribute('src') } : null; });
    expect(img && img.w === 1200 && img.h === 630, `the card image did not load as 1200x630: ${JSON.stringify(img)}`);
    expect(!/stake|slip/i.test(img.src), `the card URL carries account data: ${img.src}`);
    await shot(kinds[pick] === 'BEST PRICE' ? 'price' : 'record');
    await page.locator('#scSheet button', { hasText: 'COPY LINK' }).click();
    await settle(page, w, opts, 100);
    const link = await page.evaluate(() => lrShareLast); // eslint-disable-line no-undef
    expect(kinds[pick] === 'BEST PRICE' ? /\/share\/price\?id=[^&]+&to=%23lr%26t%3Dodds/.test(link) : /\/share\/record$/.test(link), `share link: ${link}`);
    // the link is a page whose preview is the card, and a button back to this view
    const html = await (await page.request.get(link)).text();
    const og = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
    expect(og && /\/card\/(price|record)\.png\?/.test(og), `the share page has no card og:image: ${og}`);
    expect(/<meta name="twitter:card" content="summary_large_image">/.test(html), 'the share page has no Twitter card');
    expect(!/undefined|NaN|guaranteed|risk[- ]free/i.test(html), 'the share page shows broken text or a claim');
    const ogImg = await page.request.get(og.replace(/&amp;/g, '&').replace(/^https?:\/\/[^/]+/, new URL(opts.base).origin));
    expect(/image\/png/.test(ogImg.headers()['content-type'] || ''), `the preview image is ${ogImg.headers()['content-type']}`);
    // SAVE IMAGE downloads the record card as a PNG
    const rec = kinds.indexOf('RESULTS');
    await page.locator('#scSheet .sc-opt').nth(rec).click();
    await imgReady();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#scSheet a', { hasText: 'SAVE IMAGE' }).click()]);
    expect(/^line-reaper-record-[\d-]+\.png$/.test(dl.suggestedFilename()), `the saved image is named "${dl.suggestedFilename()}"`);
    await dl.cancel().catch(() => {});
    await shot('record');
    await page.locator('#scSheet button', { hasText: 'CLOSE' }).click();
    await settle(page, w, opts, 100);
    expect(!(await page.locator('#scSheet').count()), 'CLOSE left the sheet open');
  },

  async 'odds format and My state reach the league pages, share cards and widgets'(page, w, opts) {
    // eslint-disable-next-line no-undef
    const st0 = await page.evaluate(() => { const s = lrState; window.lrSetState('TX'); return s; });
    await settle(page, w, opts, 200);
    // the viewer's format, set where a viewer sets it: CUSTOMIZE > Odds format
    await page.evaluate(() => window.layOpen());
    await settle(page, w, opts, 120);
    await page.locator('#layOddsFmt').selectOption('decimal');
    await settle(page, w, opts, 120);
    await page.keyboard.press('Escape');
    await settle(page, w, opts, 80);
    try {
      // a share card from the odds screen carries the format, and a league card the state
      await openTab(page, 'odds', w, opts);
      await page.locator('#oddsModes button', { hasText: 'BEST PRICES' }).first().click();
      await settle(page, w, opts, 300);
      await page.locator('#page-odds > .xp-bar button', { hasText: 'SHARE CARD' }).click();
      await settle(page, w, opts, 150);
      // eslint-disable-next-line no-undef
      const opt = await page.evaluate(() => scOptions().map(o => ({ k: o.k, img: scImg(o), link: scLink(o) })));
      for (const o of opt.filter(x => x.k !== 'record')) expect(/[?&]odds=decimal(&|$)/.test(o.img), `a ${o.k} card does not carry the odds format: ${o.img}`);
      for (const o of opt.filter(x => x.k === 'league')) expect(/[?&]state=TX(&|$)/.test(o.img) && /[?&]state=TX(&|$)/.test(o.link), `a league card does not carry My state: ${o.link}`);
      await page.locator('#scSheet button', { hasText: 'CLOSE' }).click();
      await settle(page, w, opts, 80);
      const league = opt.find(x => x.k === 'league');
      if (league) {
        const html = await (await page.request.get(league.link.replace(/^https?:\/\/[^/]+/, new URL(opts.base).origin))).text();
        expect(/OPEN THE LEAGUE PAGE/.test(html) && /href="\/[a-z/0-9]+\?state=TX&amp;odds=decimal"/.test(html), 'the league share page does not open the league page in the same state and format');
      }
      // a league page in a format and a state: prices, the picker and its links keep both
      const lp = await page.context().newPage();
      try {
        await lp.goto(`${opts.base}/nfl?state=CA&odds=decimal`, { waitUntil: 'domcontentloaded' });
        expect(await lp.locator('#sto').inputValue() === 'decimal' && await lp.locator('#stp').inputValue() === 'CA', 'the league page picker does not show the picked format and state');
        const prices = await lp.locator('td[data-l="Price"], td[data-l="Fair"]').allInnerTexts();
        expect(prices.every(t => !/^[+-]\d{3,}/.test(t.trim())), `a league page price is still American: ${prices.slice(0, 4)}`);
        expect(await lp.locator('a[href="/nba?state=CA&odds=decimal"]').count() > 0, 'the league list does not keep the state and format');
        expect(await lp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'the league page is wider than the screen');
        await lp.locator('#sto').selectOption('fractional');
        await Promise.all([lp.waitForNavigation({ timeout: 8000 }), lp.locator('.st-pick button[type="submit"]').click()]);
        expect(/[?&]odds=fractional/.test(lp.url()) && /[?&]state=CA/.test(lp.url()), `SHOW did not keep the picks: ${lp.url()}`);
        // a widget in a format
        const wd = await (await page.request.get(`${opts.base}/embed/best-price?odds=decimal&n=3`)).text();
        expect(!/<em>FAIR<\/em>[+-]\d{3}/.test(wd), 'the best-price widget ignores data-odds');
      } finally { await lp.close(); }
    } finally {
      await page.evaluate(s => { window.oddsFmtSet('american'); window.lrSetState(s); }, st0);
      await settle(page, w, opts, 120);
    }
  },

  async 'every ODDS SCREEN mode and the new research views open with plain words'(page, w, opts) {
    // the crawl's time on a tab runs out in CUSTOMIZE and the bet form before it
    // reaches the later modes, so each one is opened here: it must show something,
    // no broken text, nothing wider than a phone, and an empty view in words
    const look = async (tab, what) => {
      await settle(page, w, opts, 250);
      const r = await page.evaluate(t => ({ text: (document.getElementById(`page-${t}`)?.innerText || '').trim(), bad: window.__e2e.textIssues(), wide: document.documentElement.scrollWidth - window.innerWidth,
        over: window.__e2e.overflow().map(o => `${o.what} ${o.where}`) }), tab);
      expect(r.text.length > 200, `${what}: the view is blank`);
      expect(!r.bad.length, `${what}: broken text ${String(JSON.stringify(r.bad[0])).slice(0, 160)}`);
      expect(r.wide <= 0, `${what}: the page is ${r.wide} px too wide`);
      if (opts.viewportName === 'phone') expect(!r.over.length, `${what}: sticks out at phone size: ${r.over[0]}`);
      expect(!/couldn't load|could not load/i.test(r.text) || /try again|retry|in a minute|refresh/i.test(r.text), `${what}: an error that does not say what to do`);
      return r.text;
    };
    await openTab(page, 'odds', w, opts);
    const mode0 = (await page.locator('#oddsModes button.active').first().innerText().catch(() => '')).trim();
    const modes = (await page.locator('#oddsModes button').allInnerTexts()).map(t => t.trim()).filter(Boolean);
    expect(modes.length >= 6, `the ODDS SCREEN has only ${modes.length} modes: ${modes}`);
    for (const m of modes) {
      await page.locator('#oddsModes button', { hasText: m }).first().click();
      await look('odds', `ODDS SCREEN > ${m}`);
      if (/OUTRIGHTS/i.test(m)) {
        for (const sub of ['RECORD', 'PRICES NOW', 'SEASON FUTURES']) {
          const b = page.locator('#ortModes button', { hasText: sub }).first();
          expect(await b.count(), `OUTRIGHTS has no ${sub} chip`);
          await b.click();
          await look('odds', `OUTRIGHTS > ${sub}`);
        }
        // back to every sport, as the later flows expect
        await page.locator('#ortModes button', { hasText: /^ALL$/ }).first().click();
        await settle(page, w, opts, 120);
      }
    }
    // leave the odds screen on the mode it was on, as the later flows expect
    if (mode0) { await page.locator('#oddsModes button', { hasText: mode0 }).first().click(); await settle(page, w, opts, 200); }
    await openTab(page, 'esports', w, opts);
    const es0 = await page.evaluate(() => document.querySelector('[id^="esMode"].active')?.id || '');
    await page.locator('#esModeMapUnders').click();
    await look('esports', 'ESPORTS > MAP UNDERS');
    if (es0) { await page.locator(`#${es0}`).click(); await settle(page, w, opts, 150); }
    await openTab(page, 'props', w, opts);
    await page.locator('#pbView button', { hasText: 'EXCHANGE PROPS' }).first().click();
    await look('props', 'PROPS > EXCHANGE PROPS');
    const rec = page.locator('#page-props button[onclick^="xprSet"]', { hasText: 'RECORD' }).first();
    if (await rec.count()) { await rec.click(); await look('props', 'PROPS > EXCHANGE PROPS > RECORD'); }
    await page.locator('#pbView button', { hasText: 'LINES' }).first().click();
    await settle(page, w, opts, 150);
    // a leg every sharp book lists carries its longest tag (live 10-26: "PIN 11.5 · FD 13.5 · BR 12.5 · KAL 12.5"
    // ran past the card at 375 px); the recording has none that long, so one row gets it
    const tagged = await page.evaluate(() => {
      const n = document.querySelector('#page-props .ln-row .ln-name');
      if (!n) return false;
      n.querySelector('.pb-anc')?.remove();
      n.insertAdjacentHTML('beforeend', '<span class="pb-anc">PIN 11.5 · FD 13.5 · BR 12.5 · KAL 12.5</span>');
      return true;
    });
    if (tagged) await look('props', 'PROPS > LINES with a four-book sharp tag');
    await page.evaluate(() => window.scrollTo(0, 0));
  },

  async 'TOOLS calculator works out a price'(page, w, opts) {
    await openTab(page, 'tools', w, opts);
    const inputs = page.locator('#page-tools input:visible');
    await inputs.first().waitFor({ timeout: 6000 });
    const before = await text(page, '#toolOut');
    await inputs.first().fill('+150');
    await inputs.first().dispatchEvent('input');
    await settle(page, w, opts, 120);
    const after = await text(page, '#toolOut');
    expect(after && after !== before, 'the calculator output did not change');
    expect(/40(\.0)?%/.test(after), `+150 should read 40% implied: "${after.slice(0, 200)}"`);
  },

  async 'first-run tour: every step, shows once, HELP and CUSTOMIZE reopen it'(page, w, opts) {
    const tourState = () => page.evaluate(() => ({ open: document.getElementById('tour').classList.contains('open'), step: document.getElementById('tourStep').textContent, title: document.getElementById('tourTitle').textContent }));
    // inside the window, no wider than the screen, and the ring on something the viewer can see
    const placed = () => page.evaluate(() => {
      const c = document.getElementById('tourCard').getBoundingClientRect(), r = document.getElementById('tourRing');
      const rr = r.getBoundingClientRect();
      return { card: c.left >= 0 && c.right <= innerWidth + 1 && c.top >= 0 && c.bottom <= innerHeight + 1, ring: !r.classList.contains('none') && rr.width > 4 && rr.height > 4, wide: document.documentElement.scrollWidth <= innerWidth + 1 };
    });
    await page.locator('#helpBtn').click();
    await settle(page, w, opts, 120);
    let st = await tourState();
    expect(st.open && st.step === '1 / 6' && st.title === 'ODDS SCREEN', `HELP did not open the tour at step 1: ${JSON.stringify(st)}`);
    expect(await page.evaluate(() => document.getElementById('page-odds').classList.contains('active')), 'step 1 did not land on ODDS SCREEN');
    const want = ['ODDS SCREEN', 'EXCHANGE SHOPPER', 'PROPS', 'BET TRACKER AND MY SLIPS', 'RESULTS', 'PUSH ALERTS'];
    for (let i = 0; i < want.length; i++) {
      st = await tourState();
      expect(st.title === want[i] && st.step === `${i + 1} / 6`, `step ${i + 1} reads ${JSON.stringify(st)}`);
      const pl = await placed();
      expect(pl.card && pl.ring && pl.wide, `step ${i + 1} (${want[i]}) is placed badly: ${JSON.stringify(pl)}`);
      const txt = await text(page, '#tourText');
      if (want[i] === 'EXCHANGE SHOPPER') expect(/MIN BET SIZE/.test(txt) && /not a proven edge/.test(txt), 'the shopper step must name MIN BET SIZE and say a price is not an edge');
      if (want[i] === 'PUSH ALERTS') expect(/CUSTOMIZE > Phone app > Push alerts/.test(txt), 'the push step must give the taps');
      if (i === 1) { await page.locator('#tourBack').click(); await settle(page, w, opts, 60); expect((await tourState()).title === want[0], 'BACK did not go back'); await page.locator('#tourNext').click(); await settle(page, w, opts, 60); }
      if (i < want.length - 1) { await page.locator('#tourNext').click(); await settle(page, w, opts, 120); }
    }
    expect((await page.locator('#tourNext').innerText()).trim() === 'DONE', 'the last step should say DONE');
    await page.locator('#tourNext').click();
    await settle(page, w, opts, 60);
    expect(!(await tourState()).open && (await page.evaluate(() => localStorage.getItem('lr_tour'))) === '1', 'DONE did not close the tour and remember it');
    // shows once: a reload on this device does not bring it back
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page, w, opts, 300);
    expect(!(await tourState()).open, 'the tour came back after a reload');
    // a new device (no lr_tour): it opens by itself, and Escape closes it for good
    await page.evaluate(() => localStorage.removeItem('lr_tour'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page, w, opts, 300);
    expect((await tourState()).open, 'a device that has not seen the tour did not get it');
    await page.keyboard.press('Escape');
    await settle(page, w, opts, 60);
    expect(!(await tourState()).open && (await page.evaluate(() => localStorage.getItem('lr_tour'))) === '1', 'Escape did not close the tour and remember it');
    // CUSTOMIZE > App tour > SHOW, and the last step's OPEN CUSTOMIZE lands on Push alerts
    await page.locator('.tab-row .tab-end').click();
    await page.locator('#layModal.open').waitFor({ timeout: 4000 });
    await page.locator('#layTour').click();
    await settle(page, w, opts, 120);
    expect((await tourState()).open && !(await page.locator('#layModal.open').count()), 'CUSTOMIZE > App tour did not open the tour');
    for (let i = 0; i < 5; i++) { await page.locator('#tourNext').click(); await settle(page, w, opts, 80); }
    await page.locator('#tourAct').click();
    await settle(page, w, opts, 120);
    expect(!(await tourState()).open && (await page.locator('#layModal.open').count()) === 1, 'OPEN CUSTOMIZE did not open the panel');
    expect(await page.locator('#pushBtn').isVisible(), 'the Push alerts row is not in view in CUSTOMIZE');
    await page.keyboard.press('Escape');
    await settle(page, w, opts, 60);
  },

  async 'developers page and widgets: key, try it, fit the screen'(page, w, opts) {
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    const claimy = /guaranteed|risk[- ]free|sure thing|lock of|undefined|NaN/i;
    try {
      const res = await page.goto(`${opts.base}/developers`, { waitUntil: 'domcontentloaded' });
      expect(res && res.status() === 200, `/developers answered ${res && res.status()}`);
      expect(/Public API and widgets/.test(await text(page, 'h1')), 'the developers page heading is missing');
      expect(await fits(), 'the developers page scrolls sideways at this size');
      const body = await page.evaluate(() => document.body.innerText);
      expect(!claimy.test(body), 'the developers page shows a claim or broken text');
      expect(/GET \/api\/v1\/best-prices/.test(body) && /GET \/api\/v1\/record/.test(body), 'an endpoint is missing from the docs');
      expect(await page.locator('iframe[data-lr-id]').count() === 3, 'the three widget previews are missing');
      if (!opts.live) {
        // TRY IT before a key says to make one, rather than doing nothing
        const tryBtn = page.locator('[data-try]').first();
        if (await tryBtn.count()) {
          await tryBtn.click();
          expect(/Make a key first/.test(await text(page, '[data-try-msg]')), 'TRY IT without a key gave no answer');
        }
        // the Discord feed without a key says to make one, rather than doing nothing
        await page.locator('#fdCheck').click();
        expect(/Make a key first/.test(await text(page, '#fdOut')), 'CHECK FEED without a key gave no answer');
        await page.locator('#kname').fill('e2e site');
        await page.locator('#mk button[type=submit]').click();
        await page.locator('#keyText').waitFor({ timeout: 6000 });
        const key = (await text(page, '#keyText')).trim();
        expect(/^lr_[\w-]{20,}$/.test(key), `the new key reads "${key}"`);
        expect(await page.locator('#mine').isVisible(), 'the saved key panel did not show');
        if (await tryBtn.count()) {
          await tryBtn.click();
          await page.waitForFunction(() => /^\d{3} ·/.test(document.querySelector('[data-try-msg]').textContent), null, { timeout: 6000 });
          expect(/^200 ·/.test(await text(page, '[data-try-msg]')), `TRY IT answered "${await text(page, '[data-try-msg]')}"`);
        }
        // the Discord feed with the key: a wrong URL is refused on the page, a
        // right-looking one is checked with Discord (offline here, so it says so)
        await page.locator('#fdCheck').click();
        await page.waitForFunction(() => /No Discord feed on this key/.test(document.getElementById('fdOut').textContent), null, { timeout: 6000 });
        await page.locator('#fdUrl').fill('https://example.com/not-a-hook');
        await page.locator('#fd button[type=submit]').click();
        expect(/not a Discord webhook URL/.test(await text(page, '#fdOut')), `CONNECT with a wrong URL said "${await text(page, '#fdOut')}"`);
        await page.locator('#fdUrl').fill(`https://discord.com/api/webhooks/123456789012345678/${'e'.repeat(68)}`);
        await page.locator('#fd button[type=submit]').click();
        await page.waitForFunction(() => !/Checking the webhook/.test(document.getElementById('fdOut').textContent), null, { timeout: 15000 });
        expect(/Discord|Connected/.test(await text(page, '#fdOut')), `CONNECT said "${await text(page, '#fdOut')}"`);
        await page.locator('#fdOff').click();
        await page.waitForFunction(() => /Disconnected/.test(document.getElementById('fdOut').textContent), null, { timeout: 6000 });
        expect(await fits(), 'the developers page scrolls sideways after the feed steps');
        await page.locator('#mineUse').click();
        await page.waitForFunction(() => /Used \d+ of/.test(document.getElementById('mineInfo').textContent), null, { timeout: 6000 });
        await page.locator('#mineRevoke').click();
        await page.waitForFunction(() => /Revoked/.test(document.getElementById('mkOut').textContent), null, { timeout: 6000 });
        const r = await page.request.get(`${opts.base}/api/v1/leagues`, { headers: { 'X-API-Key': key } });
        expect(r.status() === 401, `a revoked key still answers ${r.status()}`);
        expect(await fits(), 'the developers page scrolls sideways after making a key');
      }
      for (const u of ['/embed/best-price?league=nfl&n=3', '/embed/line-move', '/embed/record']) {
        const wr = await page.goto(`${opts.base}${u}`, { waitUntil: 'domcontentloaded' });
        expect(wr && wr.status() === 200, `${u} answered ${wr && wr.status()}`);
        expect(await fits(), `${u} scrolls sideways at this size`);
        const t = await page.evaluate(() => document.body.innerText);
        expect(/LINE REAPER|FULL RECORD/.test(t), `${u} has no link back to the site`);
        expect(!claimy.test(t), `${u} shows a claim or broken text`);
        expect(!/[^ ]PROVEN|PROVEN/.test(t) || /graded|main lines|Proven here means|RESULTS/i.test(t), `${u} says PROVEN without the record behind it`);
      }
    } finally {
      await page.goto(`${opts.base}/app`, { waitUntil: 'domcontentloaded' });
      await settle(page, w, opts, 300);
    }
  },

  async 'sales page and Learn claim only what the record proves'(page, w, opts) {
    // TEST DATA, not a recording: one proven row shaped like /api/claims, so the
    // page is checked against known numbers. The live check reads the real API.
    const TEST_CLAIMS = {
      at: '2026-10-25T20:00:00Z', rule: { graded: 50, clvT: 2 }, building: 41, overall: { graded: 1234, beatPct: 66.6, clv: 1.4 },
      proven: [{ kind: 'ev', kindLabel: 'Main lines vs the sharp fair', book: 'betrivers', bookName: 'BetRivers', graded: 113, beatPct: 83, clv: 3.01, clv2min: 2.4, clv2minN: 90, wins: 48, losses: 48, units: -0.7, profitShown: false, texas: false, pickem: false, alerts: true }],
      texas: { name: 'Texas', note: 'No sportsbook is legal in Texas. Pick\'em apps and CFTC exchanges are.', proven: [],
        pickem: [{ key: 'prizepicks', name: 'PrizePicks', read: true }, { key: 'betr', name: 'Betr', read: false, why: 'needs a login to read its board' }],
        exchanges: [{ key: 'kalshi', name: 'Kalshi', read: true }, { key: 'polymarketus', name: 'Polymarket US', read: true }, { key: 'gemini', name: 'Gemini', read: true }] },
      labels: [{ tool: 'NFL model', where: 'ODDS SCREEN > NFL MODEL', tag: 'model, not an edge', why: 'test' }],
    };
    let real = null;
    if (opts.live) real = await (await page.request.get(`${opts.base}/api/claims`)).json();
    else await page.route('**/api/claims', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEST_CLAIMS) }));
    const d = real || TEST_CLAIMS;
    try {
      await page.goto(`${opts.base}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#trackTable tbody tr').first().waitFor({ timeout: 6000 });
      await page.waitForFunction(() => !/Loading/.test(document.querySelector('#trackTable tbody').textContent), null, { timeout: 6000 });
      const got = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('#trackTable tbody tr')].map(r => r.innerText.replace(/\s+/g, ' ')),
        hero: document.getElementById('heroProven').textContent, tx: document.getElementById('heroTexas').textContent, claim: document.getElementById('heroClaim').innerText,
        pickem: document.getElementById('txPickem').innerText, exch: document.getElementById('txExch').innerText, labels: document.getElementById('labelTable').innerText,
        pm: [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /\/\/(www\.)?polymarket\.com/i.test(h)),
        wide: document.documentElement.scrollWidth <= innerWidth + 1,
        body: document.body.innerText,
      }));
      expect(got.hero === String(d.proven.length) && got.tx === String(d.texas.proven.length), `hero counts ${got.hero}/${got.tx}, API ${d.proven.length}/${d.texas.proven.length}`);
      if (d.proven.length) {
        expect(got.rows.length === d.proven.length, `${got.rows.length} record rows for ${d.proven.length} proven`);
        d.proven.forEach((p, i) => {
          expect(got.rows[i].includes(p.bookName) && got.rows[i].includes(String(p.graded)), `row ${i + 1} "${got.rows[i]}" is not ${p.bookName} at ${p.graded} graded`);
          expect(got.rows[i].toLowerCase().includes(p.texas ? 'texas: yes' : 'not a texas venue'), `row ${i + 1} must say whether Texans can bet it`);
          if (!p.profitShown) expect(/not shown yet/i.test(got.rows[i]), `row ${i + 1} must say profit is not shown yet`);
        });
        if (!d.texas.proven.length) expect(/Nothing is proven yet at a venue a Texas resident can use/.test(got.claim), `the hero claim must say nothing is proven for Texas: "${got.claim}"`);
      } else expect(/Nothing is proven yet/.test(got.rows[0] || ''), 'with nothing proven the table must say so');
      for (const v of d.texas.pickem) expect(got.pickem.includes(v.name), `Texas pick'em list misses ${v.name}`);
      for (const v of d.texas.exchanges) expect(got.exch.includes(v.name), `Texas exchange list misses ${v.name}`);
      for (const l of d.labels) expect(got.labels.includes(l.tool) && got.labels.toLowerCase().includes(l.tag.toLowerCase()), `the label table misses ${l.tool}`);
      expect(!got.pm.length, `links to polymarket.com: ${got.pm.join(', ')}`);
      expect(got.wide, 'the sales page scrolls sideways at this size');
      expect(!/locked profit|guaranteed|risk[- ]free|sure thing|two-minute test/i.test(got.body), 'the sales page makes a claim the record does not back');
      // Learn's record page reads the same list
      await page.goto(`${opts.base}/learn/how-the-record-works`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => /Proven:|Nothing is proven yet/.test(document.getElementById('lrClaimsBody').textContent), null, { timeout: 6000 });
      const learn = await page.evaluate(() => ({ body: document.getElementById('lrClaimsBody').innerText, tx: document.getElementById('lrClaimsTx').innerText, wide: document.documentElement.scrollWidth <= innerWidth + 1 }));
      for (const p of d.proven) expect(learn.body.includes(p.bookName) && learn.body.includes(`${p.graded} graded`), `Learn misses ${p.bookName}: "${learn.body}"`);
      expect(/Texas/.test(learn.tx) && learn.wide, 'Learn must say what Texas can place and fit the screen');
    } finally {
      if (!opts.live) await page.unroute('**/api/claims').catch(() => {});
      await page.goto(`${opts.base}/app`, { waitUntil: 'domcontentloaded' });
      await settle(page, w, opts, 300);
    }
  },
};

async function run(context, opts, rep) {
  // a viewer who allows notifications: the push flow then reaches the browser's push service, which tests do not have
  await context.grantPermissions(['notifications'], { origin: opts.base }).catch(() => {});
  const page = await newAppPage(context, opts);
  page.setDefaultTimeout(6000);
  const w = watch(page, rep, { ...opts, keepDownloads: true });
  opts = { ...opts, now: opts.clock ? Date.parse(opts.clock) : Date.now() };
  await enterApp(page, w, opts, rep);
  for (const [name, fn] of Object.entries(FLOWS)) {
    if (opts.live && /log|paste|import|save|star|push|move/.test(name)) continue; // the live smoke only reads
    if (process.env.E2E_FLOW_ONLY && !new RegExp(process.env.E2E_FLOW_ONLY, 'i').test(name)) continue; // one flow while working on it
    w.tab = `flow: ${name}`; w.last = w.tab;
    // let the last flow's toast time out, as it would for a viewer
    if (opts.clock) await page.clock.runFor(8000).catch(() => {});
    const t0 = Date.now();
    try {
      await fn(page, w, opts);
      rep.flows[name] = { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      rep.flows[name] = { ok: false, ms: Date.now() - t0, error: String(e.message || e).split('\n')[0].slice(0, 300) };
      const shot = path.join(__dirname, 'out', `flow-${opts.viewportName}-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`);
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      await page.screenshot({ path: shot }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
    }
    await checkText(page, rep, w.tab).catch(() => {});
  }
  await page.close();
  void issue;
}

module.exports = { run, FLOWS, pikkitCsv };
