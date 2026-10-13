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
    if (/combo/i.test(attr.stat_type || '') || attr.event_type === 'combo') continue;
    if (attr.status && attr.status !== 'pre_game') continue;
    const player = players[proj.relationships?.new_player?.data?.id] || {};
    if (!player.name) continue;   // a line we can't name can't be matched or graded
    const leagueId = proj.relationships?.league?.data?.id;
    const sport = leagues[leagueId] || player.league || attr.league || '';
    lines.push({ book: 'prizepicks', sport, leagueId: leagueId || null, player: player.name, team: player.team || '', market: attr.stat_type || '',
      line: parseFloat(attr.line_score), startTime: attr.start_time || '', matchTitle: attr.description || '', gameId: attr.game_id || null });
  }
  return { lines, leagues };
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

// rows: /lines/available. players: { sport: { id: player } } from /players/{sport}.
// Each side's payout_multiplier is that leg's own multiplier (an entry pays
// their product), so it's a decimal price: 1.48 Over vs 2.19 Under says Sleeper
// sees the over near 60%.
function parseSleeperLines(rows, players = {}) {
  const lines = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const sport = SLEEPER_ESPORTS[String(row.sport || '').toLowerCase()];
    if (!sport || row.subject_type !== 'player' || row.outcome_type !== 'over_under') continue;
    if (row.status && row.status !== 'active') continue;
    if (row.game_status && row.game_status !== 'pre_game') continue;
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
    const p = (players[String(row.sport).toLowerCase()] || {})[row.subject_id] || {};
    const name = p.metadata?.username || p.username || [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (!name) continue;
    lines.push({
      book: 'sleeper', sport, player: name, team: team || p.team || '', market: sleeperMarket(row.wager_type), line,
      gameId: row.game_id || null, startTime: '', matchTitle: '',
      overMultiplier: over, underMultiplier: under, overOpen: over != null, underOpen: under != null,
    });
  }
  return lines;
}

// Esports sports Sleeper lists, for fetching only the player tables needed
function sleeperEsportsKeys(rows) {
  const s = new Set();
  for (const r of Array.isArray(rows) ? rows : []) if (SLEEPER_ESPORTS[String(r.sport || '').toLowerCase()]) s.add(String(r.sport).toLowerCase());
  return [...s];
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
// as Underdog. When both sides are open the vig comes out before comparing our
// probability with Sleeper's.
const MAX_GAP = 0.10;
function sleeperPricing(prob, mult, otherMult) {
  const p = prob > 1 ? prob / 100 : prob;
  const raw = 1 / mult;
  const implied = otherMult ? raw / (raw + 1 / otherMult) : raw;
  const gap = p - implied;
  const flag = Math.abs(gap) > MAX_GAP ? 'price-mismatch' : null;
  return { ev: flag ? null : (p * mult - 1) * 100, implied: implied * 100, flag, gap: gap * 100 };
}

module.exports = { parsePrizePicksPayload, parseSleeperLines, sleeperEsportsKeys, sleeperMarket, attachMatches, sleeperPricing, SLEEPER_ESPORTS };
