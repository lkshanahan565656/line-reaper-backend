# Browser tests

`npm run e2e` opens the app in headless Chromium at phone (390 px) and desktop
(1280 px) size and clicks everything. Nothing reaches a live site: the server
runs offline (`harness.js`) and every `GET /api/...` is answered from a
recording of the live API (`fixtures/snapshot.json.gz`). The browser clock is
set to the recording's time, so start times and "in 3h" read as they did.

What it checks, and fails on:

- **Every tab and control** (`crawl.js`): each tab opened from the bar or the
  MORE menu, then every button, chip, toggle, sort header, select, checkbox,
  text box, link, modal and menu it can reach, depth first. A click must change
  the page, the URL, the scroll, a request, a dialog, a file picker or the
  control's own state; tapping the current choice again may do nothing.
- **Page health**: no console errors, no uncaught errors or rejections, no 5xx
  or 404 from our server, no visible `undefined`, `NaN`, `[object Object]`,
  `null` or `Infinity`, no same-site link that 404s, no link to polymarket.com.
- **Wording**: "PROVEN" shows only while `/api/results` (results.js) marks a
  play proven; "guaranteed" and "risk-free" claims are flagged.
- **Data**: the main views (`allow.json`, `mustHaveData`) must not show their
  empty state, since the recording has rows for them; a request the recording
  has no answer for fails as a fixture miss.
- **Form flows** (`flows.js`): log a bet by hand, edit and settle it, export and
  import the CSV, log a bet from the ODDS SCREEN, log a slip from PROPS, paste
  slips, import a Pikkit CSV, save and load a shopper view, star a venue and
  keep it after a reload, turn push alerts on (no push service in tests), move
  and hide a tab in CUSTOMIZE, and work out a price in TOOLS.

`allow.json` lists the few exceptions, each with its reason. The report is
written to `e2e/out/report.json`, with a screenshot for each failed flow.

Options: `E2E_TABS=odds,props`, `E2E_VIEWPORTS=desktop`, `E2E_FLOWS=1` (with
`E2E_TABS`), `E2E_HEADED=1`, `E2E_TRACE=1` (print every click),
`E2E_MS_PER_TAB`, `E2E_SHARDS`. `npm run e2e:serve` runs the offline server on
port 3456 to look at by hand.

## A new recording

The sandbox cannot reach the live site, so the recording is made on GitHub
Actions: push `e2e/` with a workflow that runs
`node e2e/record.js https://line-reaper-backend-production.up.railway.app out/snapshot.json.gz`
(the `diag-e2e-rec` branch does this and leaves the file on `diag-e2e-rec-out`).
It runs the same crawl on the live app and refuses every POST before it leaves
the browser (`live-safety.js`), so it writes nothing to the live record.

## The live check after a deploy

`npm run live-check -- 3.171.0` pushes a commit to the `diag-e2e-smoke`
branch. Its workflow waits for the site to show that version, runs
`smoke.js` (the same crawl, a few seconds a tab, read-only), stores
`smoke.json` on `diag-e2e-smoke-out`, and asks the site to read it
(`POST /api/ops/smoke`; the server fetches the file from GitHub itself, so the
caller cannot post a result). The command waits for the result, prints it, and
exits 0 on a pass. The last result is in `/api/ops` under `liveCheck`.
