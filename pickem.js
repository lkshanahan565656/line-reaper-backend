// ─── PICK'EM BOOK PARSERS: PrizePicks and Sleeper ────────────────────────────
// Pure functions, so the payload handling is testable and survives shape changes.
// Both answer from Railway (checked live 2026-10-13 on /api/esports/probe/books):
//   PrizePicks partner-api.prizepicks.com/projections (api.prizepicks.com 403s
//   datacenter IPs), JSON:API with league_id filtering.
//   Sleeper api.sleeper.app/lines/available: one row per player line, an
//   option per side with its own payout, players from /players/{sport}.

// PrizePicks. Only standard lines: goblins and demons pay on a different table
// and allow one side only, so pricing them at standard odds would be wrong.
// Combo props (two players, or a whole team) aren't modelled.
function parsePrizePicksPayload(data) {
  const players = {}, leagues = {}, lines = [];
  for (const inc of (data && data.included) || []) {
    const a = inc.attributes || {};
    if (inc.type === 'new_player') players[inc.id] = { name: a.display_name || a.name || '', team: a.team || '', league: a.league || '' };
    if (inc.type === 'league') leagues[inc.id] = a.name || '';
  }
  for (const proj of (data && data.data) || []) {
    const attr = proj.attributes || {};
    if (!attr.line_score) continue;
    if (attr.odds_type && attr.odds_type !== 'standard') continue;
    // a promo (free square, flash sale) hangs a cut line: parsePrizePicksPromos keeps it
    if (attr.is_promo === true || attr.flash_sale_line_score != null) continue;
    if (/combo/i.test(attr.stat_type || '') || attr.event_type === 'combo') continue;
    if (attr.status && attr.status !== 'pre_game') continue;
    const player = players[proj.relationships?.new_player?.data?.id] || {};
    if (!player.name) continue;   // a line we can't name can't be matched or graded
    const leagueId = proj.relationships?.league?.data?.id;
    const sport = leagues[leagueId] || player.league || attr.league || '';
    lines.push({ book: 'prizepicks', sport, leagueId: leagueId || null, player: player.name, team: player.team || '', market: attr.stat_type || '',
      line: parseFloat(attr.line_score), startTime: attr.start_time || '', matchTitle: attr.description || '', opponent: attr.description || '', gameId: attr.game_id || null });
  }
  return { lines, leagues };
}

// PrizePicks' discounted and alternate lines (promos.js prices them):
//   goblin / demon: odds_type, a lower / higher line, More only, and an entry
//     payout PrizePicks changes by an amount its open feed doesn't carry
//     (mult null: the required hit rate can't be known, only the multiplier
//     PrizePicks would have to pay for the leg to break even)
//   promo: is_promo with a discount (free square, flash sale): the line cut to
//     flash_sale_line_score, the standard payout (mult 1)
// side: allowed_wager_types when the feed names one, else More for goblins
// and demons and both for a promo.
function parsePrizePicksPromos(data) {
  const players = {}, leagues = {}, out = [];
  for (const inc of (data && data.included) || []) {
    const a = inc.attributes || {};
    if (inc.type === 'new_player') players[inc.id] = { name: a.display_name || a.name || '', team: a.team || '', league: a.league || '' };
    if (inc.type === 'league') leagues[inc.id] = a.name || '';
  }
  for (const proj of (data && data.data) || []) {
    const attr = proj.attributes || {};
    const odds = String(attr.odds_type || 'standard');
    const promo = attr.is_promo === true || attr.flash_sale_line_score != null;
    const type = odds === 'goblin' || odds === 'demon' ? odds : promo ? 'promo' : null;
    if (!type || attr.line_score == null) continue;
    if (/combo/i.test(attr.stat_type || '') || attr.event_type === 'combo') continue;
    if (attr.status && attr.status !== 'pre_game') continue;
    const player = players[proj.relationships?.new_player?.data?.id] || {};
    if (!player.name) continue;
    const leagueId = proj.relationships?.league?.data?.id;
    const base = parseFloat(attr.line_score);
    const cut = attr.flash_sale_line_score != null ? parseFloat(attr.flash_sale_line_score) : null;
    const line = type === 'promo' && Number.isFinite(cut) ? cut : base;
    if (!Number.isFinite(line)) continue;
    const allowed = String(attr.allowed_wager_types || '').toLowerCase();
    const sides = allowed === 'over' ? ['Over'] : allowed === 'under' ? ['Under'] : type === 'promo' ? ['Over', 'Under'] : ['Over'];
    for (const side of sides) out.push({
      book: 'prizepicks', type, side, mult: type === 'promo' ? 1 : null, line, baseLine: line !== base ? base : null,
      sport: leagues[leagueId] || player.league || attr.league || '', leagueId: leagueId || null, player: player.name, team: player.team || '',
      market: attr.stat_type || '', startTime: attr.start_time || '', matchTitle: attr.description || '', gameId: attr.game_id || null,
      note: type === 'promo' ? [attr.discount_name ? String(attr.discount_name).replace(/_/g, ' ') : 'promo', attr.discount_percentage != null ? `${attr.discount_percentage}% off` : ''].filter(Boolean).join(', ') : null,
      id: proj.id || null,
    });
  }
  return out;
}

// Sleeper's esports sport keys, and the labels the rest of the server uses
const SLEEPER_ESPORTS = { cs: 'CS', cs2: 'CS', lol: 'LOL', val: 'VAL', valorant: 'VAL', dota: 'DOTA', dota2: 'DOTA', cod: 'COD', r6: 'R6' };

// "kills_maps_1_2" → "Kills Maps 1-2", "headshots_maps_1_3" → "Headshots Maps 1-3",
// "kills_map_1" → "Kills Map 1". The range form, so 1_3 reads as three maps.
function sleeperMarket(wager) {
  const w = String(wager || '');
  const m = w.match(/^(.*?)_(maps?|games?)_(\d+)(?:_(\d+))?$/);
  const words = s => s.split('_').filter(Boolean).map(x => x.charAt(0).toUpperCase() + x.slice(1)).join(' ');
  if (!m) return words(w);
  const unit = m[2].charAt(0).toUpperCase() + m[2].slice(1);
  return `${words(m[1])} ${unit} ${m[4] ? `${m[3]}-${m[4]}` : m[3]}`;
}

// Sleeper's sports keys (soccer comes per competition, "clubsoccer:epl"), as
// the labels Underdog and PrizePicks use, so one player's lines line up
const SLEEPER_SPORTS = { nfl: 'NFL', nba: 'NBA', mlb: 'MLB', nhl: 'NHL', wnba: 'WNBA', cfb: 'CFB', cbb: 'CBB', tennis: 'TENNIS', mma: 'MMA', golf: 'GOLF' };
const sleeperSport = key => {
  const k = String(key || '').toLowerCase();
  return SLEEPER_ESPORTS[k] || SLEEPER_SPORTS[k] || (/^clubsoccer|^soccer/.test(k) ? 'SOCCER' : null);
};
// Sleeper's wager keys in the words Underdog uses ("Rush + Rec Yards"), so
// ev.js canonMarket reads all three books the same
const SLEEPER_WAGERS = {
  points: 'Points', rebounds: 'Rebounds', assists: 'Assists', threes_made: '3-Pointers Made', steals: 'Steals', blocks: 'Blocks',
  pts_reb_ast: 'Pts + Rebs + Asts', pts_reb: 'Pts + Rebs', pts_ast: 'Pts + Asts', reb_ast: 'Rebs + Asts', turnovers: 'Turnovers',
  hits: 'Hits', hits_runs_rbis: 'Hits + Runs + RBIs', runs: 'Runs', singles: 'Singles', total_bases: 'Total Bases', bat_walks: 'Batter Walks',
  rbis: 'RBIs', stolen_bases: 'Stolen Bases', earned_runs: 'Earned Runs Allowed', first_inning_runs: '1st Inn. Runs Allowed',
  hits_allowed: 'Hits Allowed', outs: 'Pitching Outs', strike_outs: 'Pitcher Strikeouts', walks: 'Pitcher Walks Allowed',
  goals: 'Goals', powerplay_points: 'Power Play Points', goals_against: 'Goals Against', saves: 'Saves', blocked_shots: 'Blocked Shots',
  anytime_touchdowns: 'Anytime TD', receiving_yards: 'Receiving Yards', receptions: 'Receptions', rushing_yards: 'Rush Yards',
  passing_yards: 'Pass Yards', passing_touchdowns: 'Pass TDs', rushing_and_receiving_yards: 'Rush + Rec Yards',
  passing_and_rushing_yards: 'Pass + Rush Yards', rushing_attempts: 'Rush Attempts', pass_completions: 'Completions',
  passing_attempts: 'Pass Attempts', interceptions: 'INTs Thrown', longest_rush: 'Longest Rush', longest_reception: 'Longest Reception',
  longest_passing_completion: 'Longest Completion', extra_point_made: 'XP Made', field_goal_made: 'FG Made', kicking_points: 'Kicking Points',
  games_played: 'Total Games', games_won: 'Games Won', aces: 'Aces', breakpts_won: 'Break Points Won',
  significant_strikes: 'Significant Strikes', takedowns: 'Takedowns', total_fight_time: 'Fight Time',
  shots_on_target: 'Shots On Target', passes_attempted: 'Passes Attempted', first_half_goals_against: '1H Goals Against',
};
function sleeperSportMarket(sport, wager) {
  const w = String(wager || '').toLowerCase();
  if (w === 'shots') return sport === 'NHL' ? 'Shots on Goal' : 'Shots';
  return SLEEPER_WAGERS[w] || sleeperMarket(w);
}

// rows: /lines/available. players: { sport: { id: player } } from /players/{sport}.
// Each side's payout_multiplier is that leg's own multiplier (an entry pays
// their product), so it's a decimal price: 1.48 Over vs 2.19 Under says Sleeper
// sees the over near 60%.
// Esports only unless { sports: true }: the esports board borrows each line's
// match from another book, while the props board takes every sport.
function parseSleeperLines(rows, players = {}, { sports = false } = {}) {
  const lines = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row.sport || '').toLowerCase();
    const sport = sports ? sleeperSport(key) : SLEEPER_ESPORTS[key];
    if (!sport || row.subject_type !== 'player' || row.outcome_type !== 'over_under') continue;
    if (row.status && row.status !== 'active') continue;
    if (row.game_status && row.game_status !== 'pre_game') continue;
    if (!normalSleeperLine(row)) continue;   // a boosted or promo line: parseSleeperPromos
    let over = null, under = null, line = null, team = '';
    for (const o of row.options || []) {
      if (!o || (o.status && o.status !== 'active')) continue;
      const m = parseFloat(o.payout_multiplier);
      if (!(m > 1)) continue;
      if (o.outcome === 'over') over = m; else if (o.outcome === 'under') under = m; else continue;
      if (line == null) line = parseFloat(o.outcome_value);
      team = team || o.subject_team || '';
    }
    if (line == null || !isFinite(line) || (over == null && under == null)) continue;
    const p = (players[key] || {})[row.subject_id] || {};
    const name = p.metadata?.username || p.username || [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (!name) continue;
    const esport = !!SLEEPER_ESPORTS[key];
    lines.push({
      book: 'sleeper', sport, player: name, team: team || p.team || '', market: esport ? sleeperMarket(row.wager_type) : sleeperSportMarket(sport, row.wager_type), line,
      gameId: row.game_id || null, startTime: '', matchTitle: '', slSport: key, season: row.season || null, seasonType: row.season_type || null,
      overMultiplier: over, underMultiplier: under, overOpen: over != null, underOpen: under != null,
    });
  }
  return lines;
}

// Sleeper marks its lines line_type 'normal' (every row of the 10-15 board);
// any other type is a boosted or promo line with its own multiplier per side
const normalSleeperLine = row => !row.line_type || row.line_type === 'normal';
// rows → one leg per open side of each non-normal line, sports and esports:
// { book: 'sleeper', type, side, mult, line, sport, player, team, market, slSport, gameId }
function parseSleeperPromos(rows, players = {}) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (normalSleeperLine(row)) continue;
    const key = String(row.sport || '').toLowerCase();
    const sport = sleeperSport(key);
    if (!sport || row.subject_type !== 'player' || row.outcome_type !== 'over_under') continue;
    if ((row.status && row.status !== 'active') || (row.game_status && row.game_status !== 'pre_game')) continue;
    const p = (players[key] || {})[row.subject_id] || {};
    const name = p.metadata?.username || p.username || [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (!name) continue;
    const esport = !!SLEEPER_ESPORTS[key];
    const market = esport ? sleeperMarket(row.wager_type) : sleeperSportMarket(sport, row.wager_type);
    for (const o of row.options || []) {
      if (!o || (o.status && o.status !== 'active')) continue;
      const m = parseFloat(o.payout_multiplier), line = parseFloat(o.outcome_value);
      const side = o.outcome === 'over' ? 'Over' : o.outcome === 'under' ? 'Under' : null;
      if (!(m > 1) || !side || !Number.isFinite(line)) continue;
      out.push({ book: 'sleeper', type: String(row.line_type).toLowerCase(), side, mult: m, line, baseLine: null, sport, player: name, team: o.subject_team || p.team || '',
        market, startTime: '', matchTitle: '', gameId: row.game_id || null, slSport: key, note: null });
    }
  }
  return out;
}

// Every sport key with lines, esports and sports
function sleeperSportKeys(rows) {
  const s = new Set();
  for (const r of Array.isArray(rows) ? rows : []) if (sleeperSport(r.sport)) s.add(String(r.sport).toLowerCase());
  return [...s];
}
// A player table is a few MB (CFB about 6); only the fields a line needs are kept
function slimPlayers(table) {
  const out = {};
  for (const [id, p] of Object.entries(table || {})) {
    if (!p || typeof p !== 'object') continue;
    out[id] = { first_name: p.first_name || '', last_name: p.last_name || '', team: p.team || '', ...(p.metadata?.username ? { metadata: { username: p.metadata.username } } : {}) };
  }
  return out;
}

// Sleeper lines carry no start time or match. Borrow both from a PrizePicks or
// Underdog line on the same team; without one we can't tell the match hasn't
// started, so the line is left out.
function attachMatches(slLines, refLines, teamsMatch, sportKey, now = Date.now()) {
  // the team's next match first, when it plays more than one
  const refs = refLines.filter(r => r.team && r.startTime && Date.parse(r.startTime) > now)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const out = [];
  for (const l of slLines) {
    if (!l.team) continue;
    const ref = refs.find(r => sportKey(r.sport) === sportKey(l.sport) && teamsMatch(r.team, l.team));
    if (!ref) continue;
    out.push({ ...l, team: ref.team, startTime: ref.startTime, matchTitle: ref.matchTitle || '' });
  }
  return out;
}

// One Sleeper leg: EV at its own decimal multiplier, with the same sanity check
// as Underdog (withheld only when our chance sits far ABOVE Sleeper's). When both sides are open the vig comes out before comparing our
// probability with Sleeper's.
const MAX_GAP = 0.10;
function sleeperPricing(prob, mult, otherMult) {
  const p = prob > 1 ? prob / 100 : prob;
  const raw = 1 / mult;
  const implied = otherMult ? raw / (raw + 1 / otherMult) : raw;
  const gap = p - implied;
  const flag = gap > MAX_GAP ? 'price-mismatch' : null;
  return { ev: flag ? null : (p * mult - 1) * 100, implied: implied * 100, flag, gap: gap * 100 };
}


// ─── DRAFTKINGS PICK6 ────────────────────────────────────────────────────────
// pick6.draftkings.com is a React Router app: /_root.data?sport=NFL&pickGroup=ID
// answers without a login with the page's loader data as a turbo-stream (a
// flat JSON array whose objects point at other entries by index; "_N" keys
// name the key at index N). Read from GitHub's runners 2026-10-15: NFL, MLB,
// NBA, WNBA, NHL, soccer, UFC, CS, LoL and Valorant boards.
function decodeTurboStream(text) {
  const first = String(text || '').split('\n').find(l => l.startsWith('['));
  if (!first) return null;
  const arr = JSON.parse(first);
  const memo = new Map();
  const hyd = i => {
    if (typeof i !== 'number' || i < 0) return null;
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    if (v === null || typeof v !== 'object') { memo.set(i, v); return v; }
    if (Array.isArray(v)) {
      // ["D", ms] a date, ["P", id] a promise, other tagged values kept raw
      if (typeof v[0] === 'string') { const r = v[0] === 'D' ? new Date(v[1]).toISOString() : null; memo.set(i, r); return r; }
      const r = []; memo.set(i, r);
      for (const x of v) r.push(hyd(x));
      return r;
    }
    const r = {}; memo.set(i, r);
    for (const [k, x] of Object.entries(v)) r[k.startsWith('_') ? arr[+k.slice(1)] : k] = hyd(x);
    return r;
  };
  return hyd(0);
}
// The home route's loader data, from a /_root.data answer
function pick6Home(decoded) {
  const r = decoded && (decoded['routes/_homeShared'] || decoded.loaderData?.['routes/_homeShared']);
  return r ? (r.data || r) : null;
}

// Pick6's pills are its sports; season-long boards and the NFL day filters
// (NFL SUN, MNF) repeat or aren't single games
const PICK6_SKIP = /SZN|SEASON|^NFL SUN$|^MNF$|^TNF$/i;
// college basketball under the names DraftKings uses elsewhere (no Pick6 pill until the season opens, 2026-10-26)
const PICK6_SPORT = { 'PGA TOUR': 'GOLF', UFC: 'MMA', CFB: 'CFB', CBB: 'CBB', NCAAB: 'CBB', NCAAM: 'CBB', CBK: 'CBB', 'COLLEGE BASKETBALL': 'CBB' };
function pick6Sports(home) {
  const out = [];
  const seen = new Set();
  for (const p of home?.carouselPills || []) {
    const label = String(p?.label || '').trim();
    const d = p?.sportLeaguePillData;
    if (!label || !d || PICK6_SKIP.test(label) || seen.has(p.sportLeagueKey)) continue;
    seen.add(p.sportLeagueKey);
    out.push({ label, key: p.sportLeagueKey, open: d.hasPicksAvailable !== false });
  }
  return out;
}
// What Pick6 pays, from its own entry screen: { n: { correct: x } }. These are
// the guaranteed floors; a contest bonus can pay more after it settles.
function pick6Payouts(home) {
  const out = {};
  for (const pk of home?.entryDetails?.payoutPackages || []) {
    const t = {};
    for (const tier of pk.payoutTiers || []) if (tier.guaranteedMultiplier > 0) t[tier.numberOfPicksCorrect] = tier.guaranteedMultiplier;
    if (Object.keys(t).length) out[pk.pickSetSize] = t;
  }
  return out;
}

// One sport's board (every pick group read for it) → lines in the board's
// shape. Single-player cards only, the main two-sided line of each stat (the
// one-sided alt ladders and promo picks pay differently), nothing paused.
// Each side carries its own multiplier (1x, or 0.9x on the favoured side):
// the entry's payout is the table times the picks' multipliers.
function parsePick6Board(home, sportLabel) {
  const p = home?.pickCardsResponse;
  if (!p) return [];
  const sport = PICK6_SPORT[sportLabel] || sportLabel;
  const markets = p.pickSixMarketById || {}, ents = p.entityInfoByDkId || {}, comps = p.competitionById || {}, teams = p.displayTeamById || {};
  const lines = [];
  for (const card of Object.values(p.pickCardByPickableId || {})) {
    if (!card || (card.entities || []).length !== 1) continue;
    const ent = card.entities[0];
    const info = ents[ent.dkId] || {};
    const name = info.fullName || info.name;
    const comp = comps[(ent.compIds || [])[0]];
    if (!name || !comp) continue;
    const teamId = comp.entityCompByDkId?.[ent.dkId]?.teamId;
    const team = teams[teamId]?.name || '';
    for (const m of card.activePickableMarkets || []) {
      if (!m || m.isPaused || m.isLive || (m.promoPickTypeId != null && m.promoPickTypeId !== 1)) continue;
      const mk = markets[m.pickSixMarketId] || {};
      const names = mk.propositionNameById || {};
      let over = null, under = null;
      for (const s of m.activeSelections || []) {
        const word = String(names[s.statLinePropositionId] || '').toLowerCase();
        const mult = Number(s.standingsMultiplier);
        if (!(mult > 0)) continue;
        if (/more|over|higher/.test(word)) over = mult; else if (/less|under|lower/.test(word)) under = mult;
      }
      if (over == null || under == null || !Number.isFinite(Number(m.targetValue))) continue;
      // esports stats are per map span: "Kills" over "Maps 1-2" reads as PrizePicks' "MAPS 1-2 Kills"
      const span = comp.totalCompTime ? String(comp.totalCompTime).toUpperCase() : '';
      lines.push({ book: 'pick6', sport, player: name, team, market: span ? `${span} ${mk.name || ''}`.trim() : (mk.name || ''), line: Number(m.targetValue),
        startTime: comp.startTime ? new Date(comp.startTime).toISOString() : '', matchTitle: comp.name || '', gameId: comp.compId || null,
        overMultiplier: over, underMultiplier: under, overOpen: true, underOpen: true, p6Market: m.pickableMarketKey || null });
    }
  }
  return lines;
}

// Pick6's promo picks and alternate lines (promos.js prices them), from the
// same cards parsePick6Board reads: promoPickTypeId 2 Gimme Pick, 3 Stat Slice
// (a cut line), 4 Power Up (a boosted multiplier), each one per entry with a
// minimum number of picks (promotionalPickConfigurationsByPromotionTypeId);
// and the one-sided alt ladders (type 1 with one selection, 0.5x on a lower
// line and the like). Every side carries its own multiplier.
const PICK6_PROMO = { 2: 'gimme', 3: 'stat slice', 4: 'power up' };
function parsePick6Promos(home, sportLabel) {
  const p = home?.pickCardsResponse;
  if (!p) return [];
  const sport = PICK6_SPORT[sportLabel] || sportLabel;
  const markets = p.pickSixMarketById || {}, ents = p.entityInfoByDkId || {}, comps = p.competitionById || {}, teams = p.displayTeamById || {};
  const conf = p.promotionalPickConfigurationsByPromotionTypeId || {};
  const out = [];
  for (const card of Object.values(p.pickCardByPickableId || {})) {
    if (!card || (card.entities || []).length !== 1) continue;
    const ent = card.entities[0];
    const info = ents[ent.dkId] || {};
    const name = info.fullName || info.name;
    const comp = comps[(ent.compIds || [])[0]];
    if (!name || !comp) continue;
    const team = teams[comp.entityCompByDkId?.[ent.dkId]?.teamId]?.name || '';
    for (const m of card.activePickableMarkets || []) {
      if (!m || m.isPaused || m.isLive || !Number.isFinite(Number(m.targetValue))) continue;
      const sels = (m.activeSelections || []).filter(s => Number(s?.standingsMultiplier) > 0);
      const promoId = m.promoPickTypeId ?? 1;
      const type = promoId !== 1 ? (PICK6_PROMO[promoId] || String(conf[promoId]?.promotionalPickType || `promo ${promoId}`).toLowerCase()) : sels.length === 1 ? 'alt' : null;
      if (!type) continue;
      const mk = markets[m.pickSixMarketId] || {};
      const names = mk.propositionNameById || {};
      const span = comp.totalCompTime ? String(comp.totalCompTime).toUpperCase() : '';
      const c = conf[promoId];
      const note = c ? [c.maxNumberOfPromotionalPicks ? `${c.maxNumberOfPromotionalPicks} per entry` : '', c.minimumRequiredNumOfPicks ? `${c.minimumRequiredNumOfPicks}+ picks` : ''].filter(Boolean).join(', ') : null;
      for (const s of sels) {
        const word = String(names[s.statLinePropositionId] || '').toLowerCase();
        const side = /more|over|higher/.test(word) ? 'Over' : /less|under|lower/.test(word) ? 'Under' : null;
        if (!side) continue;
        out.push({ book: 'pick6', type, side, mult: Number(s.standingsMultiplier), line: Number(m.targetValue), baseLine: null, sport, player: name, team,
          market: span ? `${span} ${mk.name || ''}`.trim() : (mk.name || ''), startTime: comp.startTime ? new Date(comp.startTime).toISOString() : '',
          matchTitle: comp.name || '', gameId: comp.compId || null, note: note || null, p6Market: m.pickableMarketKey || null });
      }
    }
  }
  return out;
}

module.exports = { parsePick6Promos, parsePrizePicksPromos, parseSleeperPromos, normalSleeperLine, decodeTurboStream, pick6Home, pick6Sports, pick6Payouts, parsePick6Board, parsePrizePicksPayload, parseSleeperLines, sleeperSportKeys, sleeperSport, sleeperSportMarket, slimPlayers, sleeperMarket, attachMatches, sleeperPricing, SLEEPER_ESPORTS };
