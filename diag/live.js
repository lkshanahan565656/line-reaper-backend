const axios = require(require.resolve('axios', { paths: [process.cwd()] }));
const esboard = require(process.cwd() + '/esboard');
const D = require(process.cwd() + '/esmatchupdata');
(async () => {
  const board = esboard.createEsportsBoard({ http: axios, ratings: () => ({}), log: { log: () => {} } });
  await board.scan().catch(e => console.error('board', e.message));
  const E = D.createMatchupEngine({ http: axios, board: () => board.state.matches, log: console });
  await E.refresh();
  const list = E.list({ days: 8 });
  const lolBoard = board.state.matches.filter(m => m.game === 'LOL').map(m => ({ teams: m.teams, start: m.start }));
  console.log(JSON.stringify({ at: new Date().toISOString(), status: E.status(), boardCounts: board.state.counts, boardErrors: board.state.errors, lolBoard,
    count: list.length, priced: list.filter(m => m.model.priced).length, withKalshi: list.filter(m => m.compare).length,
    unpairedKalshi: lolBoard.filter(b => !list.some(m => m.markets.paired && m.markets.paired.start === b.start && m.markets.paired.teams.join() === b.teams.join())),
    matchups: list }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
