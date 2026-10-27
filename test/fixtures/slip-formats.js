// Slip and export shapes taken from public pages, one per source, for the
// MY SLIPS paste reader and importer tests. TEST DATA ONLY: never shown as
// anyone's real bets. Where the page gives no player name (Sleeper's promo
// cards print "CIN1"), a made-up name stands in; every other piece (the
// labels, the line order, the stat names, the field names) is as the page
// shows it. Checked 2026-10-27.
//
// Not found in public (so not here, and their importers are unchanged):
// Pikkit's CSV columns, Juice Reel's and Bettor IQ's exports, any CSV from
// PrizePicks, Underdog or Sleeper, and the text of a copied or shared lineup
// from any of the apps (their share sends a link, not the picks).

module.exports = {
  // https://www.prizepicks.com/resources/how-to-play-prizepicks
  // The sample pick card: player, "PHX vs LAL" "Sat 8:30pm", the label
  // "Player Pick", the line, the stat, and the two sides "Less" and "More".
  prizepicksCard: {
    source: 'https://www.prizepicks.com/resources/how-to-play-prizepicks',
    picked: 'Devin Booker\nPHX vs LAL Sat 8:30pm\nPlayer Pick\n21.5\nPoints\nMore',
    // copied off the board: both sides are on the card, so the pick is unknown
    bothSides: 'Devin Booker\nPHX vs LAL Sat 8:30pm\nPlayer Pick\n21.5\nPoints\nLess\nMore',
  },
  // https://www.prizepicks.com/playbook-article/how-to-play-prizepicks-nba-fantasy-scoring-system
  // NBA stat type names as the board prints them
  prizepicksNbaStats: {
    source: 'https://www.prizepicks.com/playbook-article/how-to-play-prizepicks-nba-fantasy-scoring-system',
    stats: ['Points', 'Rebounds', 'Assists', '3-PT Made', 'Blocked Shots', 'Steals', 'Turnovers', 'Pts+Rebs', 'Pts+Asts', 'Rebs+Asts', 'Blks+Stls', 'Pts+Rebs+Asts'],
  },
  // https://sleeper.com/picks
  // Promo cards: "QB•DAL" / "vs New York" / "1.5" / "Pass TDs",
  // "RB•SF" / "vs Los Angeles" / "39.5" / "Rec Yds", "WR•CIN" / "vs Tampa
  // Bay" / "0.5" / "Anytime TDs"; the sides are "more or less".
  sleeperCards: {
    source: 'https://sleeper.com/picks',
    text: 'Sleeper\nPat Quarterback\nQB•DAL\nvs New York\n1.5\nPass TDs\nmore\nRay Runner\nRB•SF\nvs Los Angeles\n39.5\nRec Yds\nless\nWill Receiver\nWR•CIN\nvs Tampa Bay\n0.5\nAnytime TDs\nmore',
  },
  // https://docs.sharpsports.io/reference/betslip and /reference/bet
  // The bet-sync feed several trackers build on: field names timePlaced,
  // type (single/parlay), oddsAmerican, status (completed/pending), outcome
  // (win/loss/push/void/cashout/halfwin/halfloss), bookDescription
  // (verbatim example "Miami Dolphins at Kansas City Chiefs - Spread - Miami
  // Dolphins +4.5"), and per bet player, metricSpecial, position, line.
  // Flattened to one row per bet as a tracker would write it. Money fields
  // (atRisk, toWin, netProfit) are cents in that feed and are left out: a
  // file's units can't be told from its header.
  sharpsportsCsv: {
    source: 'https://docs.sharpsports.io/reference/bet',
    rowsPerBet: `id,timePlaced,type,oddsAmerican,status,outcome,bookDescription
SLIP_1,2024-07-01T23:44:35Z,single,-105,completed,loss,Miami Dolphins at Kansas City Chiefs - Spread - Miami Dolphins +4.5
SLIP_2,2026-10-25T17:00:00Z,single,-115,completed,halfwin,Josh Allen Over 245.5 Pass Yds
SLIP_3,2026-10-26T17:00:00Z,single,+100,pending,,Bo Nix Under 220.5 Pass Yds`,
    rowsPerLeg: `id,timePlaced,type,status,outcome,player,metricSpecial,position,line
SLIP_4,2026-10-25T17:00:00Z,parlay,completed,win,Josh Allen,Passing Yards,Over,245.5
SLIP_4,2026-10-25T17:00:00Z,parlay,completed,win,James Cook,Rushing Yards,Under,62.5
SLIP_5,2026-10-25T20:00:00Z,parlay,completed,loss,Bo Nix,Passing Yards,Denver Broncos,220.5`,
  },
  // what a shared lineup pastes as: a link with no picks in it
  shareLink: 'Check out my lineup on PrizePicks! https://prizepicks.onelink.me/abc123',
};
