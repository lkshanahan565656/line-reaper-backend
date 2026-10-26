// The glossary (glossary.js): every label and badge the app prints, defined in
// one or two plain sentences, claiming nothing, and the GLOSSARY on /learn.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../glossary');
const L = require('../learn');
const R = require('../results');

// the e2e wording check (e2e/page-helpers.js provenClaims), run on each definition
const NEG = /(not|n't|no|never|un|until|before|nothing|none|isn't|aren't|wasn't|yet to be|whether|if|once|only|needs?|to be|ever|anything|until it is|count as|what counts as|read|reads|marks?|call|called|rule|kinds? of play|proven so far|stays?|still|can be|may be|could be)\s*[\w\s,'-]{0,24}$/i;
function claims(text) {
  const out = [], re = /proven|guaranteed|sure thing|lock of|risk[- ]free/ig;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (/^proven$/i.test(m[0]) && NEG.test(before)) continue;
    if (/^guaranteed$/i.test(m[0]) && /(not|no|never|don't|do not)\b[\w\s,'-]{0,30}$/i.test(before)) continue;
    if (/^risk[- ]free$/i.test(m[0]) && /(not|no|never|isn't|aren't)\b[\w\s,'-]{0,30}$/i.test(before)) continue;
    out.push(text.slice(Math.max(0, m.index - 40), m.index + 30));
  }
  return out;
}

test('each term has an id, a short plain definition and labels nobody else claims', () => {
  const ids = new Set(), labels = new Map();
  for (const t of G.TERMS) {
    assert.ok(/^[a-z0-9-]+$/.test(t.id) && !ids.has(t.id), `id ${t.id}`);
    ids.add(t.id);
    assert.ok(t.term && t.labels.length, t.id);
    const sentences = t.def.replace(/\b(e\.g|i\.e|vs)\./g, '').split(/[.!?](?:\s|$)/).filter(x => x.trim()).length;
    assert.ok(sentences >= 1 && sentences <= 2, `${t.id}: ${sentences} sentences`);
    assert.ok(t.def.length <= 330, `${t.id}: ${t.def.length} characters`);
    assert.deepEqual(claims(t.def), [], `${t.id}: wording`);
    assert.ok(!/\b(we|our users) (won|made|hit)\b|\bROI of\b|guaranteed profit|\+\d+u\b|Pikkit/i.test(t.def), `${t.id}: no result claims`);
    if (t.learn) assert.ok(L.PAGES[t.learn], `${t.id}: guide ${t.learn}`);
    for (const l of t.labels) {
      const k = G.norm(l);
      assert.ok(!labels.has(k), `label ${l} in ${t.id} and ${labels.get(k)}`);
      labels.set(k, t.id);
    }
  }
});

test('the labels the site uses all have a definition', () => {
  for (const l of ['CLV', 'FAIR', 'BEST PRICES ABOVE FAIR', 'BREAK-EVEN', 'MIN BET SIZE', 'PROVEN', 'MODEL, NOT AN EDGE', 'RESEARCH, NOT A BET',
    'INFORMATION, NOT AN EDGE', 'STALE', 'MAKER', 'FILLS', 'T-STAT', 'TOWARD 50', 'EV', 'EDGE', 'HOLD', 'ARBS', 'LEAD', 'TRUST', 'REF', 'COPY', 'TX',
    'AFTER FEES', 'PIN CLOSE', 'PINNACLE FAIR', 'KALSHI ASK', 'REST A BID AT', 'MOVED TOO', 'STILL AT OLD NUMBER', 'W-L', 'ROI', 'UNITS', 'DEVIG']) {
    assert.ok(G.lookup(l), l);
  }
  assert.equal(G.lookup('EV ↓').id, 'ev', 'sort arrows are not part of a label');
  assert.equal(G.lookup('Still at old number ▾').id, 'old-number');
  assert.equal(G.lookup('ARBS (12)').id, 'arb', 'counts are not part of a label');
  assert.equal(G.lookup('  min bet size  ').id, 'min-bet-size');
  assert.equal(G.lookup('Odds'), null);
  assert.equal(G.get('clv').term, 'CLV');
  assert.equal(G.BAR, R.PROVEN_N, "the glossary's bar is the record's");
});

test('/learn carries the whole glossary, each term at its own anchor', () => {
  const h = L.render('');
  assert.match(h, /<h2 id="glossary">Glossary<\/h2>/);
  assert.match(h, /href="#glossary"/);
  for (const t of G.TERMS) assert.ok(h.includes(`id="g-${t.id}"`), t.id);
  const body = h.split('<main>')[1].split('</main>')[0];
  const text = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  // the term "PROVEN (label)" heads its own definition; everything else passes the claim check
  assert.deepEqual(claims(text.replace(/PROVEN \(label\)/g, '')), []);
  assert.ok(!/NaN|undefined|>null</.test(h));
});
