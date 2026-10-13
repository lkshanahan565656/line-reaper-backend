// Desktop launcher: runs the Line Reaper server on a free local port, keeps its
// records in a folder under the user's home directory, and opens the app in the browser.
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { exec } = require('child_process');

const dataDir = process.env.LR_DATA_DIR || path.join(os.homedir(), 'LineReaper', 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.LR_DATA_DIR = dataDir;
process.env.LR_DESKTOP = '1';

function freePort(preferred) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => resolve(p)); }); });
    s.listen(preferred, '127.0.0.1', () => s.close(() => resolve(preferred)));
  });
}

(async () => {
  const port = await freePort(Number(process.env.PORT) || 3001);
  process.env.PORT = String(port);
  require('../server');
  const url = `http://localhost:${port}/app`;
  console.log(`\nLine Reaper is running at ${url}\nRecords are kept in ${dataDir}\nLeave this window open while you use it; close it to stop.\n`);
  if (!process.env.LR_NO_BROWSER) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    setTimeout(() => exec(cmd, () => {}), 2500);
  }
})();
