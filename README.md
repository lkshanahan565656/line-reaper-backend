# Line Reaper backend

Line Reaper is an odds screen with a public record. It reads the exchanges
(Kalshi, Polymarket US, Gemini), the pick'em apps (PrizePicks, Underdog,
Sleeper, DK Pick6), the sportsbooks it can reach (FanDuel, BetRivers) and
Pinnacle. It prices every line against Pinnacle's no-vig fair and grades every
flag it makes against the close.

One Node process serves everything: the API, the single-page app at `/app`,
the server-drawn public pages (`/`, `/learn`, `/pricing`, `/developers`,
`/leagues`, `/r`, `/alerts`, `/lines`, `/status`) and the background jobs that
read the feeds and grade the record.

- Live: https://line-reaper-backend-production.up.railway.app/ (Railway, auto-deploys `main`)
- Deploy and settings walk-through: `DEPLOY.md` in the project files (Railway variables, Stripe, bots)

This file is for an engineer joining the project. It covers how the code is
laid out, where data lives, how CI and the post-deploy check work, and how a
release ships.

---

## 1. Rules the code keeps

These hold everywhere. Tests and the browser suite enforce most of them.

- **Only the record says "proven".** A kind of bet is proven when all of these hold:
  - 50 graded games of that one kind, at one venue we read directly ourselves;
  - closing-line value against Pinnacle's own close with a t-statistic of 2 or more;
  - results not running 1.5 sd short of what that close expected;
  - kinds are never pooled to reach the bar.

  `closeboard.js` decides this. `claims.js` turns it into the only numbers a
  public page may show. Every other tool is labelled a price, a model or
  research. The e2e suite fails if "PROVEN", "edge", "guaranteed" or
  "risk-free" shows where the record doesn't back it.
- **No fake data.** A view with nothing to show says so. It never fills in
  sample rows. A price is what a feed returned at its last read.
- **Nothing is personal.** Alerts, the feed and the bots send the same text to
  everyone. There is no per-user sizing and no auto-copy. The app never places
  a bet or holds money.
- **US users never go to polymarket.com.** Venue links (`venuelinks.js`) send
  them to Polymarket US. The e2e suite fails on any polymarket.com link.
- **Venue legality is per state.** `venuestates.js` holds the table, and
  `venues.js` answers "can a resident of X use venue Y". New devices default
  to Texas.
- **Secrets stay server-side.** Keys come from environment variables only, and
  nothing in `public/` holds a key.

## 2. Layout

```
server.js            wiring: Express app, every route, every scheduled job (about 11k lines)
*.js (top level)     one module per feature or data source, mostly pure functions + a small state object
public/              the app (index.html + app.js), sales page (landing.html), service worker, icons
test/                node:test unit tests, one file per module (npm test)
e2e/                 Playwright browser suite, offline harness and recorded API snapshot, live check
scripts/             backtests, model fits and fixture builders (run by hand, never by the server)
seeds/               model parameters and backtest outputs the server loads at boot
data/                local JSON stores when running without Postgres (git-ignored except seeds)
relay/               the DK Pick6 relay that runs on GitHub Actions (Pick6 only answers from there)
desktop/             launcher for the packaged desktop build (npm run build_desktop)
.github/workflows/   CI, results backup, Pick6 relay, desktop build
```

`server.js` is long because it holds every route and job. It is a split
candidate once the open PR queue drains. Modules don't import `server.js`.
They take what they need (`axios`, stores, other modules' state) as
arguments, which is what makes them testable without a server.

### Modules by area

The header comment in each file is the up-to-date description. This table is
the map.

| Area | Modules |
|---|---|
| **Pricing core** | `oddsengine.js` (fair, EV, fees, arbs), `oddsschema.js` (one quote shape), `oddsproviders.js` (feeds → quotes), `oddsfmt.js`, `fees.js` (every venue's cut), `calc.js` (calculators, pick'em payouts), `dist.js` |
| **Sharp references** | `pingames.js`, `pinprops.js`, `pinextra.js`, `pintotals.js`, `pingap.js` (Pinnacle), `kprops.js`, `kxextra.js` (Kalshi as a fair), `propclose.js` (last sharp number per prop), `anchor.js` |
| **Venues read** | `exchanges.js` (Kalshi, Polymarket), `pmus.js`, `pmusbooks.js` (Polymarket US), `geminibooks.js`, `freebooks.js` (FanDuel, BetRivers), `pickem.js` (PrizePicks, Sleeper), `pick6.js`, `sleepersched.js`, `feeds.js`, `xbooks.js` |
| **Screens** | `oddsscreen.js` (ODDS SCREEN), `shopper.js` + `depthbook.js` + `depthfill.js` (best prices above fair, fill at size), `propsboard.js` (PROPS), `ev.js` (+EV), `bestplays.js` (BEST PLAYS), `xarb.js` + `bookarbs.js` (ARBS), `bigmoney.js`, `bigmoves.js`, `movers.js`, `steam.js`, `sharp.js`, `whales.js`, `tail.js` + `tailstream.js` (SHARP TAIL), `gaslocks.js`, `promos.js`, `appshop.js`, `altlines.js`, `stalelines.js`, `injurynews.js`, `outrights.js`, `exprops.js`, `kmaker.js`, `leadlag.js`, `xvalue.js`, `offshoreref.js`, `search.js` |
| **Esports** | `esboard.js`, `esrecord.js`, `esmatchup.js` + `esmatchupdata.js` (MATCHUPS), `esbooks.js`, `esinplay.js`, `esmarket.js`, `esmatch.js`, `esmarkets.js`, `esgames.js`, `esgaps.js`, `esstale.js`, `escal.js`, `esslips.js`, `esbets.js`, `esmodels.js`, `h2hdata.js` + `h2hmodel.js`, `roundmodel.js`, `sharemodel.js`, `mapunders.js`, `context.js`, `ratings.js` |
| **Sports models** (labelled model, never an edge) | `nbamodel.js` + `nbadata.js`, `cfbmodel.js` + `cfbdata.js`, `cbbmodel.js` + `cbbdata.js`, `nflmodel.js` + `nflgl.js`, `soccermodel.js` + `soccergl.js`, `propcal.js`, `farlines.js`, `propstats.js`, `sportprops.js`, `mlbboard.js`, `nflsunday.js` |
| **The record** | `closeboard.js` (proven or not), `claims.js` (what public pages may say), `results.js` (RESULTS), `evtrack.js`, `tailtrack.js`, `sporttrack.js`, `sliptrack.js`, `bidtrack.js`, `middletrack.js`, `bookarbtrack.js`, `xsize.js`, `execcheck.js`, `staleexact.js`, `appscore.js`, `graders.js`, `sportgrade.js`, `extragrade.js`, `tracker.js`, `digest.js`, `alertlog.js` |
| **User features** | `bets.js` (MY BETS), `slips.js`, `slip.js`, `slipbuild.js`, `slipgrade.js`, `sliplog.js`, `slipstamp.js` (MY SLIPS), `linebets.js`, `pubrecord.js` (`/r/<handle>`), `leaderboard.js` (`/r`), `auth.js` (accounts, sync), `billing.js` (Stripe), `plans.js` (Free and Pro), `licences.js` |
| **Outbound** | `alerts.js`, `push.js` (Web Push), `webhook.js`, `outfeed.js` (Discord and Telegram feed), `discordbot.js`, `telegrambot.js`, `publicapi.js` (`/api/v1`), `embeds.js` (widgets, `/developers`), `sharecards.js` |
| **Public pages** | `landing.html` (sales page), `learn.js`, `glossary.js`, `leagues.js`, `linehist.js` (`/lines`), `legal.js`, `status.js`, `a11y.js` (skip link, focus ring on every server page) |
| **Platform** | `jsonstore.js` (file stores), `backup.js` (results snapshot), `ops.js` (`/api/ops`), `security.js` (headers, per-address write and sign-in limits, JSON errors, the `security` block in `/api/ops`), `livecheck.js`, `quota.js` (Odds API credits), `appbundle.js` (hashed, pre-compressed app script) |

### The app (`public/`)

- `index.html` holds the markup and CSS for every tab.
- `app.js` holds all of the app's script. It is served as `/assets/app.<hash>.js`, pre-compressed once at boot by `appbundle.js`, and cached for a year.
- No framework and no build step. Each tab has a `load…()` that fetches its API and a `render…()` that writes HTML from that state.
- Tabs and their order live in the static nav. CUSTOMIZE (`lay*` functions) lets a viewer hide, move and pin tabs, stored in `localStorage`.
- The state picker (`lrState`) and the state bar (`data-state-bar`) are shared by every tab.
- Live updates come over server-sent events: `/api/ev/stream` and `/api/esports/stream`.

## 3. Data and stores

Railway wipes the container disk on every deploy. Three layers keep the
record anyway:

1. **Postgres, when `DATABASE_URL` is set.** The trackers (`evtrack.createStoreFromEnv`) and accounts (`auth.js`) use a table each.
2. **JSON file stores otherwise** (`jsonstore.js`, files under `data/` or `DATA_DIR`). Writes are coalesced:
   - stores the system writes (record trackers) flush every 5 minutes on Railway;
   - stores a user writes (push subscriptions, API keys, published records, logged bets) flush within 2 seconds (`LR_USER_STORE_WRITE_MS`).

   `/api/ops` → `stores` shows writes, bytes and the busiest files.
3. **The results backup** (`backup.js`):
   - `GET /api/results/backup` returns every registered store as one encrypted snapshot.
   - The `results-backup` workflows fetch it on a schedule and on each push to `main`, and keep it as the only commit on the `results-data` branch.
   - Each boot reads it back before the trackers start, adding only records it doesn't have.
   - The export answers 503 until the restore finishes, so a half-booted container never overwrites a fuller snapshot.
   - `/api/status` → `resultsBackup.snapshotAt` shows when the last snapshot was taken. If it stops moving, fix that before merging anything else.

Model parameters and backtests that ship with the code live in `seeds/` and
are read at boot. Re-fit them with the matching script in `scripts/` and
commit the new seed.

## 4. Configuration

Every environment variable the server reads is listed, with a comment, in
`.env.example`. A test (`test/env-example.test.js`) fails if code reads a
variable that file doesn't name.

Everything is optional. With nothing set, the server boots, reads the free
feeds and keeps its record in files plus the backup.

The flags that change behaviour most:

| Variable | Effect |
|---|---|
| `DATABASE_URL` | Postgres for trackers and accounts instead of files |
| `PAYWALL` | `on` enforces Free/Pro (`plans.js`). Off (default): everyone gets Pro, and pages say "early access" |
| `AUTH_SECRET`, `STRIPE_*` | Accounts and billing. Dormant until set |
| `ODDS_API_KEY` | The paid Odds API. Off on live. LINES, LINE SHOP and CLV hide themselves without it |
| `ALERT_WEBHOOK_URL` | Where alerts go (ntfy, Slack, Discord, Telegram; comma list) |
| `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` | Discord slash commands. Dormant until all three are set |
| `TELEGRAM_BOT_TOKEN` (+ `TELEGRAM_CHAT_IDS` for the feed) | Telegram commands and feed |
| `RESULTS_BACKUP_KEY` | Pins the backup key. On Railway it derives from the project ids |
| Scraped or unofficial sources | Each sits behind its own flag that defaults to off |

## 5. Running it

```bash
npm ci
cp .env.example .env      # optional
npm start                 # http://localhost:3001/app (PORT to change)
npm run e2e:serve         # the offline harness on :3456, answered from the recorded snapshot
```

From a sandbox most live feeds refuse the connection, so the offline harness
is the practical way to see the app with data.

## 6. Checks

Run all of these before pushing. CI runs the same ones.

| Command | What it does | CI workflow |
|---|---|---|
| `npm test` | node:test unit tests (about 1,600, ~35 s) | `test.yml` |
| `npm run lint` | ESLint (server, tests, `public/app.js`) | `test.yml` |
| `npm run typecheck` | `tsc --checkJs` over the server modules | `test.yml` |
| `npm run e2e` | Playwright crawl of every tab and control on phone (375 px) and desktop, plus form flows, offline against `e2e/fixtures/snapshot.json.gz` (~2.5 min). Fails on console errors, 404s, sideways scroll at 375 px, visible `undefined`/`NaN`, claim wording, polymarket.com links | `e2e.yml` |
| `npm run a11y` | axe-core over 15 public pages and 24 app views; fails on a serious or critical finding not in `e2e/a11y-baseline.json` | `e2e.yml` |

`npm run check` runs lint, typecheck and tests together. `e2e/README.md`
covers the browser suite in detail, including how to re-record the snapshot
from GitHub Actions.

## 7. How a release ships

1. **Version.** Bump `version` in `package.json` (and the lockfile, with `npm version <x.y.z> --no-git-tag-version`). That is the only place the version lives. `/api/health` reports it.
2. **PR.** Open it against `main`. Its body lists what changed and why, and ends with an engineering report: scope, tests run, risk, what was left out.
3. **Merge.** Merge once `test` and `e2e` are green. Merge one PR at a time, so a regression can be traced to one change.
4. **Deploy.** Railway builds and deploys `main` on its own. Expect about 8 minutes of 502s while the new container swaps in and restores the backup.
5. **Live check.** Run `npm run live-check -- <version>`.
   - It pushes to the `diag-e2e-smoke` branch.
   - A workflow there waits until the site reports that version, then runs `e2e/smoke.js` in a real browser against live.
   - The result lands on `diag-e2e-smoke-out` and in `/api/ops` → `liveCheck`. It exits non-zero on a failure.
6. **If live doesn't follow.** If live stops tracking merges (`/api/health` version stuck), stop merging until it does. Railway's own logs and settings need the owner.

The sandbox can't reach the live site directly. To read live numbers, push a
small workflow to an orphan `diag-*` branch that curls `/api/health` and
`/api/ops`, then read its job log.

## 8. Operations

| Endpoint | Shows |
|---|---|
| `/api/health` | version, uptime, boot timeline |
| `/api/ops` | event-loop stalls, slow routes, GC, memory, store writes, job timings, faults (unhandled rejections), live check |
| `/api/ops/heap?s=30` | heap profile summary (one run at a time) |
| `/api/status` | feeds and backup state, for scripts |
| `/status` | the same for humans |
| `/api/uptime` | uptime history |

Background work runs through `schedule()` in `server.js`: node-cron wrapped by
`ops.job`, so every job's runs, duration and errors show in `/api/ops`.
PrizePicks is read one league per cycle and its `Retry-After` is honoured.

Long-running recorders that need a US IP or a venue that only answers from
GitHub Actions (DK Pick6, Kalshi in some cases) run as workflows and POST
back. Keep the number of those small: Actions runners saturate past about 11
concurrent recorders.
