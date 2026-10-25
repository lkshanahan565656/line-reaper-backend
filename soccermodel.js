// ─── SOCCER MATCH MODEL (soccermodel.js) ─────────────────────────────────────
// Our own number for a soccer match's three-way result (home win, draw, away
// win) and its 2.5-goal total, built from final scores and shots on target so
// every part can be explained:
//
//   1. Each team has an attack and a defence rating inside its league (log
//      goal rates). Expected home goals = exp(league level + home edge +
//      home attack - away defence); away goals the same without the home edge.
//   2. After each match both teams move by k times the miss. The "goals" a
//      team is judged on are a blend of what it scored and its shots on
//      target times a conversion rate (wSot): shots on target say more about
//      next week than a deflected winner does. The league level and the home
//      edge drift with the same kind of step.
//   3. A new season pulls every rating part of the way back to 0 (squads
//      change). A team arriving from a lower tier starts below the league
//      (promo), one dropping from a higher tier above it.
//   4. Scores are two Poissons with Dixon-Coles' low-score correction (rho),
//      which puts back the 0-0 and 1-1 draws plain Poissons miss.
//
// Fitted walk-forward on 2012-13 to 2021-22 (scripts/soccermodel-fit.js),
// checked on 2022-23 to 2024-25 against Pinnacle's close, frozen in
// seeds/soccermodel-params.json. Pure: the data layer feeds finished matches
// in kickoff order and asks for predictions. A model, never a proven edge.

const DEFAULTS = {
  k: 0.035, kb: 0.002, kh: 0.002, shrink: 0.3, promo: 0.15, wSot: 0.4, sotConv: 0.31, rho: -0.08,
  base0: 0.28, hfa0: 0.25, maxGoals: 10, tierShift: 0.15,
};

// league codes: football-data.co.uk divisions and its "new" country files
const LEAGUES = {
  E0: { name: 'Premier League', country: 'ENG', tier: 1 }, E1: { name: 'Championship', country: 'ENG', tier: 2 }, E2: { name: 'League One', country: 'ENG', tier: 3 },
  SP1: { name: 'La Liga', country: 'ESP', tier: 1 }, SP2: { name: 'La Liga 2', country: 'ESP', tier: 2 },
  D1: { name: 'Bundesliga', country: 'GER', tier: 1 }, D2: { name: '2. Bundesliga', country: 'GER', tier: 2 },
  I1: { name: 'Serie A', country: 'ITA', tier: 1 }, I2: { name: 'Serie B', country: 'ITA', tier: 2 },
  F1: { name: 'Ligue 1', country: 'FRA', tier: 1 }, F2: { name: 'Ligue 2', country: 'FRA', tier: 2 },
  N1: { name: 'Eredivisie', country: 'NED', tier: 1 }, P1: { name: 'Primeira Liga', country: 'POR', tier: 1 },
  B1: { name: 'Belgian Pro League', country: 'BEL', tier: 1 }, T1: { name: 'Super Lig', country: 'TUR', tier: 1 },
  G1: { name: 'Greek Super League', country: 'GRE', tier: 1 }, SC0: { name: 'Scottish Premiership', country: 'SCO', tier: 1 },
  USA: { name: 'MLS', country: 'USA', tier: 1 }, MEX: { name: 'Liga MX', country: 'MEX', tier: 1 }, BRA: { name: 'Brasileirao', country: 'BRA', tier: 1 },
  ARG: { name: 'Argentina Primera', country: 'ARG', tier: 1 }, JPN: { name: 'J1 League', country: 'JPN', tier: 1 }, NOR: { name: 'Eliteserien', country: 'NOR', tier: 1 },
  SWE: { name: 'Allsvenskan', country: 'SWE', tier: 1 }, DNK: { name: 'Danish Superliga', country: 'DNK', tier: 1 }, AUT: { name: 'Austrian Bundesliga', country: 'AUT', tier: 1 },
  SWZ: { name: 'Swiss Super League', country: 'SUI', tier: 1 }, POL: { name: 'Ekstraklasa', country: 'POL', tier: 1 }, IRL: { name: 'League of Ireland', country: 'IRL', tier: 1 },
  CHN: { name: 'Chinese Super League', country: 'CHN', tier: 1 }, FIN: { name: 'Veikkausliiga', country: 'FIN', tier: 1 }, ROU: { name: 'Liga I', country: 'ROU', tier: 1 },
};

const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const num = v => { if (v == null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };

// ── names ──
// one spelling per club: accents off, punctuation off, club words (FC, CF,
// AFC ...) off, the usual short forms spelled out
const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'ssc', 'as', 'cd', 'ud', 'rc', 'rcd', 'sd', 'sv', 'vfl', 'vfb', 'tsg', 'fk', 'sk', 'bk', 'if', 'ff', 'cp', 'club', 'de', 'cfc', 'calcio', '1', 'us', 'ca', 'ogc', 'osc', 'stade', 'aj', 'sl', 'fsv', 'bsc', 'hsc', 'ec', 'se', 'cr', 'the', 'and', 'kv', 'krc', 'rsc', 'kaa', 'royal', 'nk', 'hnk', 'gnk', 'cs', 'rb']);
const ALIAS = {
  'man united': 'manchester united', 'man utd': 'manchester united', 'man city': 'manchester city', 'nott m forest': 'nottingham forest', 'nottm forest': 'nottingham forest', 'notts forest': 'nottingham forest',
  wolves: 'wolverhampton', 'wolverhampton wanderers': 'wolverhampton', spurs: 'tottenham', 'tottenham hotspur': 'tottenham', 'sheffield weds': 'sheffield wednesday', 'sheff wed': 'sheffield wednesday',
  'sheffield utd': 'sheffield united', 'sheff utd': 'sheffield united', 'west ham united': 'west ham', 'newcastle united': 'newcastle', 'brighton hove albion': 'brighton', 'brighton and hove albion': 'brighton',
  'leicester city': 'leicester', 'leeds united': 'leeds', 'norwich city': 'norwich', 'stoke city': 'stoke', 'swansea city': 'swansea', 'cardiff city': 'cardiff', 'hull city': 'hull', 'luton town': 'luton',
  'ipswich town': 'ipswich', 'coventry city': 'coventry', 'birmingham city': 'birmingham', 'derby county': 'derby', 'preston north end': 'preston', 'qpr': 'queens park rangers', 'west bromwich albion': 'west brom',
  'wba': 'west brom', 'blackburn rovers': 'blackburn', 'bristol c': 'bristol city', 'plymouth argyle': 'plymouth', 'oxford united': 'oxford', 'huddersfield town': 'huddersfield', 'bournemouth': 'bournemouth',
  'atl madrid': 'atletico madrid', 'ath madrid': 'atletico madrid', 'atletico de madrid': 'atletico madrid', 'ath bilbao': 'athletic bilbao', 'athletic club': 'athletic bilbao', 'sociedad': 'real sociedad',
  betis: 'real betis', 'espanol': 'espanyol', 'celta': 'celta vigo', 'vallecano': 'rayo vallecano', 'la coruna': 'deportivo la coruna', 'alaves': 'alaves', 'deportivo alaves': 'alaves', 'sp gijon': 'sporting gijon',
  'real oviedo': 'oviedo', 'girona': 'girona', 'leganes': 'leganes', 'mallorca': 'mallorca', 'real mallorca': 'mallorca', 'valladolid': 'valladolid', 'real valladolid': 'valladolid',
  'm gladbach': 'monchengladbach', 'borussia monchengladbach': 'monchengladbach', 'gladbach': 'monchengladbach', 'ein frankfurt': 'eintracht frankfurt', 'frankfurt': 'eintracht frankfurt',
  leverkusen: 'bayer leverkusen', 'bayer 04 leverkusen': 'bayer leverkusen', 'fc koln': 'koln', cologne: 'koln', '1 fc koln': 'koln', dortmund: 'borussia dortmund', 'bayern munich': 'bayern', 'bayern munchen': 'bayern',
  'hertha': 'hertha berlin', 'hertha bsc': 'hertha berlin', 'union berlin': 'union berlin', 'mainz': 'mainz 05', 'mainz 05': 'mainz 05', 'hoffenheim': 'hoffenheim', 'tsg hoffenheim': 'hoffenheim', 'leipzig': 'leipzig', 'rb leipzig': 'leipzig',
  'werder bremen': 'werder bremen', bremen: 'werder bremen', 'st pauli': 'st pauli', 'heidenheim': 'heidenheim', stuttgart: 'stuttgart', 'wolfsburg': 'wolfsburg', augsburg: 'augsburg', 'freiburg': 'freiburg', 'hamburg': 'hamburger',
  inter: 'inter milan', internazionale: 'inter milan', 'inter milano': 'inter milan', milan: 'ac milan', 'ac milan': 'ac milan', roma: 'roma', 'as roma': 'roma', lazio: 'lazio', napoli: 'napoli', 'juventus': 'juventus',
  'verona': 'hellas verona', 'hellas verona': 'hellas verona', 'parma': 'parma', 'como': 'como', 'atalanta': 'atalanta', 'fiorentina': 'fiorentina', 'torino': 'torino', 'udinese': 'udinese', 'genoa': 'genoa',
  'paris sg': 'paris saint germain', psg: 'paris saint germain', 'paris saint germain': 'paris saint germain', 'st etienne': 'saint etienne', 'marseille': 'marseille', 'olympique marseille': 'marseille',
  'olympique de marseille': 'marseille', lyon: 'lyon', 'olympique lyonnais': 'lyon', 'monaco': 'monaco', 'as monaco': 'monaco', nice: 'nice', lille: 'lille', rennes: 'rennes', 'stade rennais': 'rennes', lens: 'lens',
  'rc lens': 'lens', 'brest': 'brest', 'stade brestois': 'brest', 'reims': 'reims', 'stade de reims': 'reims', 'strasbourg': 'strasbourg', 'nantes': 'nantes', 'toulouse': 'toulouse', 'montpellier': 'montpellier',
  'le havre': 'le havre', 'auxerre': 'auxerre', 'angers': 'angers', 'lorient': 'lorient', 'metz': 'metz', 'paris fc': 'paris fc',
  'psv eindhoven': 'psv', 'psv': 'psv', 'ajax amsterdam': 'ajax', 'feyenoord rotterdam': 'feyenoord', 'az alkmaar': 'az', 'twente': 'twente', 'fc twente': 'twente', 'utrecht': 'utrecht', 'fc utrecht': 'utrecht',
  'sporting lisbon': 'sporting', 'sporting cp': 'sporting', 'sp lisbon': 'sporting', 'benfica': 'benfica', 'porto': 'porto', 'fc porto': 'porto', 'sp braga': 'braga', 'sc braga': 'braga', guimaraes: 'vitoria guimaraes',
  'la galaxy': 'los angeles galaxy', 'la galaxy ii': 'los angeles galaxy ii', 'lafc': 'los angeles fc', 'los angeles fc': 'los angeles fc', 'ny red bulls': 'new york red bulls', 'nycfc': 'new york city', 'new york city fc': 'new york city',
  'inter miami cf': 'inter miami', 'dc united': 'dc united', 'd c united': 'dc united', 'atlanta utd': 'atlanta united', 'minnesota united': 'minnesota', 'minnesota utd': 'minnesota', 'seattle sounders': 'seattle sounders',
  'sporting kansas city': 'sporting kansas city', 'sporting kc': 'sporting kansas city', 'cf montreal': 'montreal', 'montreal impact': 'montreal', 'st louis city': 'st louis city', 'st louis city sc': 'st louis city',
  'sport lisboa e benfica': 'benfica', 'sport lisboa benfica': 'benfica', 'estrela da amadora': 'estrela', 'estrela amadora': 'estrela', 'avs futebol': 'avs', 'internazionale milano': 'inter milan',
  brestois: 'brest', rennais: 'rennes', nec: 'nijmegen', 'nec nijmegen': 'nijmegen', 'for sittard': 'fortuna sittard', 'atl san luis': 'san luis', 'atletico san luis': 'san luis', 'espanyol barcelona': 'espanyol',
  'deportivo a coruna': 'deportivo la coruna', 'deportivo coruna': 'deportivo la coruna', santander: 'racing santander', 'real racing': 'racing santander', 'racing': 'racing santander',
  'america': 'club america', 'club america': 'club america', 'guadalajara chivas': 'guadalajara', chivas: 'guadalajara', 'u n a m': 'pumas unam', unam: 'pumas unam', 'pumas': 'pumas unam',
};
const deaccent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
function canon(name) {
  let s = deaccent(name).toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (ALIAS[s]) return ALIAS[s];
  const words = s.split(' ').filter(w => !STOP.has(w) && !/^\d+$/.test(w));   // club words and founding years (1846, 09) off
  s = words.join(' ') || s;
  return ALIAS[s] || s;
}
// two club names → same club? (canon equal, or one's words inside the other's
// with a 4+ letter word shared; "Bristol City" is not "Bristol Rovers")
function sameClub(a, b) {
  const x = canon(a), y = canon(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(' '), ys = y.split(' ');
  const [s, l] = xs.length <= ys.length ? [xs, ys] : [ys, xs];
  return s.every(w => l.includes(w)) && s.some(w => w.length >= 4) && l.length - s.length <= 1;
}

// ── football-data.co.uk CSVs ──
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
// UK clock time → UTC ms (British Summer Time: last Sunday of March to last Sunday of October, 01:00 UTC)
function lastSunday(y, m) { const d = new Date(Date.UTC(y, m + 1, 0)); return Date.UTC(y, m, d.getUTCDate() - d.getUTCDay(), 1); }
function ukToUtc(y, mo, d, hh, mm) {
  const naive = Date.UTC(y, mo, d, hh, mm);
  const bst = naive - 3600e3 >= lastSunday(y, 2) && naive - 3600e3 < lastSunday(y, 9);
  return naive - (bst ? 3600e3 : 0);
}
function parseDate(dateStr, timeStr) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  let y = Number(m[3]); if (y < 100) y += 2000;
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || '').trim());
  // no kickoff time in the older files: 15:00 UK, the usual Saturday slot
  return ukToUtc(y, Number(m[2]) - 1, Number(m[1]), t ? Number(t[1]) : 15, t ? Number(t[2]) : 0);
}
// a football-data CSV (either layout) → matches in file order:
// { league, season, kickoff, home, away, hg, ag, hst, ast, close: { h, d, a } | null, closeOver: p | null }
function parseFootballData(text, league, season = null) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const head = splitCsv(lines[0]).map(h => h.trim());
  const ix = n => head.indexOf(n);
  const col = (row, ...names) => { for (const n of names) { const i = ix(n); if (i >= 0 && row[i] !== undefined && row[i] !== '') return row[i]; } return null; };
  const out = [];
  for (const l of lines.slice(1)) {
    const row = splitCsv(l);
    const home = col(row, 'HomeTeam', 'Home', 'HT'), away = col(row, 'AwayTeam', 'Away', 'AT');
    const hg = num(col(row, 'FTHG', 'HG')), ag = num(col(row, 'FTAG', 'AG'));
    const kickoff = parseDate(col(row, 'Date'), col(row, 'Time'));
    if (!home || !away || kickoff == null) continue;
    // the sharp close: Pinnacle's (football-data stopped carrying it in 2026), else Betfair Exchange's
    const trio = (a, b, c) => { const x = [num(col(row, a)), num(col(row, b)), num(col(row, c))]; return x.every(v => v > 1) ? devigDecimal(x) : null; };
    const pinClose = trio('PSCH', 'PSCD', 'PSCA'), bfClose = pinClose ? null : trio('BFECH', 'BFECD', 'BFECA');
    const close = pinClose || bfClose;
    const ov = num(col(row, 'PC>2.5')), un = num(col(row, 'PC<2.5'));
    const closeOver = ov > 1 && un > 1 ? devigDecimal([ov, un])[0] : null;
    const s = season || (() => { const x = col(row, 'Season'); return x ? String(x).slice(0, 4) : null; })();
    out.push({ league, season: s, kickoff, home: String(home).trim(), away: String(away).trim(), hg, ag, done: hg != null && ag != null,
      hst: num(col(row, 'HST')), ast: num(col(row, 'AST')), close: close ? { h: r4(close[0]), d: r4(close[1]), a: r4(close[2]), src: pinClose ? 'pinnacle' : 'betfair' } : null, closeOver: r4(closeOver) });
  }
  return out;
}
// decimal prices → no-vig chances (power method, the same as pingames' devig)
function devigDecimal(ds) {
  const ps = ds.map(d => 1 / d);
  const sum = ps.reduce((s, p) => s + p, 0);
  if (sum <= 1) return ps.map(p => p / sum);
  let lo = 1, hi = 3;
  for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2; if (ps.reduce((s, p) => s + p ** k, 0) > 1) lo = k; else hi = k; }
  const k = (lo + hi) / 2;
  return ps.map(p => p ** k);
}

// ── score chances ──
// two Poissons with Dixon-Coles' correction → { h, d, a, over25, btts }
function chances(lh, la, rho = DEFAULTS.rho, maxGoals = DEFAULTS.maxGoals) {
  const ph = [], pa = [];
  let f = Math.exp(-lh), g = Math.exp(-la);
  for (let i = 0; i <= maxGoals; i++) { ph.push(f); pa.push(g); f *= lh / (i + 1); g *= la / (i + 1); }
  let h = 0, d = 0, a = 0, over = 0, btts = 0, tot = 0;
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      let p = ph[i] * pa[j];
      if (i === 0 && j === 0) p *= 1 - lh * la * rho;
      else if (i === 0 && j === 1) p *= 1 + lh * rho;
      else if (i === 1 && j === 0) p *= 1 + la * rho;
      else if (i === 1 && j === 1) p *= 1 - rho;
      if (p < 0) p = 0;
      tot += p;
      if (i > j) h += p; else if (i === j) d += p; else a += p;
      if (i + j > 2) over += p;
      if (i > 0 && j > 0) btts += p;
    }
  }
  return { h: r4(h / tot), d: r4(d / tot), a: r4(a / tot), over25: r4(over / tot), btts: r4(btts / tot) };
}

// ── ratings ──
function createRatings(params = {}) {
  const o = { ...DEFAULTS, ...params };
  const teams = new Map();     // `${country}|${canon}` → { att, def, league, n, name, last }
  const leagues = new Map();   // league → { base, hfa, season, n }
  const L = code => {
    if (!leagues.has(code)) leagues.set(code, { base: o.base0, hfa: o.hfa0, season: null, n: 0 });
    return leagues.get(code);
  };
  const countryOf = code => LEAGUES[code]?.country || code;
  const tierOf = code => LEAGUES[code]?.tier || 1;
  const keyOf = (code, name) => `${countryOf(code)}|${canon(name)}`;
  // a team as it stands in this league (moved between tiers: shifted by promo per tier)
  function team(code, name, create = true) {
    const k = keyOf(code, name);
    let t = teams.get(k);
    if (!t) {
      if (!create) return null;
      // a club we have never seen: in a league with history, most likely promoted
      const lg = L(code), off = lg.n > 0 ? -o.promo : 0;
      t = { att: off, def: off, league: code, n: 0, name, last: null };
      teams.set(k, t);
    } else if (t.league !== code && create) {
      const shift = o.tierShift * (tierOf(code) - tierOf(t.league));   // down a tier (+1): stronger there
      t.att += shift; t.def += shift; t.league = code;
    }
    return t;
  }
  function newSeason(code, season) {
    const lg = L(code);
    if (lg.season === season) return;
    if (lg.season != null) for (const t of teams.values()) if (t.league === code) { t.att *= 1 - o.shrink; t.def *= 1 - o.shrink; }
    lg.season = season;
  }
  function rates(code, home, away, h = null, a = null) {
    const lg = L(code);
    const th = h || team(code, home, false), ta = a || team(code, away, false);
    const unk = L(code).n > 0 ? -o.promo : 0;
    const ah = th ? th.att : unk, dh = th ? th.def : unk, aa = ta ? ta.att : unk, da = ta ? ta.def : unk;
    return { lh: Math.exp(lg.base + lg.hfa + ah - da), la: Math.exp(lg.base + aa - dh), known: !!(th && ta), homeGames: th?.n || 0, awayGames: ta?.n || 0 };
  }
  function predict(code, home, away) {
    const r = rates(code, home, away);
    return { ...r, lh: r4(r.lh), la: r4(r.la), ...chances(r.lh, r.la, o.rho, o.maxGoals) };
  }
  function update(m) {
    if (!m.done) return;
    if (m.season != null) newSeason(m.league, m.season);
    const lg = L(m.league);
    const th = team(m.league, m.home), ta = team(m.league, m.away);
    const { lh, la } = rates(m.league, m.home, m.away, th, ta);
    const w = m.hst != null && m.ast != null ? o.wSot : 0;
    const yh = (1 - w) * m.hg + w * o.sotConv * (m.hst ?? 0), ya = (1 - w) * m.ag + w * o.sotConv * (m.ast ?? 0);
    const eh = yh - lh, ea = ya - la;
    th.att += o.k * eh; ta.def -= o.k * eh;
    ta.att += o.k * ea; th.def -= o.k * ea;
    lg.base += o.kb * (eh + ea); lg.hfa += o.kh * (eh - ea);
    th.n++; ta.n++; th.last = m.kickoff; ta.last = m.kickoff; th.name = m.home; ta.name = m.away;
    lg.n++;
  }
  function table(code = null) {
    const out = [];
    for (const t of teams.values()) {
      if (code && t.league !== code) continue;
      out.push({ team: t.name, league: t.league, attack: r4(t.att), defence: r4(t.def), strength: r4(t.att + t.def), matches: t.n, last: t.last ? new Date(t.last).toISOString().slice(0, 10) : null });
    }
    return out.sort((a, b) => b.strength - a.strength);
  }
  // the club in this league that an outside name means (Pinnacle's, Kalshi's) → its stored name | null
  function resolve(code, name) {
    const country = countryOf(code);
    const k = `${country}|${canon(name)}`;
    if (teams.has(k)) return teams.get(k).name;
    const hits = [...teams.entries()].filter(([key, t]) => key.startsWith(`${country}|`) && t.league === code && sameClub(t.name, name));
    return hits.length === 1 ? hits[0][1].name : null;
  }
  const status = () => ({ teams: teams.size, leagues: Object.fromEntries([...leagues.entries()].map(([c, l]) => [c, { matches: l.n, season: l.season, goals: r4(Math.exp(l.base) * (1 + Math.exp(l.hfa)) ), homeEdge: r4(l.hfa) }])) });
  // the whole state as plain data (a seed the server can start from) and back
  const exportState = () => ({ teams: [...teams.entries()].map(([k, t]) => [k, r4(t.att), r4(t.def), t.league, t.n, t.name, t.last]),
    leagues: [...leagues.entries()].map(([c, l]) => [c, r4(l.base), r4(l.hfa), l.season, l.n]) });
  function importState(st) {
    teams.clear(); leagues.clear();
    for (const [k, att, def, league, n, name, last] of st?.teams || []) teams.set(k, { att, def, league, n, name, last });
    for (const [c, base, hfa, season, n] of st?.leagues || []) leagues.set(c, { base, hfa, season, n });
  }
  return { update, predict, rates, table, resolve, status, newSeason, exportState, importState, _teams: teams, _leagues: leagues };
}

// one walk-forward pass → { n, logLoss, brier } over matches with from <= kickoff < to (all
// matches update the ratings; only those in the window are scored)
function walk(matches, params, { from = -Infinity, to = Infinity, onPredict = null } = {}) {
  const R = createRatings(params);
  let n = 0, ll = 0, br = 0;
  for (const m of matches) {
    if (m.done && m.kickoff >= from && m.kickoff < to) {
      const p = R.predict(m.league, m.home, m.away);
      const out = m.hg > m.ag ? 'h' : m.hg === m.ag ? 'd' : 'a';
      if (p.known) {
        ll -= Math.log(Math.max(1e-6, p[out]));
        br += (['h', 'd', 'a'].reduce((s, k) => s + ((k === out ? 1 : 0) - p[k]) ** 2, 0));
        n++;
        if (onPredict) onPredict(m, p, out);
      }
    }
    R.update(m);
  }
  return { n, logLoss: n ? ll / n : null, brier: n ? br / n : null, ratings: R };
}

module.exports = { DEFAULTS, LEAGUES, canon, sameClub, parseFootballData, devigDecimal, chances, createRatings, walk, ukToUtc, parseDate };
