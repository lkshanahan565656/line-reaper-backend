// Share cards (sharecards.js): each card wears the app's label, says only what
// RESULTS proves, cuts long names to fit, and draws to a real PNG with the
// bundled font. The meta tags and the share page's open link are checked too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const sc = require('../sharecards');

const O = 'https://linereaper.example';
// TEST DATA shaped like publicapi.bestPrices() rows, not a recording
const row = { id: 'g1|spread|3.5|away', event: 'Away Team @ Home Team', start: '2026-10-27T00:20:00Z', marketType: 'spread', marketName: 'Spread', selection: 'Away Team +3.5',
  venue: 'kalshi', venueName: 'Kalshi', price: { american: 105, decimalAfterFees: 2.02 }, fair: { prob: 0.4831, american: 107 }, evPct: 2.4,
  secondBest: { venueName: 'FanDuel', american: -102 }, fill: { status: 'read', fillsUsd: 1000 }, label: 'lead' };
const noTags = s => s.replace(/<[^>]+>/g, ' ');

test('a price card shows the venue, price, break-even after the fee, fair, fill and read time, labelled LEAD', () => {
  const svg = sc.priceCard(row, { at: '2026-10-26T14:00:00Z', origin: O });
  const t = noTags(svg);
  assert.match(t, /LEAD · RESEARCH/);
  assert.match(t, /PRICE · KALSHI/);
  assert.match(t, /\+105/);
  assert.match(t, /49\.5%/, 'break-even is 1 / the decimal after the fee');
  assert.match(t, /\+107/);
  assert.match(t, /fills \$1,000/);
  assert.match(t, /read 2026-10-26 14:00 UTC/);
  assert.match(t, /linereaper\.example/);
  assert.ok(!/PROVEN VENUE/.test(t), 'a lead row never says proven');
});

test('PROVEN appears on a price card only when the row is labelled proven, and says it is one price, not a result', () => {
  const t = noTags(sc.priceCard({ ...row, label: 'proven', venueName: 'BetRivers', fill: { status: 'not published' } }, { at: '2026-10-26T14:00:00Z' }));
  assert.match(t, /PROVEN VENUE/);
  assert.match(t, /one price, not a result/);
  assert.match(t, /limit not published/);
});

test('a price card with nothing to show says why, never an old or hidden price', () => {
  assert.match(noTags(sc.priceCard(null, { gone: true })), /no longer above the fair/);
  assert.match(noTags(sc.priceCard(row, { locked: true })), /for subscribers/);
  assert.ok(!/\+105/.test(noTags(sc.priceCard(row, { locked: true }))), 'no price while the paywall hides the fair');
  assert.match(noTags(sc.priceCard(row, { stale: true })), /feeds are behind/);
});

test('a move card is information, not an edge, and draws each venue and the fair', () => {
  const pts = [0, 1, 2].map(i => ({ t: new Date(Date.parse('2026-10-26T08:00:00Z') + i * 3600e3).toISOString(), point: null, fair: 0.55 + i * 0.01, prices: { pinnacle: -120 - i * 5, fanduel: -118 } }));
  const svg = sc.moveCard({ game: { event: 'Away @ Home', leagueLabel: 'NFL', start: '2026-10-27T00:20:00Z' }, series: [{ market: 'ml', side: 'Home', points: pts }], venueName: v => v.toUpperCase() });
  assert.match(noTags(svg), /INFORMATION, NOT AN EDGE/);
  assert.match(noTags(svg), /FANDUEL -118/);
  assert.match(noTags(svg), /FAIR 57\.0%/);
  assert.match(svg, /stroke-dasharray/);
  const noFair = sc.moveCard({ game: { event: 'Away @ Home' }, series: [{ market: 'ml', side: 'Home', points: pts }], withFair: false });
  assert.ok(!/FAIR \d/.test(noTags(noFair)), 'no fair while the paywall hides it');
  assert.match(noTags(sc.moveCard({ game: null })), /No game to chart/);
});

test('pickSeries finds the side by name, else by place, and falls back to the moneyline', () => {
  const series = [{ market: 'ml', side: 'Away', points: [] }, { market: 'ml', side: 'Home', points: [] }, { market: 'total', side: 'Over', points: [] }];
  assert.equal(sc.pickSeries(series, { market: 'ml', side: 'home' }).s.side, 'Home');
  assert.equal(sc.pickSeries(series, { market: 'ml', sideIndex: 1 }).s.side, 'Home');
  assert.equal(sc.pickSeries(series, { market: 'spread' }).market, 'ml');
  assert.equal(sc.pickSeries(series, { market: 'total' }).s.side, 'Over');
});

test('the record card shows only proven rows, and profit only where RESULTS shows it', () => {
  const card = { at: '2026-10-26T14:00:00Z', proven: [{ venueName: 'BetRivers', kindLabel: 'main lines', graded: 373, clvPct: 2.8, beatPct: 54, wins: 538, losses: 527, profitShown: false, units: null, texas: false }], notProven: 41, building: 20, losing: 12 };
  const t = noTags(sc.recordCardSvg(card));
  assert.match(t, /BetRivers · main lines/);
  assert.match(t, /NOT IN TEXAS/);
  assert.match(t, /not shown/);
  assert.match(t, /\+2\.8%/);
  assert.match(t, /41 other kinds not proven/);
  const none = noTags(sc.recordCardSvg({ ...card, proven: [] }));
  assert.match(none, /Nothing is proven yet/);
  assert.ok(!/>PROVEN</.test(sc.recordCardSvg({ ...card, proven: [] })));
  const shown = noTags(sc.recordCardSvg({ ...card, proven: [{ ...card.proven[0], profitShown: true, units: 12.34 }] }));
  assert.match(shown, /\+12\.3u/);
});

test('the league card labels every price research and says so when a league is empty', () => {
  const t = noTags(sc.leagueCard({ name: 'NFL', games: 3, markets: 9, withFair: 8, venues: 7, aboveFair: 1, rows: [row], at: '2026-10-26T14:00:00Z' }));
  assert.match(t, /RESEARCH/);
  assert.match(t, /8\/9/);
  assert.match(t, /LEAD/);
  assert.match(noTags(sc.leagueCard({ name: 'Dota 2', games: 0, esports: true })), /ESPORTS tab/);
});

test('the digest card shows the week and the pooled CLV as never a claim', () => {
  const d = { name: 'Oct 19 to 25', builtAt: '2026-10-26T13:00:00Z', partial: false, summary: { graded: 12, kinds: 3, proven: [], newlyProven: [], newlyFailed: ['Sharp Tail · FanDuel'], reached50: [], overall: { week: { clv: 0.4 } } } };
  const t = noTags(sc.digestCard(d, { frozen: true }));
  assert.match(t, /WEEK OF OCT 19 TO 25/);
  assert.match(t, /never a claim/);
  assert.match(t, /Sharp Tail · FanDuel/);
  assert.match(t, /PUBLISHED AND FROZEN/);
});

test('text is cut to fit and escaped', () => {
  assert.equal(sc.fit('abcdefghij', 10, 60), 'abcdefghij');
  assert.equal(sc.fit('abcdefghij', 10, 54), 'abcdefgh…');
  assert.equal(sc.fit('short', 10, 600), 'short');
  const svg = sc.priceCard({ ...row, selection: '<script>alert(1)</script>' + 'x'.repeat(200) }, {});
  assert.ok(!svg.includes('<script>'));
  assert.ok(sc.wrap('one two three four five six seven', 10, 90, 2).length <= 2);
});

test('cards draw to a 1200x630 PNG with the bundled font', async () => {
  for (const f of sc.FONT_FILES) assert.ok(fs.existsSync(f), `${f} is in the repo`);
  const png = await sc.renderPng(sc.priceCard(row, { at: '2026-10-26T14:00:00Z' }));
  assert.ok(png && png.length > 5000);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test('meta tags: Open Graph and Twitter card, and a page keeps its own title', () => {
  const tags = sc.metaTags({ title: 'T', description: 'D', image: `${O}/card/record.png`, url: `${O}/results` });
  for (const k of ['og:title', 'og:image', 'og:image:width', 'twitter:card', 'twitter:image']) assert.ok(tags.includes(`"${k}"`), k);
  assert.match(tags, /summary_large_image/);
  const page = '<!doctype html><html><head><title>Page</title><meta property="og:title" content="Own &amp; title">\n<meta property="og:image" content="/og.png">\n</head><body></body></html>';
  const out = sc.injectMeta(page, { title: 'x', description: 'y', image: `${O}/card/league.png?league=nfl` });
  assert.match(out, /og:title" content="Own &amp; title"/);
  assert.ok(!out.includes('content="/og.png"'), 'the logo image tag is replaced');
  assert.equal((out.match(/og:image"/g) || []).length, 1);
  assert.equal(sc.injectMeta('no head here', { image: 'x' }), 'no head here');
});

test('the share page opens only app views and league paths it knows', () => {
  assert.equal(sc.safeOpen('#lr&t=odds&m=shop'), '/app#lr&t=odds&m=shop');
  assert.equal(sc.safeOpen('?start=results'), '/app?start=results');
  assert.equal(sc.safeOpen('javascript:alert(1)'), '/app');
  assert.equal(sc.safeOpen('#lr&t="><script>'), '/app');
  assert.equal(sc.leagueOfPath('/esports/lol'), 'lol');
  assert.equal(sc.leagueOfPath('/nope'), null);
  const html = sc.sharePage({ title: 'T', description: 'D', image: `${O}/card/record.png`, url: `${O}/results`, open: '/app?start=results' });
  assert.match(html, /twitter:card/);
  assert.match(html, /href="\/app\?start=results"/);
  assert.ok(!/guaranteed|risk[- ]free/i.test(html));
});
