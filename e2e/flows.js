// The forms, step by step, with what each step must leave behind: log a bet
// by hand and from the ODDS SCREEN, edit and settle it, export and import the
// CSV, log a slip from PROPS, paste slips, import a Pikkit CSV, save and load
// a shopper view, star a venue (and keep it after a reload), turn on push
// alerts without a real push service, use the TOOLS calculator, and move and
// hide a tab in CUSTOMIZE, the keyboard shortcuts and compact rows, and share a
// view by link and open it cold on a fresh device. The crawl clicks everything; these check results.
'use strict';
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
    // type the stake the way a viewer does, then tap LOG SLIP straight away
    await tray.locator('input[type=number]').first().click();
    await page.keyboard.type('10');
    await page.locator('#pkTray button', { hasText: 'LOG SLIP' }).click();
    await settle(page, w, opts, 250);
    const slips = await ls(page, 'lr_slips');
    expect(slips?.length === before + 1, `lr_slips went from ${before} to ${slips?.length}`);
    expect(slips[0].legs.length === 2 && slips[0].stake === 10, `the logged slip has ${slips[0].legs.length} legs, stake ${slips[0].stake}`);
    await openTab(page, 'myslips', w, opts);
    expect((await text(page, '#msList')).includes(slips[0].legs[0].player), 'MY SLIPS does not show the logged slip');
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
    expect(/\/app#lr&t=esports&em=matchups/.test(esLink), `ESPORTS link: ${esLink}`);
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
