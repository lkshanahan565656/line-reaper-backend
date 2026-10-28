// ─── LEARN: THE BETTING MATH BEHIND EVERY NUMBER IN THE APP ──────────────────
// Public pages at /learn and /learn/<slug>: no-vig fair prices, EV, CLV, hold
// and arbs, middles, Kelly, exchange fees, pick'em break-evens and how the
// record decides what is proven. The OddsJam-style education section.
//
// Every worked example is computed when the page renders, with the same
// functions the app uses (oddsengine.js, calc.js, results.js), so a page can
// never disagree with the screen. The numbers are examples of the math, not
// results: no page claims an edge. The record lives in the app's Results tab.
//
// Pure: render(slug) → HTML string or null.

const engine = require('./oddsengine');
const calc = require('./calc');
const results = require('./results');
const pmus = require('./pmus');
const glossary = require('./glossary');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const am = d => { const a = calc.decimalToAmerican(d); return a == null ? '—' : (a > 0 ? `+${Math.round(a)}` : `${Math.round(a)}`); };
const dec = a => calc.americanToDecimal(a);
const pct = (x, n = 1) => (x == null ? '—' : `${(x * 100).toFixed(n)}%`);
const spct = (x, n = 1) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(n)}%`);
const usd = (x, n = 2) => (x == null ? '—' : `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(n)}`);
const table = (head, rows) => `<div class="scroll"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const box = (title, html) => `<div class="ex"><div class="ex-h">${title}</div>${html}</div>`;
const tool = (label, href = '/app?start=tools') => `<a class="go" href="${href}">${esc(label)} →</a>`;

const METHOD_LABEL = { multiplicative: 'Multiplicative', additive: 'Additive', power: 'Power', shin: 'Shin' };

const PAGES = {
  'no-vig-fair-odds': {
    title: 'No-vig fair odds',
    lead: 'A book’s two prices add up to more than 100%. Taking that margin out gives the fair chance of each side, the number every EV figure is measured against.',
    body() {
      const fav = dec(-150), dog = dec(130);
      const book = 1 / fav + 1 / dog;
      const rows = engine.DEVIG_METHODS.map(m => { const p = engine.devig([fav, dog], m); return [METHOD_LABEL[m] || m, pct(p[0], 2), am(1 / p[0]), pct(p[1], 2), am(1 / p[1])]; });
      const even = engine.devig([dec(-110), dec(-110)], 'power');
      return `
<h2 id="vig">The margin is in the price</h2>
<p>At −110 on both sides of a coin flip, each side implies ${pct(1 / dec(-110), 2)}. Together that is ${pct(2 / dec(-110), 2)}: the extra ${pct(2 / dec(-110) - 1, 2)} is the book’s margin (the vig or hold). With it taken out, each side is ${pct(even[0], 0)}, or ${am(1 / even[0])}: that is the fair price.</p>
<h2 id="methods">Four ways to take it out</h2>
<p>On a favourite against an underdog the margin is not charged evenly, and the methods split it differently. Here is Pinnacle-style −150 / +130 (the two sides add to ${pct(book, 2)}):</p>
${table(['Method', 'Favourite', 'Fair', 'Underdog', 'Fair'], rows)}
<ul>
<li><b>Multiplicative</b> scales both chances down by the same share.</li>
<li><b>Additive</b> takes the same number of points off each side.</li>
<li><b>Power</b> raises each chance to the power that makes them add to 100%. It puts more of the margin on the longshot, which is how sharp books actually price (the favourite-longshot bias). It is the app’s default.</li>
<li><b>Shin</b> models a share of the money as insiders. On a two-way market it works out to the same split as additive; on three-way markets (soccer) it differs.</li>
</ul>
<p>The method changes a fair by a fraction of a point on most lines and by more on big favourites. The <b>DEVIG</b> picker in the ODDS SCREEN’s shopper modes switches every fair and EV on the page between the four.</p>
<h2 id="whose">Whose price is the fair?</h2>
<p>A fair is only as good as the market it comes from. Line Reaper uses Pinnacle, the sharpest book that publishes prices, with Matchbook blended in when it prices the same line. When neither prices a market, the shopper uses the median no-vig of four or more books and labels it as a consensus. Pinnacle and Matchbook are shown as reference columns, never as a place to bet.</p>
${tool('Open the odds screen', '/app?start=odds')}`;
    },
  },
  'expected-value': {
    title: 'Expected value (EV)',
    lead: 'EV is what a bet returns on average at the fair chance. A positive EV price pays more than the outcome is worth.',
    body() {
      const fair = engine.devig([dec(-110), dec(-110)], 'power')[0];
      const price = dec(110);
      const e = engine.ev(fair, price);
      const k = engine.kelly(fair, price, 0.25);
      return `
<h2 id="formula">The formula</h2>
<p>EV per dollar = fair chance × decimal odds − 1. A side that is fair at ${pct(fair, 0)} and priced +110 (decimal ${price.toFixed(2)}) has EV ${pct(fair, 0)} × ${price.toFixed(2)} − 1 = <b>${spct(e, 1)}</b>: ${usd(engine.evAmount(fair, price, 100))} on a $100 bet, on average.</p>
${box('Worked example', table(['', 'Value'], [['Fair chance (Pinnacle no-vig)', pct(fair, 1)], ['Price you can get', `+110 (${price.toFixed(2)})`], ['Chance that price implies', pct(1 / price, 2)], ['Edge in points', `${((fair - 1 / price) * 100).toFixed(2)} pts`], ['EV', spct(e, 2)], ['EV on $100', usd(engine.evAmount(fair, price, 100))], ['Quarter Kelly stake', pct(k, 2) + ' of bankroll']]))}
<h2 id="what-it-is-not">What EV is not</h2>
<p>EV is a price compared with a fair. It is only as right as the fair, and a positive number on one bet says nothing on its own: a +3% bet still loses close to half the time. Whether a kind of bet actually wins over time is what the record answers, and the app marks a kind of bet proven only after the test on the <a href="/learn/how-the-record-works">record page</a>.</p>
<p>Exchange prices on the odds screen already include the venue’s fee, so their EV is after fees. A price read second-hand (marked <sup>c</sup>) can be minutes old: check it in the app before you bet.</p>
${tool('Open the EV calculator')}`;
    },
  },
  'closing-line-value': {
    title: 'Closing line value (CLV)',
    lead: 'CLV compares the price you got with the fair price when the market closed. Beating the close over many bets is the most reliable sign that a way of betting has an edge.',
    body() {
      const c = calc.clv(2.0, 1.87, 1.95, 'power');
      return `
<h2 id="why">Why the close</h2>
<p>By the start of a game the market has taken in every bet and every piece of news, so the closing no-vig price is the best estimate of the true chance there is. A bet placed at a better price than the close was, by that estimate, a good price, whether it won or not. Results take thousands of bets to separate skill from luck; CLV shows it in tens.</p>
${box('Worked example', `<p>You bet +100 (decimal 2.00). At the close the side is −115 (1.87) and the other side is −105 (1.95).</p>${table(['', 'Value'], [['Fair chance at the close (no-vig)', pct(c.fairProb, 2)], ['Fair close price', am(c.fairDec)], ['Your price', '+100'], ['CLV', `<b>${spct(c.clv, 2)}</b>`]])}<p>Measured against the raw −115 instead of the no-vig close, the same bet would show ${spct(2.0 / 1.87 - 1, 2)}: always take the vig out of the close first.</p>`)}
<h2 id="record">How Line Reaper uses it</h2>
<p>Every flagged price is graded against Pinnacle’s no-vig close, and for exchanges also against the price two minutes after the flag, so a price that was gone before you could tap it does not count. MY BETS shows the CLV of each bet you log with a closing price.</p>
${tool('Open the CLV calculator')}`;
    },
  },
  'hold-and-arbitrage': {
    title: 'Hold and arbitrage',
    lead: 'Hold is the margin left at the best price on every side. When the best prices across venues add up to under 100%, the hold is negative: an arb that pays the same whoever wins.',
    body() {
      const a = engine.arb([dec(105), dec(102)], 100);
      const h = engine.arb([dec(-110), dec(-110)], 100);
      return `
<h2 id="hold">Hold</h2>
<p>−110 on both sides holds ${pct(h.hold, 2)}. Shopping each side at its best venue lowers the hold you pay; an odds screen’s main job is to find the lowest one. The odds screen shows the hold at the best price on every market, and its sort “Lowest hold” lists them.</p>
<h2 id="arb">An arb</h2>
${box('Worked example: +105 at one venue, +102 at another', `${table(['', 'Value'], [['Chances implied', `${pct(1 / dec(105), 2)} + ${pct(1 / dec(102), 2)} = ${pct(1 / dec(105) + 1 / dec(102), 2)}`], ['Hold', spct(a.hold, 2)], ['Stake side A (+105)', usd(a.stakes[0])], ['Stake side B (+102)', usd(a.stakes[1])], ['Returned whichever wins', usd(a.payout)], ['Locked profit', spct(a.profit, 2)]])}`)}
<h2 id="risks">What goes wrong</h2>
<ul>
<li>Prices move. Place the leg most likely to move or be limited first, and check the second before you place it.</li>
<li>A copied price can be stale. Line Reaper lists an arb only when every leg is read straight from the venue and fresh; a market with a copied leg says “arb on a copied price, check it”.</li>
<li>Exchanges charge fees and have finite size. The prices shown include the fee; the size at the price can be smaller than your stake.</li>
<li>Books limit accounts that arb. Exchanges do not.</li>
</ul>
${tool('Open the arb calculator')}`;
    },
  },
  middles: {
    title: 'Middles',
    lead: 'A middle is Over a low number at one venue and Under a higher one at another. If the result lands between them, both bets win.',
    body() {
      const m = calc.middle(dec(-110), dec(-110), 100, 0.06);
      return `
<h2 id="how">How it pays</h2>
${box('Worked example: Over 44.5 at −110 and Under 46.5 at −110, $100 total', `${table(['', 'Value'], [['Stake on each', `${usd(m.stakeA)} / ${usd(m.stakeB)}`], ['Result 45 or 46 (both win)', usd(m.hit)], ['Anything else (one wins)', usd(m.miss)], ['Break-even chance of landing in the middle', pct(m.breakeven, 2)], ['EV if the middle hits 6% of the time', `${usd(m.ev)} (${spct(m.evPct, 2)})`]])}`)}
<p>The bet is worth it only when the chance of landing in the window is above the break-even. That chance depends on the sport and the numbers: NFL final margins land on 3 and 7 far more often than on their neighbours, so a middle across those numbers is worth more than one the same width elsewhere. Middles in the app are tracked and graded like every other flag.</p>
${tool('Open the middle calculator')}`;
    },
  },
  'kelly-criterion': {
    title: 'Kelly staking',
    lead: 'Kelly sizes a bet by its edge: the bigger the edge and the shorter the odds, the more of the bankroll it is worth. Most bettors use a fraction of it.',
    body() {
      const p = 0.55, d = dec(-105);
      const full = engine.kelly(p, d, 1);
      const rows = [1, 0.5, 0.25].map(f => [f === 1 ? 'Full' : f === 0.5 ? 'Half' : 'Quarter', pct(full * f, 2), usd(1000 * full * f)]);
      return `
<h2 id="formula">The formula</h2>
<p>Stake share = (p × b − (1 − p)) / b, where b is the decimal odds minus 1 and p the fair chance. A side fair at 55% priced −105 (b = ${(d - 1).toFixed(3)}):</p>
${table(['Kelly', 'Share of bankroll', 'On $1,000'], rows)}
<p>Full Kelly assumes the fair chance is exactly right. It never is, and full Kelly on an overstated edge loses money fast, so a quarter is the common choice. A negative EV gets a stake of zero.</p>
<p>Line Reaper shows the same suggestion to everyone: it never sizes bets to a person’s own bankroll or copies bets for anyone.</p>
${tool('Open the Kelly calculator')}`;
    },
  },
  'exchange-fees': {
    title: 'Exchange fees and effective odds',
    lead: 'Kalshi, Polymarket US and Gemini sell contracts that pay $1. A price of 55¢ is a 55% chance before fees; the fee turns it into the odds you actually get.',
    body() {
      const px = 0.55;
      const kFee = calc.kalshiFee(px, 100);
      const kDec = engine.contractDecimal(px, { rate: 0.07, contracts: 100 });
      const pmFee = engine.contractFee(px, { rate: pmus.FEE_RATE, roundCents: false });
      const pmDec = engine.contractDecimal(px, { rate: pmus.FEE_RATE, roundCents: false });
      const comm = engine.afterCommission(2.1, 0.02);
      return `
<h2 id="contracts">Contracts</h2>
<p>A contract at ${Math.round(px * 100)}¢ pays $1 if it wins. Before fees that is decimal ${(1 / px).toFixed(3)} (${am(1 / px)}).</p>
${box('Worked example: 100 contracts at 55¢', table(['Venue fee', 'Fee', 'Cost per contract', 'Effective odds'], [
  ['Kalshi and Gemini: 7% × p × (1 − p), rounded up to the cent per order', usd(kFee), usd(px + kFee / 100, 4), `${kDec.toFixed(3)} (${am(kDec)})`],
  [`Polymarket US: each market’s fee coefficient (${(pmus.FEE_RATE * 100).toFixed(2)}% on every market read so far) × p × (1 − p), not rounded`, usd(pmFee * 100), usd(px + pmFee, 4), `${pmDec.toFixed(3)} (${am(pmDec)})`],
]))}
<p>The fee is largest at 50¢ and shrinks toward 0¢ and $1. Every exchange price on the odds screen already has its fee in, so it can be compared straight against a book’s.</p>
<h2 id="commission">Commission exchanges</h2>
<p>Matchbook-style exchanges take a share of net winnings instead: 2.10 with 2% commission pays like ${comm.toFixed(3)}. Line Reaper shows Matchbook as a sharp reference, not a place to bet.</p>
<h2 id="size">Size</h2>
<p>An exchange price is only good for the contracts resting at it. A big order walks up the book to worse prices. The app reads the order book for the size at the shown price where the venue publishes it.</p>
${tool('Open the exchange calculator')}`;
    },
  },
  'pickem-math': {
    title: 'Pick’em break-evens',
    lead: 'PrizePicks, Underdog, DK Pick6 and Betr pay a fixed multiple for a slip. The multiple sets the chance each pick must hit for the slip to break even.',
    body() {
      const rows = [];
      for (const type of ['prizepicks_power', 'prizepicks_flex', 'underdog_standard', 'underdog_flex', 'pick6']) {
        for (const n of Object.keys(calc.PICKEM[type].tables).map(Number)) {
          const s = calc.pickemSlip(type, n);
          if (!s || s.breakeven == null) continue;
          const pays = s.outcomes.map(o => `${o.hits}/${n}: ${o.pays}x`).join(', ');
          rows.push([esc(s.label), String(n), pays, pct(s.breakeven, 1), am(1 / s.breakeven)]);
        }
      }
      const s3 = calc.pickemSlip('prizepicks_power', 3, { p: 0.58 });
      return `
<h2 id="breakeven">The break-even per pick</h2>
<p>A 3-pick PrizePicks Power slip pays 6x: it needs all three, so each pick must hit ${pct(calc.pickemBreakeven(calc.PICKEM.prizepicks_power.tables[3], 3), 1)} of the time (the cube root of 1/6). At 58% per pick the slip’s EV is ${spct(s3.ev, 1)}. A pick has to beat its break-even by more than the app takes for any of this to matter.</p>
${table(['Slip', 'Picks', 'Pays', 'Break-even per pick', 'As odds'], rows)}
<p>These are the standard tables. Apps change them and some reprice slips with picks from the same game: the TOOLS calculator reads DK Pick6’s live table and lets you type the multiple the app shows.</p>
<h2 id="fair">Where the pick’s chance comes from</h2>
<p>The chance of a pick comes from a sharp price on the same player and line, with the vig taken out (see <a href="/learn/no-vig-fair-odds">no-vig fair odds</a>). Pinnacle prices few player props, and an app’s line can be at a different number from the book’s, so many picks have no defensible chance at all; the app says so instead of guessing.</p>
<p>How the app’s own flagged picks have done against their break-evens is in the Results tab, graded leg by leg.</p>
${tool('Open the pick’em calculator')}`;
    },
  },
  'how-the-record-works': {
    title: 'How the record works',
    lead: 'Every flag the app makes is logged before the game and graded after it. A kind of bet is only called proven when the record clears a fixed test.',
    body() {
      return `
<h2 id="grading">Grading</h2>
<ul>
<li>Every flag is saved with its price and time when it is made, before the result is known.</li>
<li>It is graded against Pinnacle’s no-vig closing price (CLV) and, once the game is over, the result (win, loss, push, profit at the price).</li>
<li>Exchange flags are also re-read two minutes later, so a price that had gone by then is graded at the price you could have got.</li>
<li>Losers stay in. Nothing is removed after the fact.</li>
</ul>
<h2 id="proven">The test for “proven”</h2>
<ul>
<li>At least <b>${results.PROVEN_N}</b> graded bets of one kind, at one venue read straight from that venue (a copied price never counts).</li>
<li>Average CLV above zero with a t-statistic of <b>2</b> or more, so the result is unlikely to be luck.</li>
<li>Results not far below what the CLV says they should be.</li>
<li>Kinds are never pooled to reach ${results.PROVEN_N}, and alternate lines, stale lines and pick’em props are judged on their own.</li>
</ul>
<p>Everything else is a <b>lead</b>: a price the math likes that the record has not yet backed. The app labels every ranked row LEAD or PROVEN, and the Results tab shows the count for each kind as it builds.</p>
<h2 id="today">Today</h2>
${LIVE_CLAIMS}
<h2 id="limits">What it does not mean</h2>
<p>Proven means a kind of bet has beaten the close over the sample so far. It does not promise future results, and a proven kind can stop working as venues adjust. Bet only what you can afford to lose.</p>
${tool('Open Results', '/app?start=results')}`;
    },
  },
};
// What the record proves today, read live from /api/claims (claims.js) when the
// page opens, so the cached page never states a stale record. Without script
// it says where to look instead of showing a number.
const LIVE_CLAIMS = `<div class="ex" id="lrClaims"><div class="ex-h">What the record proves today</div>
<p id="lrClaimsBody">The live record shows in the app's Results tab.</p>
<p class="note" id="lrClaimsTx">In Texas no sportsbook is legal: pick’em apps and CFTC exchanges (Kalshi, Polymarket US, Gemini) are.</p></div>
<script>
fetch('/api/claims').then(function (r) { return r.ok ? r.json() : Promise.reject(); }).then(function (d) {
  function e(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function p(x) { return (x > 0 ? '+' : '') + Number(x).toFixed(1) + '%'; }
  var pr = d.proven || [], tx = d.texas || {};
  var body = pr.length
    ? 'Proven: ' + pr.map(function (r) { return '<b>' + e(r.kindLabel) + ' at ' + e(r.bookName) + '</b> (' + r.graded + ' graded games, ' + p(r.clv) + ' CLV' + (r.profitShown ? '' : ', profit not shown yet') + (r.texas ? '' : ', not a Texas venue') + ')'; }).join('; ') + '. Everything else is a lead, a model or research.'
    : 'Nothing is proven yet. ' + (!d.building ? 'No kind of bet has a graded sample yet.' : d.building === 1 ? '1 kind of bet is still building its sample.' : d.building + ' kinds of bet are still building their samples.');
  document.getElementById('lrClaimsBody').innerHTML = body + ' <a href="/app?start=results">Full record</a>.';
  var names = function (l) { return (l || []).filter(function (v) { return v.read; }).map(function (v) { return e(v.name); }).join(', '); };
  document.getElementById('lrClaimsTx').innerHTML = e(tx.note || '') + ' We price ' + names(tx.pickem) + ' and ' + names(tx.exchanges) + '. '
    + ((tx.proven || []).length ? 'Proven at a Texas venue: ' + tx.proven.map(function (r) { return e(r.kindLabel) + ' at ' + e(r.bookName); }).join(', ') + '.' : 'Nothing is proven yet at a Texas venue.');
}).catch(function () {});
</script>`;
const ORDER = ['no-vig-fair-odds', 'expected-value', 'closing-line-value', 'hold-and-arbitrage', 'middles', 'kelly-criterion', 'exchange-fees', 'pickem-math', 'how-the-record-works'];
const ALIASES = { 'no-vig': 'no-vig-fair-odds', devig: 'no-vig-fair-odds', ev: 'expected-value', clv: 'closing-line-value', arbs: 'hold-and-arbitrage', arbitrage: 'hold-and-arbitrage', hold: 'hold-and-arbitrage',
  middle: 'middles', kelly: 'kelly-criterion', fees: 'exchange-fees', pickem: 'pickem-math', record: 'how-the-record-works' };

const LOGO = '<svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#10b981"/><path d="M8 24V8h3.4v13h6.6V24H8zm11-9.5h5V18h-5z" fill="#06110d"/><path d="M19 8h5v3.5h-5z" fill="#06110d" opacity=".55"/></svg>';
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2310b981'/%3E%3Cpath d='M8 24V8h3.4v13h6.6V24H8zm11-9.5h5V18h-5z' fill='%2306110d'/%3E%3C/svg%3E";
// the app's dark terminal palette
const CSS = `
:root { --bg:#080b10; --card:#111620; --border:#1e2738; --border2:#263044; --text:#e2e8f0; --text2:#94a3b8; --muted:#8391a7; --green:#10b981; --green2:#34d399; --mono:'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.65 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
a { color:var(--green2); text-underline-offset:2px; }
.top { border-bottom:1px solid var(--border); background:rgba(8,11,16,.92); position:sticky; top:0; z-index:5; }
.top-in, main, footer .in { max-width:780px; margin:0 auto; padding:0 16px; }
.top-in { display:flex; align-items:center; justify-content:space-between; height:56px; gap:12px; }
.brand { display:flex; align-items:center; gap:10px; color:var(--text); text-decoration:none; font-weight:700; letter-spacing:2.5px; font-size:13px; }
.brand b { font-weight:400; color:var(--text2); margin-left:4px; }
.back { font:600 12px var(--mono); letter-spacing:.06em; color:var(--text2); text-decoration:none; border:1px solid var(--border2); border-radius:6px; padding:6px 12px; white-space:nowrap; }
.back:hover { color:var(--text); border-color:var(--text2); }
main { padding-top:32px; padding-bottom:48px; }
.kicker { font:600 11px var(--mono); letter-spacing:.14em; text-transform:uppercase; color:var(--green2); margin:0 0 8px; }
h1 { font-size:32px; line-height:1.15; letter-spacing:-.5px; margin:0 0 12px; }
.lead { color:var(--text2); font-size:17px; margin:0 0 24px; }
h2 { font-size:19px; line-height:1.3; margin:32px 0 10px; scroll-margin-top:70px; }
p, ul { margin:0 0 14px; }
ul { padding-left:22px; }
li { margin:0 0 6px; }
.scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; margin:0 0 16px; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; vertical-align:top; padding:8px 10px; border-bottom:1px solid var(--border); }
td { font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:13px; }
td:first-child { font-family:inherit; font-size:14px; }
th { font:600 10px var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
.ex { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 16px 4px; margin:0 0 18px; }
.ex-h { font:600 10px var(--mono); letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin:0 0 8px; }
.go { display:inline-block; margin:8px 0 0; font:600 12px var(--mono); letter-spacing:.06em; color:var(--green2); text-decoration:none; border:1px solid rgba(52,211,153,.4); border-radius:6px; padding:8px 14px; }
.go:hover { border-color:var(--green2); }
ul.index { list-style:none; padding:0; border-top:1px solid var(--border); }
ul.index li { margin:0; border-bottom:1px solid var(--border); }
ul.index a { display:block; padding:14px 0; text-decoration:none; color:var(--text); }
ul.index a b { display:block; font-size:16px; }
ul.index a span { display:block; color:var(--text2); font-size:14px; }
.gloss { margin:0; border-top:1px solid var(--border); }
.gloss .gl-i { padding:12px 0; border-bottom:1px solid var(--border); scroll-margin-top:70px; }
.gloss .gl-i:target { background:rgba(16,185,129,.08); }
.gloss dt { font-weight:700; color:var(--text); }
.gloss dd { margin:4px 0 0; color:var(--text2); font-size:14px; }
.gloss .gl-also { font:500 10px var(--mono); letter-spacing:.06em; color:var(--muted); text-transform:uppercase; }
nav.pn { display:flex; justify-content:space-between; gap:12px; border-top:1px solid var(--border); margin-top:36px; padding-top:16px; font-size:14px; flex-wrap:wrap; }
.note { color:var(--muted); font-size:13px; }
footer { border-top:1px solid var(--border); padding:20px 0 28px; color:var(--muted); font-size:13px; }
footer nav { display:flex; flex-wrap:wrap; gap:6px 16px; margin:0 0 10px; }
footer a { color:var(--text2); text-decoration:none; }
footer a:hover { color:var(--text); text-decoration:underline; }
@media (max-width:600px) { h1 { font-size:26px; } main { padding-top:24px; } .lead { font-size:16px; } th, td { padding:7px 6px; } }
`;

function shell({ title, lead, kicker, body, canonical }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Line Reaper</title>
<meta name="description" content="${esc(lead)}">
<meta name="theme-color" content="#080b10">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="top-in"><a class="brand" href="/">${LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app">OPEN THE APP</a></div></header>
<main>
<p class="kicker">${esc(kicker)}</p>
<h1>${esc(title)}</h1>
<p class="lead">${esc(lead)}</p>
${body}
</main>
<footer><div class="in"><nav><a href="/learn">Learn</a>${ORDER.map(k => `<a href="/learn/${k}">${esc(PAGES[k].title)}</a>`).join('')}<a href="/terms">Terms</a><a href="/responsible-gambling">Responsible gambling</a></nav>
<div>Line Reaper is an information service, not a sportsbook. It does not take bets. Examples on these pages show the math; they are not results or advice. 21+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></div></footer>
</body>
</html>`;
}

function render(slug = '', { origin = '' } = {}) {
  const o = String(origin).replace(/[^\w.:/-]/g, '');
  if (!slug) {
    return shell({ title: 'The math behind sharp betting', kicker: 'Learn', canonical: o ? `${o}/learn` : null,
      lead: 'Short guides to every number Line Reaper shows: fair prices, EV, CLV, hold, arbs, middles, staking, exchange fees and pick’em break-evens. Each example is worked with the same code the app runs.',
      body: `<ul class="index">${ORDER.map(k => `<li><a href="/learn/${k}"><b>${esc(PAGES[k].title)}</b><span>${esc(PAGES[k].lead)}</span></a></li>`).join('')}<li><a href="#glossary"><b>Glossary</b><span>Every label and badge in the app, in one or two plain sentences.</span></a></li></ul>${LIVE_CLAIMS}${glossaryHtml()}` });
  }
  const key = ALIASES[slug] || slug;
  const page = PAGES[key];
  if (!page) return null;
  const i = ORDER.indexOf(key);
  const prev = ORDER[i - 1], next = ORDER[i + 1];
  const pn = `<nav class="pn"><span>${prev ? `<a href="/learn/${prev}">← ${esc(PAGES[prev].title)}</a>` : '<a href="/learn">← All guides</a>'}</span><span>${next ? `<a href="/learn/${next}">${esc(PAGES[next].title)} →</a>` : '<a href="/learn">All guides →</a>'}</span></nav>`;
  return shell({ title: page.title, lead: page.lead, kicker: 'Learn', canonical: o ? `${o}/learn/${key}` : null, body: page.body() + pn });
}

// GLOSSARY: every label and badge in the app (glossary.js), one or two plain
// sentences each, A to Z. The app's ? beside a label links to #g-<id> here.
function glossaryHtml() {
  const list = [...glossary.TERMS].sort((a, b) => a.term.replace(/^the /i, '').localeCompare(b.term.replace(/^the /i, ''), 'en', { sensitivity: 'base' }));
  const seen = list.map(t => t.labels.filter(l => !glossary.norm(t.term).startsWith(glossary.norm(l))).slice(0, 4));
  return `<h2 id="glossary">Glossary</h2>
<p class="note">Every label and badge in the app, in plain words. In the app, tap the <b>?</b> beside a label, or press and hold it on a phone, for the same definition.</p>
<dl class="gloss">${list.map((t, i) => `<div class="gl-i" id="g-${esc(t.id)}"><dt>${esc(t.term)}${seen[i].length ? ` <span class="gl-also">${seen[i].map(esc).join(' · ')}</span>` : ''}</dt><dd>${esc(t.def)}${t.learn && PAGES[t.learn] ? ` <a href="/learn/${t.learn}">${esc(PAGES[t.learn].title)} →</a>` : ''}</dd></div>`).join('')}</dl>`;
}

const canonicalOf = slug => (ALIASES[slug] ? ALIASES[slug] : PAGES[slug] ? slug : null);

module.exports = { PAGES, ORDER, ALIASES, render, canonicalOf, glossaryHtml, CSS, LOGO, FAVICON, esc };
