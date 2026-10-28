// The app as the browser gets it: the page (public/index.html) and its script
// (public/app.js, served as /assets/app.<hash>.js). Tests that look for markup
// or script text read both, so a block can live in either file.
'use strict';
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const page = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');

module.exports = { page, script, both: `${page}\n${script}` };
