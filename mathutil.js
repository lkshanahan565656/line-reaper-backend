// The small number helpers every module used to carry its own copy of:
// rounding to 1, 2 or 4 places, odds to probability, a lenient number read,
// and HTML escaping. One copy, one behaviour. The `OrNull` roundings give null
// for a missing or non-finite value; the plain ones are plain arithmetic.
// (calc.js, bets.js, slips.js, fees.js and glossary.js are also served to the
// browser and keep their own.)
'use strict';

const r1 = x => Math.round(x * 10) / 10;
const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 1e4) / 1e4;
const r1OrNull = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2OrNull = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4OrNull = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
// American odds -> implied probability (vig in)
const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
// a value read as a number: null for missing, empty or not a finite number
const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
// the same, and true/false are not numbers either
const numNoBool = v => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { r1, r2, r4, r1OrNull, r2OrNull, r4OrNull, toProb, num, numNoBool, escHtml };
