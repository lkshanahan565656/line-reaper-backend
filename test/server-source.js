// The server's own source as one text: server.js plus the route modules it
// mounts (routes/*.js). Tests that look for a route, a store or a cron in
// the source read this, so moving a section into routes/ keeps them honest.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'routes');
const files = [path.join(root, 'server.js'), ...(fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort().map(f => path.join(dir, f)) : [])];

module.exports = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
