const axios = require(require.resolve('axios', { paths: [process.cwd()] }));
const esboard = require(process.cwd() + '/esboard');
const D = require(process.cwd() + '/esmatchupdata');
const R = require(process.cwd() + '/ratings');
(async () => {
  const board = esboard.createEsportsBoard({ http: axios, ratings: () => ({}), log: { log: () => {} } });
  await board.scan().catch(e => console.error('board', e.message));
  const raw = {};
  const t0 = Date.now();
  try { raw.CS = { games: await R.fetchBo3Games(axios), at: Date.now() }; } catch (e) { console.error('bo3', e.message); }
  try { raw.VAL = { games: await R.fetchVlrGames(axios), at: Date.now() }; } catch (e) { console.error('vlr', e.message); }
  const out = { at: new Date().toISOString(), fetchMs: Date.now() - t0, rawGames: { CS: raw.CS?.games.length, VAL: raw.VAL?.games.length }, boardCounts: board.state.counts, games: {} };
  for (const [game, rk] of [['CS2', 'CS'], ['VAL', 'VAL']]) {
    const E = D.createMatchupEngine({ game, http: axios, board: () => board.state.matches, results: () => raw[rk] || null, log: console });
    await E.refresh();
    const list = E.list({ days: 8 });
    const boardN = board.state.matches.filter(m => m.game === game && (m.markets || []).some(k => k.kind === 'match')).length;
    out.games[game] = { status: E.status(), boardMatches: boardN, count: list.length, priced: list.filter(m => m.model.priced).length,
      withKalshi: list.filter(m => m.markets.kalshi).length, withPmus: list.filter(m => m.markets.pmus).length, both: list.filter(m => m.markets.kalshi && m.markets.pmus).length,
      rows: list.map(m => ({ t: m.start, teams: m.teams.map(x => x.name), conf: m.model.confidence, model: m.model.win ?? null, k: m.markets.kalshi?.prob ?? null, pm: m.markets.pmus?.prob ?? null, pmUrl: m.markets.pmus?.url || null, src: m.league })) };
  }
  console.log(JSON.stringify(out));
})().catch(e => { console.error(e); process.exit(1); });
