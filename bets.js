// ─── MY BETS: PERSONAL BET TRACKER ────────────────────────────────────────────
// The math behind the MY BETS tab: a user's own bets, logged by hand or in one
// tap from a play in the app, with profit, ROI, record, CLV and breakdowns by
// tool, book, sport and month, plus CSV export and import.
//
// The bets live in the user's browser (localStorage), never on the server: the
// stake is the user's business. The signals stay the same for everyone; this
// only records what one user chose to bet.
//
// Bets the app tracks itself (a Sharp Tail signal, an esports prop) carry a
// `track` reference. The server answers POST /api/bets/settle with what its own
// graders found (matchTracked below), so those bets settle on their own.
//
// Pure functions, no I/O. The same file runs in Node (tests, server) and in the
// browser (served at /bets.js, exposed as window.LRBets, after /calc.js).
//
// Every price is DECIMAL odds (total return per $1, stake included). Money is
// in dollars; units are dollars over the unit value the user had when logging.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./calc'));
  else root.LRBets = factory(root.LRCalc);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  const ok = x => typeof x === 'number' && Number.isFinite(x);
  const okDec = d => ok(d) && d > 1;
  const r2 = x => Math.round(x * 100) / 100;
  const r4 = x => Math.round(x * 1e4) / 1e4;
  const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return ok(n) ? n : null; };

  const RESULTS = ['open', 'win', 'loss', 'push', 'void', 'half_win', 'half_loss', 'cashout'];
  const RESULT_LABEL = { open: 'Open', win: 'Won', loss: 'Lost', push: 'Push', void: 'Void', half_win: 'Half won', half_loss: 'Half lost', cashout: 'Cashed out' };
  // which of our tools a bet came from; Manual is anything typed in
  const TOOLS = ['Manual', 'Sharp Tail', 'Best Plays', 'Esports edge', 'Esports prop', 'Esports slip', 'Sports prop', 'Arb', '+EV'];
  const KIND_TOOL = { tail: 'Sharp Tail', esportsEdge: 'Esports edge', esportsProp: 'Esports prop', sportsProp: 'Sports prop', arb: 'Arb' };

  const isSettled = b => b.result !== 'open';
  let seq = 0;
  const newId = (t = Date.now()) => `b${t.toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
  const iso = v => { const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v); return ok(t) ? new Date(t).toISOString() : null; };

  // ── a bet ──
  // Fill in a bet from loose input. → the bet, or { error } when it can't be
  // priced. odds: anything calc.parseOdds reads (+150, -110, 2.5, 57c, 0.57).
  function make(input = {}, { now = Date.now(), unitUsd = null } = {}) {
    const odds = okDec(input.odds) ? input.odds : C.parseOdds(input.odds == null ? '' : String(input.odds));
    if (!odds) return { error: 'Enter the odds you got: +150, -110, 2.50 or 57c' };
    const stake = num(input.stake);
    if (!(stake > 0)) return { error: 'Enter the stake in dollars' };
    const pick = String(input.pick || '').trim();
    if (!pick) return { error: 'Enter what you bet on' };
    const closeOdds = input.closeOdds == null || input.closeOdds === '' ? null
      : okDec(input.closeOdds) ? input.closeOdds : C.parseOdds(String(input.closeOdds));
    const result = RESULTS.includes(input.result) ? input.result : 'open';
    const unit = num(input.unitUsd) ?? num(unitUsd);
    const b = {
      // ids go into the page's onclick handlers: only plain ones are kept
      id: /^[\w.:-]{1,64}$/.test(String(input.id || '')) ? String(input.id) : newId(now),
      placedAt: iso(input.placedAt) || new Date(now).toISOString(),
      event: String(input.event || '').trim(),
      pick,
      sport: String(input.sport || '').trim(),
      book: String(input.book || '').trim(),
      tool: TOOLS.includes(input.tool) ? input.tool : 'Manual',
      odds: r4(odds),
      cents: /c$|¢$/i.test(String(input.odds || '').trim()) || !!input.cents,
      stake: r2(stake),
      unitUsd: unit > 0 ? unit : null,
      result,
      cashout: result === 'cashout' ? r2(num(input.cashout) ?? 0) : null,
      closeOdds: okDec(closeOdds) ? r4(closeOdds) : null,
      track: input.track && typeof input.track === 'object' ? input.track : null,
      settledAt: result === 'open' ? null : iso(input.settledAt) || new Date(now).toISOString(),
      settledBy: result === 'open' ? null : input.settledBy === 'auto' ? 'auto' : 'manual',
      notes: String(input.notes || '').trim(),
    };
    return b;
  }

  // Set a result. cashout: the dollars that came back.
  function settle(b, result, { now = Date.now(), cashout = null, by = 'manual' } = {}) {
    if (!RESULTS.includes(result)) return b;
    return { ...b, result, cashout: result === 'cashout' ? r2(num(cashout) ?? 0) : null,
      settledAt: result === 'open' ? null : new Date(now).toISOString(), settledBy: result === 'open' ? null : by };
  }

  // what a winner pays on top of the stake
  const toWin = b => r2(b.stake * (b.odds - 1));
  // profit in dollars, null while open
  function profit(b) {
    switch (b.result) {
      case 'win': return toWin(b);
      case 'loss': return -b.stake;
      case 'half_win': return r2(toWin(b) / 2);
      case 'half_loss': return r2(-b.stake / 2);
      case 'cashout': return r2((b.cashout || 0) - b.stake);
      case 'push': case 'void': return 0;
      default: return null;
    }
  }
  // closing line value: your price against the close, 0.05 = beat it by 5%
  const clv = b => (okDec(b.closeOdds) && okDec(b.odds) ? r4(b.odds / b.closeOdds - 1) : null);
  const unitsOf = (b, unitUsd) => { const u = b.unitUsd || unitUsd; return u > 0 ? u : null; };

  // ── stats ──
  // Record: half wins count as wins, half losses as losses, pushes and voids
  // as pushes. ROI is profit over the money that stayed at risk: pushes and
  // voids gave the stake back, so they don't count toward it.
  function stats(list, { unitUsd = null } = {}) {
    const settled = list.filter(isSettled);
    const open = list.filter(b => !isSettled(b));
    let w = 0, l = 0, p = 0, risked = 0, pnl = 0, pnlU = 0, uKnown = true, oddsSum = 0, oddsN = 0;
    for (const b of settled) {
      const r = b.result;
      if (r === 'win' || r === 'half_win') w++;
      else if (r === 'loss' || r === 'half_loss') l++;
      else if (r === 'push' || r === 'void') p++;
      if (r !== 'push' && r !== 'void') { risked += b.stake; oddsSum += b.odds; oddsN++; }
      const x = profit(b) || 0;
      pnl += x;
      const u = unitsOf(b, unitUsd);
      if (u) pnlU += x / u; else if (x) uKnown = false;
    }
    const clvs = list.map(clv).filter(ok);
    const series = curve(settled);
    let peak = 0, dd = 0;
    for (const pt of series) { peak = Math.max(peak, pt.pnl); dd = Math.max(dd, peak - pt.pnl); }
    // current streak, newest first, pushes skipped
    let streak = 0, streakOf = null;
    for (let i = series.length - 1; i >= 0; i--) {
      const r = series[i].result, k = r === 'win' || r === 'half_win' ? 'W' : r === 'loss' || r === 'half_loss' ? 'L' : null;
      if (!k) continue;
      if (streakOf && k !== streakOf) break;
      streakOf = k; streak++;
    }
    return {
      bets: list.length, settled: settled.length, open: open.length,
      wins: w, losses: l, pushes: p, record: `${w}-${l}${p ? `-${p}` : ''}`,
      winRate: w + l ? r4(w / (w + l)) : null,
      risked: r2(risked), profit: r2(pnl), units: uKnown ? r2(pnlU) : null,
      roi: risked > 0 ? r4(pnl / risked) : null,
      avgOdds: oddsN ? r4(oddsSum / oddsN) : null,
      clv: clvs.length ? r4(clvs.reduce((a, x) => a + x, 0) / clvs.length) : null,
      clvN: clvs.length, beatClose: clvs.length ? r4(clvs.filter(x => x > 0).length / clvs.length) : null,
      openStake: r2(open.reduce((a, b) => a + b.stake, 0)),
      openToWin: r2(open.reduce((a, b) => a + toWin(b), 0)),
      drawdown: r2(dd), streak: streakOf ? `${streakOf}${streak}` : null,
    };
  }

  // cumulative profit in settle order → [{ t, pnl, result, id }]
  function curve(list) {
    const when = b => Date.parse(b.settledAt || b.placedAt) || 0;
    let run = 0;
    return list.filter(isSettled).slice().sort((a, b) => when(a) - when(b))
      .map(b => { run += profit(b) || 0; return { t: when(b), pnl: r2(run), result: b.result, id: b.id }; });
  }

  const monthOf = b => (b.placedAt || '').slice(0, 7);
  const GROUPS = {
    tool: b => b.tool || 'Manual',
    book: b => b.book || 'Unknown',
    sport: b => b.sport || 'Other',
    month: monthOf,
  };
  // stats per group, the most bets first (months newest first)
  function breakdown(list, by = 'tool', opts = {}) {
    const key = typeof by === 'function' ? by : GROUPS[by] || GROUPS.tool;
    const m = new Map();
    for (const b of list) { const k = key(b); if (!m.has(k)) m.set(k, []); m.get(k).push(b); }
    const rows = [...m].map(([k, bs]) => ({ key: k, ...stats(bs, opts) }));
    return by === 'month' ? rows.sort((a, b) => (a.key < b.key ? 1 : -1)) : rows.sort((a, b) => b.bets - a.bets || b.profit - a.profit);
  }

  // status: open | settled | all; days: last N days by placed date; q: text
  function filter(list, { status = 'all', days = null, tool = '', book = '', sport = '', q = '', now = Date.now() } = {}) {
    const cut = days > 0 ? now - days * 86400e3 : null;
    const needle = String(q || '').trim().toLowerCase();
    return list.filter(b => (status === 'all' || (status === 'open' ? !isSettled(b) : isSettled(b)))
      && (cut == null || (Date.parse(b.placedAt) || 0) >= cut)
      && (!tool || b.tool === tool) && (!book || b.book === book) && (!sport || b.sport === sport)
      && (!needle || `${b.event} ${b.pick} ${b.book} ${b.sport} ${b.notes}`.toLowerCase().includes(needle)));
  }
  const sortNewest = list => list.slice().sort((a, b) => (Date.parse(b.placedAt) || 0) - (Date.parse(a.placedAt) || 0));

  // ── from a play in the app ──
  // A Best Plays row (bestplays.js) → the fields to prefill. Stake: the row's
  // units at the user's unit value; the alert's units are the same for
  // everyone, the dollars are the user's own.
  function fromPlay(row, { unitUsd = null } = {}) {
    let odds = null, cents = false;
    if (ok(row.american) && Math.abs(row.american) >= 100) odds = C.americanToDecimal(row.american);
    else if (ok(row.price) && row.price > 0 && row.price < 1) { odds = 1 / row.price; cents = true; }
    const stake = ok(row.units) && row.units > 0 && unitUsd > 0 ? r2(row.units * unitUsd) : null;
    return {
      event: row.title || '', pick: row.bet || '', book: row.venue || '', sport: row.sport || sportOf(row),
      tool: KIND_TOOL[row.kind] || 'Best Plays', odds: odds ? r4(odds) : null, cents, stake, units: row.units ?? null,
      track: row.track || (row.kind === 'tail' && /^tail:/.test(row.id || '') ? { kind: 'tail', id: row.id.slice(5) } : null),
    };
  }
  function sportOf(row) {
    const l = String(row.label || '');
    if (/prop|edge|arb/i.test(l) && !/^exchange/i.test(l)) return l.replace(/\s*(match )?(prop|edge|arb)$/i, '').trim();
    return row.category ? row.category.charAt(0).toUpperCase() + row.category.slice(1) : '';
  }

  // ── auto-settle (server side) ──
  // bets: [{ id, track }]; tail: tail tracker records; picks: esports pick
  // tracker rows. → { [bet id]: { result?, closeOdds?, note } } for the bets
  // the trackers know something about. The result is what happened to the
  // outcome; the user's own price and stake decide their profit.
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function matchTracked(bets, { tail = [], picks = [], sportKey = s => String(s || '').toUpperCase(), outcomeFor } = {}) {
    const out = {};
    // a top-up signal joined its first bet's record
    const tailById = new Map();
    for (const r of tail) { tailById.set(String(r.id), r); for (const t of r.topUps || []) tailById.set(String(t), r); }
    for (const { id, track: t } of bets) {
      if (!id || !t || typeof t !== 'object') continue;
      if (t.kind === 'tail') {
        const rec = tailById.get(String(t.id));
        if (!rec) continue;
        const res = {};
        if (rec.closePrice > 0 && rec.closePrice < 1 && rec.clv != null) res.closeOdds = r4(1 / rec.closePrice);
        if (rec.status === 'settled' && ['win', 'loss', 'void'].includes(rec.result)) res.result = rec.result;
        if (Object.keys(res).length) out[id] = { ...res, note: 'Sharp Tail tracker' };
      } else if (t.kind === 'prop' && outcomeFor) {
        const line = num(t.line), side = /^(over|more)/i.test(t.side) ? 'OVER' : /^(under|less)/i.test(t.side) ? 'UNDER' : null;
        const start = Date.parse(t.startsAt);
        if (line == null || !side || !ok(start)) continue;
        const row = picks.find(r => sportKey(r.sport) === sportKey(t.sport) && norm(r.player) === norm(t.player)
          && String(r.market || '').toLowerCase() === String(t.market || '').toLowerCase()
          && Math.abs((Date.parse(r.startTime) || 0) - start) < 36 * 3600e3);
        if (!row) continue;
        if (row.status === 'void') out[id] = { result: 'void', note: 'Esports pick tracker' };
        else if (row.status === 'graded' && ok(row.result)) {
          const r = outcomeFor(side, line, row.result);
          if (r) out[id] = { result: r, note: `Esports pick tracker: ${row.result} ${row.stat || ''}`.trim() };
        }
      }
    }
    return out;
  }

  // Apply the server's answer. Only open bets settled by nobody yet change;
  // a close fills in whenever the bet has none. → { list, changed }
  function applyTracked(list, results, { now = Date.now() } = {}) {
    let changed = 0;
    const next = list.map(b => {
      const r = results && results[b.id];
      if (!r) return b;
      let x = b;
      if (r.closeOdds && !b.closeOdds) x = { ...x, closeOdds: r.closeOdds };
      if (r.result && b.result === 'open') x = settle(x, r.result, { now, by: 'auto' });
      if (x !== b) changed++;
      return x;
    });
    return { list: next, changed };
  }

  // ── storage migration ──
  // The old BET LOG kept { id: ms, pick, odds: American, stake, sport, book,
  // myOdds, closeOdds: American, result: pending|win|loss, date } under ww_bets.
  function migrate(old = []) {
    const out = [];
    for (const o of Array.isArray(old) ? old : []) {
      if (!o || typeof o !== 'object') continue;
      if (o.placedAt && okDec(o.odds)) { out.push(o); continue; }   // already new
      const am = num(o.odds), close = num(o.closeOdds);
      const b = make({
        id: `old${o.id ?? out.length}`, pick: o.pick, stake: o.stake, sport: o.sport, book: o.book,
        odds: am != null ? C.americanToDecimal(am) : null,
        closeOdds: close != null ? C.americanToDecimal(close) : null,
        placedAt: ok(o.id) && o.id > 1e12 ? o.id : Date.parse(o.date) || Date.now(),
        result: o.result === 'win' || o.result === 'loss' ? o.result : 'open',
        tool: o.sport === 'Esports' && /-leg /.test(o.pick || '') ? 'Esports slip' : 'Manual',
      });
      if (!b.error) out.push(b);
    }
    return out;
  }

  // ── CSV ──
  const COLS = ['Date', 'Event', 'Pick', 'Sport', 'Book', 'Tool', 'Odds', 'Decimal', 'Stake', 'Units', 'Result', 'Profit', 'Close', 'CLV %', 'Settled', 'Notes', 'Id'];
  // a cell a spreadsheet won't run as a formula
  function cell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=@\t\r]/.test(s) || /^[+-][^\d.]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCSV(list, { unitUsd = null } = {}) {
    const rows = sortNewest(list).map(b => {
      const u = unitsOf(b, unitUsd), p = profit(b), c = clv(b);
      return [b.placedAt, b.event, b.pick, b.sport, b.book, b.tool, C.fmtAmerican(b.odds), b.odds, b.stake.toFixed(2),
        u ? r2(b.stake / u) : '', RESULT_LABEL[b.result] || b.result, p == null ? '' : p.toFixed(2),
        b.closeOdds ? C.fmtAmerican(b.closeOdds) : '', c == null ? '' : (c * 100).toFixed(2), b.settledAt || '', b.notes, b.id];
    });
    return [COLS, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], f = '', q = false;
    const s = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += ch;
      } else if (ch === '"' && f === '') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(f); f = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = [];
      } else f += ch;
    }
    row.push(f); if (row.some(x => x.trim() !== '')) rows.push(row);
    return rows;
  }

  // header names other trackers use, lower-cased with spaces and symbols gone
  const HEAD = {
    placedAt: ['date', 'placed', 'placedat', 'dateplaced', 'time', 'betdate', 'createdat'],
    event: ['event', 'game', 'match', 'matchup', 'description', 'eventname'],
    pick: ['pick', 'selection', 'bet', 'betname', 'wager', 'market', 'play', 'name'],
    sport: ['sport', 'league'],
    book: ['book', 'sportsbook', 'bookmaker', 'site', 'venue'],
    tool: ['tool', 'source'],
    odds: ['odds', 'americanodds', 'price', 'decimal', 'decimalodds'],
    stake: ['stake', 'risk', 'risked', 'riskamount', 'amount', 'wagered', 'betamount', 'wageramount', 'stakeamount'],
    result: ['result', 'status', 'outcome', 'grade'],
    profit: ['profit', 'pnl', 'pl', 'net', 'netprofit', 'profitloss'],
    closeOdds: ['close', 'closeodds', 'closingodds', 'closingline', 'clvodds'],
    settledAt: ['settled', 'settledat', 'datesettled'],
    notes: ['notes', 'note', 'comment', 'tags'],
    id: ['id', 'betid'],
  };
  function readResult(v, p) {
    const s = String(v || '').trim().toLowerCase().replace(/[^a-z ]/g, '');
    if (/^(w|won|win|winner|hit)$/.test(s)) return 'win';
    if (/^(l|lost|loss|lose|loser|miss)$/.test(s)) return 'loss';
    if (/^(p|push|pushed|tie|draw)$/.test(s)) return 'push';
    if (/^(void|voided|cancel+ed|refund(ed)?|no action|dnp)$/.test(s)) return 'void';
    if (/^half ?won?$/.test(s)) return 'half_win';
    if (/^half ?lost?$/.test(s)) return 'half_loss';
    if (/cash/.test(s)) return 'cashout';
    if (/^(open|pending|unsettled|live|active|)$/.test(s)) {
      // no result column: a profit says how it went
      if (p != null && s === '') return p > 0 ? 'win' : p < 0 ? 'loss' : 'open';
      return 'open';
    }
    return null;
  }
  // → { bets, skipped: [{ line, why }] }
  function fromCSV(text, { now = Date.now(), unitUsd = null } = {}) {
    const rows = parseCSV(text);
    if (rows.length < 2) return { bets: [], skipped: [{ line: 1, why: 'No rows under the header' }] };
    const head = rows[0].map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
    const at = {};
    for (const [k, names] of Object.entries(HEAD)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) at[k] = i; }
    // our own export has both Odds (American) and Decimal; prefer Decimal
    const dec = head.indexOf('decimal');
    if (dec >= 0) at.odds = dec;
    const bets = [], skipped = [];
    rows.slice(1).forEach((r, i) => {
      const get = k => (at[k] == null ? '' : String(r[at[k]] ?? '').replace(/^'(?=[=@+\-\t\r])/, '').trim());
      const p = num(get('profit'));
      const result = readResult(get('result'), p);
      if (!result) { skipped.push({ line: i + 2, why: `Unknown result "${get('result')}"` }); return; }
      const stake = num(get('stake'));
      const b = make({
        id: get('id') || undefined, placedAt: get('placedAt') || now, event: get('event'), pick: get('pick') || get('event'),
        sport: get('sport'), book: get('book'), tool: get('tool'), odds: get('odds'), stake, closeOdds: get('closeOdds') || null,
        result, cashout: result === 'cashout' && p != null && stake != null ? stake + p : null,
        settledAt: get('settledAt') || undefined, notes: get('notes'),
      }, { now, unitUsd });
      if (b.error) skipped.push({ line: i + 2, why: b.error });
      else bets.push(b);
    });
    return { bets, skipped };
  }
  // add imported bets, skipping ids already there → { list, added }
  function merge(list, incoming) {
    const have = new Set(list.map(b => b.id));
    const add = incoming.filter(b => !have.has(b.id));
    return { list: sortNewest([...list, ...add]), added: add.length };
  }

  return { RESULTS, RESULT_LABEL, TOOLS, KIND_TOOL, make, settle, toWin, profit, clv, stats, curve, breakdown, filter,
    sortNewest, fromPlay, matchTracked, applyTracked, migrate, toCSV, parseCSV, fromCSV, merge, isSettled };
}));
