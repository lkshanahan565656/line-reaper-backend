// The app's odds formats (LROddsFmt in public/app.js, between
// LR_ODDSFMT_BEGIN and LR_ODDSFMT_END) for the pages the server draws: league
// pages, share cards and widgets. One copy of the arithmetic: this module
// reads the app's own block, so a page and the app never disagree.
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const block = src.match(/^\/\/ LR_ODDSFMT_BEGIN\n([\s\S]*?)^\/\/ LR_ODDSFMT_END$/m);
if (!block) throw new Error('oddsfmt: the LR_ODDSFMT block is missing from public/app.js');
const F = new Function(`${block[1]}\nreturn LROddsFmt;`)();

// a query value -> a format, American when it is missing or unknown
const fmtOf = v => (F.valid(String(v || '')) ? String(v) : 'american');
// American odds -> text in the format; American text stays as before ('+150')
const fromAm = (a, fmt = 'american') => (a == null || !Number.isFinite(Number(a)) ? '—' : F.fromAm(Math.round(Number(a)), fmtOf(fmt)));
const fromDec = (d, fmt = 'american') => F.fromDec(d, fmtOf(fmt));
// the formats a page offers, in the app's order and words
const OPTIONS = F.MAIN.map(v => [v, F.LABELS[v]]);

module.exports = { ...F, fmtOf, fromAm, fromDec, OPTIONS };
