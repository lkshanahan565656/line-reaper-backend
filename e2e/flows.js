// The forms, step by step, with what each step must leave behind: log a bet
// by hand and from the ODDS SCREEN, edit and settle it, export and import the
// CSV, log a slip from PROPS, paste slips, import a Pikkit CSV, save and load
// a shopper view, star a venue (and keep it after a reload), turn on push
// alerts without a real push service, use the TOOLS calculator, and move and
// hide a tab in CUSTOMIZE. The crawl clicks everything; these check results.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { watch, settle, openTab, enterApp, newAppPage, checkText, issue } = require('./crawl');

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
