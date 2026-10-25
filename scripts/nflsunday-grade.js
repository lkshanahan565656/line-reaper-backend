// NFL Sunday board grader (nflsunday.js), run by .github/workflows/nfl-sunday.yml
// after every recorder run, so the report fills in as games end.
// Reads every nflsun-<WEEK>-out-* branch's changes.jsonl, builds one leg per
// app and player stat, grades it from ESPN's box score once the game is final,
// and force-pushes nflsun-<WEEK>-report: report.json (per app and kind vs
// break-even), report.txt, legs.json.gz (every leg with its prices and result)
// and the ESPN boxes it graded from (espn/), so a later check can re-grade
// without asking ESPN again.
// The esports board (LEAGUES=CS,LOL,VAL,DOTA,R6,COD) grades from the esports
// graders instead (graders.js: bo3.gg for CS2, lolesports then Leaguepedia
// for LoL, OpenDota for Dota 2, vlr.gg for Valorant; R6 and CoD have none),
// reusing the results an earlier run of this report already settled.
// Local use: node scripts/nflsunday-grade.js <dir with changes*.jsonl> [out dir]
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');
const SG = require('../sportgrade');
const NS = require('../nflsunday');
const ER = require('../esrecord');
const { canonName } = require('../ev');
const LEAGUES = String(process.env.LEAGUES || 'NFL').toUpperCase().split(/[\s,]+/).filter(Boolean);

const WEEK = process.env.WEEK || require('./nflsunday-week')();
const PREFIX = process.env.PREFIX || 'nflsun';
const ESPN = sport => `https://site.api.espn.com/apis/site/v2/sports/${SG.LEAGUES[sport] || SG.LEAGUES.NFL}`;
// college scoreboards list only the top games unless asked for every FBS
// (group 80) or Division I (group 50) game
const BOARD_PARAMS = { CFB: { groups: 80, limit: 400 }, CBB: { groups: 50, limit: 400 } };
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
  sh(`git fetch -q origin "+refs/heads/${PREFIX}-${WEEK}-out-*:refs/remotes/origin/${PREFIX}-${WEEK}-out-*" || true`);
  const refs = sh(`git for-each-ref --format='%(refname:short)' "refs/remotes/origin/${PREFIX}-${WEEK}-out-*"`).split('\n').filter(Boolean);
  for (const r of refs) {
    try { add(sh(`git show ${r}:out/changes.jsonl`)); } catch (e) { console.log('no log on', r); }
    // Pick6's own payout table as the recorder read it (3-pick was 5.5x on 10-24, not 6x)
    try { const st = JSON.parse(sh(`git show ${r}:out/stats.json`)); if (st.p6Payouts && Object.keys(st.p6Payouts).length) pick6Payouts = st.p6Payouts; } catch { /* none */ }
  }
  console.log('read', refs.length, 'runs,', recs.length, 'log lines');
  return recs;
}

// ── the esports board ──
// what an earlier report already settled (a result or a void), by leg id
function earlier() {
  const out = new Map();
  if (process.argv[2]) return out;
  try {
    sh(`git fetch -q origin "+refs/heads/${PREFIX}-${WEEK}-report:refs/remotes/origin/${PREFIX}-${WEEK}-report"`);
    const legs = JSON.parse(zlib.gunzipSync(execSync(`git show origin/${PREFIX}-${WEEK}-report:legs.json.gz`, { maxBuffer: 1 << 30 })).toString());
    for (const l of legs) if (l.graded && (l.graded.result != null || l.graded.void != null) && !l.graded.guard) out.set(`${l.app}|${l.key}`, l.graded);
  } catch (e) { console.log('no earlier report:', e.message.slice(0, 120)); }
  return out;
}
async function gradeEsports(series, meta) {
  const G = require('../graders');
  const legs = ER.buildEsLegs(series, meta);
  // OpenDota's pro list names each player's account (as the server's dotaLoadProPlayers)
  let pros = null;
  const vlrKey = n => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const dotaId = async name => {
    if (!pros) {
      pros = {};
      try { for (const p of (await axios.get('https://api.opendota.com/api/proPlayers', { timeout: 30000 })).data || []) for (const n of [p.name, p.personaname]) if (n && !pros[vlrKey(n)]) pros[vlrKey(n)] = p.account_id; }
      catch (e) { console.log('OpenDota pro players', e.message); }
    }
    await new Promise(r => setTimeout(r, 1100));   // OpenDota's free limit: 60 calls a minute
    return pros[vlrKey(name)] || pros[vlrKey(String(name || '').split(/\s+/).pop())] || null;
  };
  const graders = {
    CS: G.createCsGrader(axios), VAL: G.createValGrader(axios), DOTA: G.createDotaGrader(axios, dotaId),
    LOL: G.createLoLGraderChain(G.createLoLesportsGrader(axios), G.createLoLGrader(axios)),
  };
  const before = earlier();
  const results = new Map(), why = {}, asked = new Map();
  const note = k => { why[k] = (why[k] || 0) + 1; };
  const t0 = Date.now();
  for (const leg of legs) {
    const id = `${leg.app}|${leg.key}`;
    const grader = graders[leg.sport];
    if (!leg.stat || !grader) { note(`no grader: ${leg.sport} ${leg.mkey}`); results.set(id, { skip: true }); continue; }
    if (before.has(id)) { results.set(id, before.get(id)); note('settled earlier'); continue; }
    if (Date.parse(leg.start) > Date.now() - 2 * 3600e3) { note('not over yet'); results.set(id, { pending: true }); continue; }
    if (Date.now() - t0 > 40 * 60e3) { note('out of time this run'); results.set(id, { pending: true }); continue; }
    // one grader call per player, stat and match, shared by every app's leg
    const pick = { sport: leg.sport, player: leg.player, team: leg.team, matchTitle: leg.matchTitle, startTime: leg.start, stat: leg.stat, market: leg.market, book: leg.app === 'sleeper' ? 'x' : leg.app };
    const ck = `${leg.sport}|${canonName(leg.player)}|${leg.stat}|${leg.tag || leg.start}|${canonName(leg.opp || '')}`;
    if (!asked.has(ck)) asked.set(ck, grader(pick).catch(e => { note(`grader error ${leg.sport}`); return null; }));
    const res = await asked.get(ck);
    const r = ER.resultFromMaps(res, leg.market);
    note(r.result != null ? 'graded' : r.void != null ? 'void' : 'waiting for results');
    results.set(id, r.result != null ? { ...r, matchId: res?.matchId || null } : r);
  }
  const guarded = ER.lineupGuard(legs, results);
  for (const [id, r] of results) if (r.void === 'whole lineup graded 0 (wrong match)') r.guard = true;
  const rep = ER.summarize(legs, results);
  Object.assign(rep, { week: WEEK, at: new Date().toISOString(), why, guarded, sources: Object.fromEntries(Object.entries(series).map(([s, m]) => [s, m.size])) });
  fs.mkdirSync(OUT, { recursive: true });
  const { rows, ...stackSum } = rep.stacks;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ ...rep, stacks: stackSum }, null, 1));
  fs.writeFileSync(path.join(OUT, 'stacks.json'), JSON.stringify(rows));
  fs.writeFileSync(path.join(OUT, 'report.txt'), `${ER.reportText(rep, { title: `Esports board ${WEEK}` })}\n\nwhy: ${JSON.stringify(why)}\nlineup guard voided: ${guarded}\nsources (keys seen): ${JSON.stringify(rep.sources)}\n`);
  fs.writeFileSync(path.join(OUT, 'legs.json.gz'), zlib.gzipSync(JSON.stringify(legs.map(l => ({ ...l, graded: results.get(`${l.app}|${l.key}`) || null })))));
  console.log(fs.readFileSync(path.join(OUT, 'report.txt'), 'utf8').slice(0, 4000));
}

function pushReport(stamp) {
  if (process.argv[2] || !process.env.GITHUB_REPOSITORY) return;
  const hdr = sh('git config --get http.https://github.com/.extraheader').trim();
  const d = `/tmp/${PREFIX}-report`;
  sh(`rm -rf ${d} && mkdir -p ${d} && cp -r ${OUT}/. ${d}/`);
  const g = c => sh(`git -C ${d} ${c}`);
  g('init -q'); g('config user.name nfl-sunday'); g('config user.email nfl-sunday@users.noreply.github.com');
  g('add -A'); g(`commit -qm "${PREFIX} ${WEEK} report ${stamp}"`);
  sh(`git -C ${d} -c http.extraheader="${hdr}" push -fq https://github.com/${process.env.GITHUB_REPOSITORY}.git HEAD:refs/heads/${PREFIX}-${WEEK}-report`);
  console.log('pushed report');
}

(async () => {
  // logs recorded before freebooks named FanDuel's NHL "Total Goals" and
  // "Total Saves" as the apps do (10-25) carry total_goals / total_saves
  const RENAME = { total_goals: 'goals', total_saves: 'saves', total_assists: 'assists', total_shots_on_goal: 'shots_on_goal' };
  const fixKey = r => { const parts = String(r.k || '').split('|'), last = parts[parts.length - 1];
    if (!RENAME[last]) return r; parts[parts.length - 1] = RENAME[last]; return { ...r, k: parts.join('|'), ...(r.m ? { m: { ...r.m, mkey: RENAME[last] } } : {}) }; };
  const { series, meta } = NS.replay(readLogs().map(fixKey));
  if (ER.isEsBoard(LEAGUES)) { await gradeEsports(series, meta); pushReport(new Date().toISOString()); return; }
  if (pick6Payouts) require('../sportprops').setPick6Payouts(pick6Payouts);
  const legs = NS.buildLegs(series, meta);
  fs.mkdirSync(path.join(OUT, 'espn'), { recursive: true });
  // ESPN's scoreboards for every sport and date a leg starts on (US Eastern)
  const sportDates = [...new Set(legs.map(l => `${l.sport || 'NFL'}|${SG.ymd(Date.parse(l.start))}`))];
  const events = [], bySport = {};
  for (const sd of sportDates) {
    const [sp, d] = sd.split('|');
    try {
      const evs = (await axios.get(`${ESPN(sp)}/scoreboard`, { params: { dates: d, ...(BOARD_PARAMS[sp] || {}) }, timeout: 20000 })).data?.events || [];
      for (const e of evs) e.lrSport = sp;
      events.push(...evs); (bySport[sp] ||= []).push(...evs);
    } catch (e) { console.log('scoreboard', sd, e.message); }
  }
  fs.writeFileSync(path.join(OUT, 'espn', 'events.json'), JSON.stringify(events.map(e => ({ id: e.id, sport: e.lrSport, date: e.date, name: e.name, done: !!e.status?.type?.completed,
    teams: (e.competitions?.[0]?.competitors || []).map(c => ({ abbr: c.team?.abbreviation, name: c.team?.displayName, short: c.team?.shortDisplayName, loc: c.team?.location, score: c.score })) }))));
  const boxes = new Map();
  const box = async ev => {
    if (boxes.has(ev.id)) return boxes.get(ev.id);
    let b = null;
    try {
      const data = (await axios.get(`${ESPN(ev.lrSport)}/summary`, { params: { event: ev.id }, timeout: 20000 })).data;
      fs.writeFileSync(path.join(OUT, 'espn', `${ev.lrSport}-${ev.id}.json.gz`), zlib.gzipSync(JSON.stringify({ boxscore: data?.boxscore })));
      b = SG.parseBox(data?.boxscore);
    } catch (e) { console.log('box', ev.id, e.message); }
    boxes.set(ev.id, b);
    return b;
  };
  const results = new Map(), why = {};
  const note = k => { why[k] = (why[k] || 0) + 1; };
  for (const leg of legs) {
    const id = `${leg.app}|${leg.key}`;
    const sport = leg.sport || 'NFL';
    if (!SG.canGrade({ sport, mkey: leg.mkey })) { note(`no grader: ${sport} ${leg.mkey}`); results.set(id, { skip: true }); continue; }
    const ev = SG.findEvent(bySport[sport] || [], { startTime: leg.start, team: leg.team, matchTitle: leg.matchTitle });
    if (!ev) { note('no ESPN game'); results.set(id, { pending: true }); continue; }
    if (!ev.status?.type?.completed) { note('not final'); results.set(id, { pending: true }); continue; }
    const b = await box(ev);
    if (!b) { note('no box'); results.set(id, { pending: true }); continue; }
    const g = SG.gradeLeg({ sport, mkey: leg.mkey, player: leg.player, signalLine: leg.bet.v[0], signalSide: 'Over' }, b);
    // final, and the player isn't in the box: he didn't play, the apps void it
    if (!g) { note('void: not in box'); results.set(id, { void: true }); continue; }
    results.set(id, { result: g.result, eventId: ev.id });
  }
  const graded = legs.filter(l => !results.get(`${l.app}|${l.key}`)?.skip);
  const multi = graded.some(l => l.sport && l.sport !== 'NFL');
  const rep = NS.summarize(graded, results, { bySport: multi });
  rep.week = WEEK; rep.at = new Date().toISOString(); rep.why = why;
  rep.sources = Object.fromEntries(Object.entries(series).map(([s, m]) => [s, m.size]));
  rep.games = events.map(e => ({ id: e.id, name: e.name, date: e.date, done: !!e.status?.type?.completed }));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(rep, null, 1));
  fs.writeFileSync(path.join(OUT, 'report.txt'), `${NS.reportText(rep, { title: multi ? `Weekend board ${[...new Set(graded.map(l => l.sport))].join('/')} ${WEEK}` : `NFL Sunday ${WEEK}` })}\n\nwhy not graded: ${JSON.stringify(why)}\nsources (keys seen): ${JSON.stringify(rep.sources)}\n`);
  fs.writeFileSync(path.join(OUT, 'legs.json.gz'), zlib.gzipSync(JSON.stringify(legs.map(l => ({ ...l, graded: results.get(`${l.app}|${l.key}`) || null })))));
  console.log(fs.readFileSync(path.join(OUT, 'report.txt'), 'utf8').slice(0, 4000));
  pushReport(rep.at);
})().catch(e => { console.error(e); process.exit(1); });
