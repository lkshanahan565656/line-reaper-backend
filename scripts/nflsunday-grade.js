// NFL Sunday board grader (nflsunday.js), run by .github/workflows/nfl-sunday.yml
// after every recorder run, so the report fills in as games end.
// Reads every nflsun-<WEEK>-out-* branch's changes.jsonl, builds one leg per
// app and player stat, grades it from ESPN's box score once the game is final,
// and force-pushes nflsun-<WEEK>-report: report.json (per app and kind vs
// break-even), report.txt, legs.json.gz (every leg with its prices and result)
// and the ESPN boxes it graded from (espn/), so a later check can re-grade
// without asking ESPN again.
// Local use: node scripts/nflsunday-grade.js <dir with changes*.jsonl> [out dir]
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');
const SG = require('../sportgrade');
const NS = require('../nflsunday');

const WEEK = process.env.WEEK || require('./nflsunday-week')();
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const OUT = process.argv[3] || 'report';
const sh = c => execSync(c, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 }).toString();

let pick6Payouts = null;
function readLogs() {
  const recs = [];
  const add = txt => { for (const l of txt.split('\n')) { if (!l) continue; try { recs.push(JSON.parse(l)); } catch { /* a cut-off last line */ } } };
  if (process.argv[2]) {
    for (const f of fs.readdirSync(process.argv[2]).filter(f => /changes.*\.jsonl$/.test(f))) add(fs.readFileSync(path.join(process.argv[2], f), 'utf8'));
    return recs;
  }
  sh(`git fetch -q origin "+refs/heads/nflsun-${WEEK}-out-*:refs/remotes/origin/nflsun-${WEEK}-out-*" || true`);
  const refs = sh(`git for-each-ref --format='%(refname:short)' "refs/remotes/origin/nflsun-${WEEK}-out-*"`).split('\n').filter(Boolean);
  for (const r of refs) {
    try { add(sh(`git show ${r}:out/changes.jsonl`)); } catch (e) { console.log('no log on', r); }
    // Pick6's own payout table as the recorder read it (3-pick was 5.5x on 10-24, not 6x)
    try { const st = JSON.parse(sh(`git show ${r}:out/stats.json`)); if (st.p6Payouts && Object.keys(st.p6Payouts).length) pick6Payouts = st.p6Payouts; } catch { /* none */ }
  }
  console.log('read', refs.length, 'runs,', recs.length, 'log lines');
  return recs;
}

(async () => {
  const { series, meta } = NS.replay(readLogs());
  if (pick6Payouts) require('../sportprops').setPick6Payouts(pick6Payouts);
  const legs = NS.buildLegs(series, meta);
  fs.mkdirSync(path.join(OUT, 'espn'), { recursive: true });
  // ESPN's scoreboards for every date a leg starts on (US Eastern)
  const dates = [...new Set(legs.map(l => SG.ymd(Date.parse(l.start))))];
  const events = [];
  for (const d of dates) {
    try { events.push(...((await axios.get(`${ESPN}/scoreboard`, { params: { dates: d }, timeout: 20000 })).data?.events || [])); }
    catch (e) { console.log('scoreboard', d, e.message); }
  }
  fs.writeFileSync(path.join(OUT, 'espn', 'events.json'), JSON.stringify(events.map(e => ({ id: e.id, date: e.date, name: e.name, done: !!e.status?.type?.completed,
    teams: (e.competitions?.[0]?.competitors || []).map(c => ({ abbr: c.team?.abbreviation, name: c.team?.displayName, short: c.team?.shortDisplayName, loc: c.team?.location, score: c.score })) }))));
  const boxes = new Map();
  const box = async ev => {
    if (boxes.has(ev.id)) return boxes.get(ev.id);
    let b = null;
    try {
      const data = (await axios.get(`${ESPN}/summary`, { params: { event: ev.id }, timeout: 20000 })).data;
      fs.writeFileSync(path.join(OUT, 'espn', `NFL-${ev.id}.json.gz`), zlib.gzipSync(JSON.stringify({ boxscore: data?.boxscore })));
      b = SG.parseBox(data?.boxscore);
    } catch (e) { console.log('box', ev.id, e.message); }
    boxes.set(ev.id, b);
    return b;
  };
  const results = new Map(), why = {};
  const note = k => { why[k] = (why[k] || 0) + 1; };
  for (const leg of legs) {
    const id = `${leg.app}|${leg.key}`;
    if (!SG.canGrade({ sport: 'NFL', mkey: leg.mkey })) { note(`no grader: ${leg.mkey}`); results.set(id, { skip: true }); continue; }
    const ev = SG.findEvent(events, { startTime: leg.start, team: leg.team, matchTitle: leg.matchTitle });
    if (!ev) { note('no ESPN game'); results.set(id, { pending: true }); continue; }
    if (!ev.status?.type?.completed) { note('not final'); results.set(id, { pending: true }); continue; }
    const b = await box(ev);
    if (!b) { note('no box'); results.set(id, { pending: true }); continue; }
    const g = SG.gradeLeg({ sport: 'NFL', mkey: leg.mkey, player: leg.player, signalLine: leg.bet.v[0], signalSide: 'Over' }, b);
    // final, and the player isn't in the box: he didn't play, the apps void it
    if (!g) { note('void: not in box'); results.set(id, { void: true }); continue; }
    results.set(id, { result: g.result, eventId: ev.id });
  }
  const graded = legs.filter(l => !results.get(`${l.app}|${l.key}`)?.skip);
  const rep = NS.summarize(graded, results);
  rep.week = WEEK; rep.at = new Date().toISOString(); rep.why = why;
  rep.sources = Object.fromEntries(Object.entries(series).map(([s, m]) => [s, m.size]));
  rep.games = events.map(e => ({ id: e.id, name: e.name, date: e.date, done: !!e.status?.type?.completed }));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(rep, null, 1));
  fs.writeFileSync(path.join(OUT, 'report.txt'), `${NS.reportText(rep, { title: `NFL Sunday ${WEEK}` })}\n\nwhy not graded: ${JSON.stringify(why)}\nsources (keys seen): ${JSON.stringify(rep.sources)}\n`);
  fs.writeFileSync(path.join(OUT, 'legs.json.gz'), zlib.gzipSync(JSON.stringify(legs.map(l => ({ ...l, graded: results.get(`${l.app}|${l.key}`) || null })))));
  console.log(fs.readFileSync(path.join(OUT, 'report.txt'), 'utf8').slice(0, 4000));
  if (process.argv[2] || !process.env.GITHUB_REPOSITORY) return;
  const hdr = sh('git config --get http.https://github.com/.extraheader').trim();
  const d = `/tmp/nflsun-report`;
  sh(`rm -rf ${d} && mkdir -p ${d} && cp -r ${OUT}/. ${d}/`);
  const g = c => sh(`git -C ${d} ${c}`);
  g('init -q'); g('config user.name nfl-sunday'); g('config user.email nfl-sunday@users.noreply.github.com');
  g('add -A'); g(`commit -qm "nfl sunday ${WEEK} report ${rep.at}"`);
  sh(`git -C ${d} -c http.extraheader="${hdr}" push -fq https://github.com/${process.env.GITHUB_REPOSITORY}.git HEAD:refs/heads/nflsun-${WEEK}-report`);
  console.log('pushed report');
})().catch(e => { console.error(e); process.exit(1); });
