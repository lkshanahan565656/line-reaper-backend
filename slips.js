// ─── MY SLIPS: THE USER'S OWN PICK'EM SLIPS, LEG BY LEG AGAINST THE CLOSE ────
// A slip is pasted as plain text (or comes in from a Pikkit CSV export) and
// every leg goes to POST /api/slips/grade, which follows it to the start the
// way the props record follows its own plays (sliplog.js): the sharp fair at
// the leg's own line when we first saw it and at the close, the app's line at
// the close, and the box score once the game is final.
//
// The slips live in the user's browser (localStorage), never on the server:
// stakes and payouts stay the user's business. The server only sees legs
// (player, stat, line, side, app, start), the same for everyone.
//
// Pure functions, no I/O. The same file runs in Node (tests, server) and in the
// browser (served at /slips.js, exposed as window.LRSlips).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LRSlips = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ok = x => typeof x === 'number' && Number.isFinite(x);
  const r2 = x => Math.round(x * 100) / 100;
  const r4 = x => Math.round(x * 1e4) / 1e4;
  const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return ok(n) ? n : null; };

  // ── apps ──
  const APPS = {
    prizepicks: { label: 'PrizePicks', re: /\b(prize\s*picks|pp)\b/i },
    underdog: { label: 'Underdog', re: /\b(underdog( fantasy)?|ud)\b/i },
    sleeper: { label: 'Sleeper', re: /\bsleeper\b/i },
    pick6: { label: 'DK Pick6', re: /\b(pick\s*6|dk\s*pick\s*6|draft\s*kings\s*pick|dk)\b/i },
    betr: { label: 'Betr', re: /\bbetr\b/i },
    chalkboard: { label: 'Chalkboard', re: /\bchalk\s*board\b/i },
  };
  function appOf(text) {
    for (const [k, a] of Object.entries(APPS)) if (a.re.test(String(text || ''))) return k;
    return null;
  }
  const appLabel = k => APPS[k]?.label || (k ? String(k) : 'Other');

  // What a leg pays per unit at the app's own break-even, as decimal odds:
  // the price a leg's close is scored at (as sporttrack.legDecimal does for
  // the props record). Betr pays like PrizePicks; Chalkboard posts no table.
  const LEG_BE = { prizepicks: 0.5622, underdog: 0.5623, pick6: 0.5503, sleeper: 1 / 1.78, betr: 0.5622, chalkboard: 0.5622 };
  const legDecimal = app => r4(1 / (LEG_BE[app] || 0.5622));

  // Every leg hit: the app's top multiplier. Mirrors slip.js (PAYOUTS,
  // PICK6_PAYOUTS; a test keeps them equal). Betr pays like PrizePicks.
  const POWER = {
    prizepicks: { 2: 3, 3: 6, 4: 10, 5: 20, 6: 37.5 },
    underdog: { 2: 3.5, 3: 6.5, 4: 12, 5: 20, 6: 35 },
    pick6: { 2: 3, 3: 6, 4: 10, 5: 12, 6: 25, 7: 40, 8: 80 },
    betr: { 2: 3, 3: 6, 4: 10, 5: 20, 6: 37.5 },
  };
  const FLEX = {
    prizepicks: { 3: { 3: 3, 2: 1 }, 4: { 4: 6, 3: 1.5 }, 5: { 5: 10, 4: 2, 3: 0.4 }, 6: { 6: 25, 5: 2, 4: 0.4 } },
    underdog: { 3: { 3: 3.25, 2: 1.09 }, 4: { 4: 6, 3: 1.4 }, 5: { 5: 10, 4: 2.5 }, 6: { 6: 25, 5: 2.6, 4: 0.25 } },
  };
  // the slip's payout table { hits: multiple }: the user's own payout when the
  // slip says one (a power play), else the app's table
  function payTable(slip) {
    const n = (slip.legs || []).length;
    if (slip.stake > 0 && slip.payout > 0 && !slip.flex) return { [n]: r4(slip.payout / slip.stake) };
    if (slip.mult > 0 && !slip.flex) return { [n]: slip.mult };
    if (slip.flex && FLEX[slip.app]?.[n]) return FLEX[slip.app][n];
    const p = POWER[slip.app]?.[n];
    return p ? { [n]: p } : null;
  }

  // ── same-game repricing ──
  // The apps pay less for picks from one game (Underdog reprices them,
  // PrizePicks says it lowers them). The estimate: the standard payout x
  // P(all hit if independent) / P(all hit with the link), the "If repriced"
  // figure of the stack cards. The link between two legs is the measured phi
  // at 50/50 legs (both More; an Under flips its sign):
  //   sports, checks/corr-pairs-2026-10-24 (19,600 ESPN box scores, J50 vs .25):
  //     QB pass yds or completions + his own receiver's yds or catches .28,
  //     the other team's receiver .09; QB + the other QB .06; NHL teammates'
  //     points .23; MLB teammates' H+R+RBI .12, a starter's earned runs + the
  //     other team's hitter .24. NBA pairs, two receivers, NHL shots: about 0.
  //   esports, slip.js FACTORS (fitted series): kills teammates CS .21 / LoL
  //     .23 / Dota .16 / Val .22, opponents .12 / -.06 / -.06 / .07; assists
  //     teammates .50, opponents -.12 (LoL, Dota).
  // A pair whose team relation is unknown (a pasted leg names no team) gets no
  // link, so the estimate is the standard payout and says so.
  const statClass = (sport, market) => {
    const m = String(market || '').toLowerCase(), sp = String(sport || '').toUpperCase();
    if (/kill/.test(m)) return 'kills';
    if (/assist/.test(m) && ['CS', 'LOL', 'DOTA', 'VAL'].includes(sp)) return 'assists';
    if (/pass(ing)?\s*(yd|yard)|pass yds/.test(m) || /complet/.test(m)) return 'qb';
    if (/rec(eiving)?\s*(yd|yard)|reception|receiving/.test(m)) return 'wr';
    if (sp === 'NHL' && /^points?$/.test(m.trim())) return 'nhlpts';
    if (/h\s*\+\s*r\s*\+\s*rbi|hits\s*\+\s*runs/.test(m)) return 'hrr';
    if (/earned runs/.test(m)) return 'er';
    return null;
  };
  const ES_LINK = { CS: { kills: [0.21, 0.12] }, LOL: { kills: [0.23, -0.06], assists: [0.5, -0.12] }, DOTA: { kills: [0.16, -0.06], assists: [0.5, -0.12] }, VAL: { kills: [0.22, 0.07] } };
  // phi between two legs of one game, or 0
  function pairLink(a, b) {
    if (!a.team || !b.team) return 0;
    const same = a.team.toLowerCase() === b.team.toLowerCase();
    const sp = String(a.sport || b.sport || '').toUpperCase(), ca = statClass(sp, a.market), cb = statClass(sp, b.market);
    if (!ca || !cb) return 0;
    let phi = 0;
    if (ES_LINK[sp] && ca === cb && ES_LINK[sp][ca]) phi = ES_LINK[sp][ca][same ? 0 : 1];
    else if (['NFL', 'CFB'].includes(sp)) {
      const k = [ca, cb].sort().join('+');
      if (k === 'qb+wr') phi = same ? 0.28 : 0.09;
      else if (k === 'qb+qb' && !same) phi = 0.06;
    } else if (sp === 'NHL' && ca === 'nhlpts' && cb === 'nhlpts' && same) phi = 0.23;
    else if (sp === 'MLB') {
      if (ca === 'hrr' && cb === 'hrr' && same) phi = 0.12;
      else if ([ca, cb].sort().join('+') === 'er+hrr' && !same) phi = 0.24;
    }
    const sign = (a.side === 'Under' ? -1 : 1) * (b.side === 'Under' ? -1 : 1);
    return phi * sign;
  }
  // P(every leg hits) with pairwise links (second-order Bahadur; exact for two legs)
  function pAllLinked(legs, probs) {
    let p = probs.reduce((a, x) => a * x, 1), f = 1;
    for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
      const r = pairLink(legs[i], legs[j]);
      if (r) f += r * Math.sqrt(((1 - probs[i]) * (1 - probs[j])) / (probs[i] * probs[j]));
    }
    return Math.min(Math.min(...probs), Math.max(1e-6, p * f));
  }
  // legs: [{ sport, market, side, team, game, prob? }] (prob: the fair, else
  // the app's break-even); standard: the table's top multiple
  // → { mult, standard, linked (pairs with a measured link), ratio } | null
  function repriced(legs, standard, app = 'prizepicks') {
    if (!(standard > 0) || !Array.isArray(legs) || legs.length < 2) return null;
    const probs = legs.map(l => (l.prob > 0 && l.prob < 1 ? l.prob : LEG_BE[app] || 0.5622));
    const pInd = probs.reduce((a, x) => a * x, 1);
    let linked = 0;
    const groups = new Map();
    legs.forEach((l, i) => { const k = l.game || `solo${i}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
    let pJoint = 1;
    for (const ix of groups.values()) {
      const gl = ix.map(i => legs[i]), gp = ix.map(i => probs[i]);
      for (let a = 0; a < gl.length; a++) for (let b = a + 1; b < gl.length; b++) if (pairLink(gl[a], gl[b])) linked++;
      pJoint *= gl.length > 1 ? pAllLinked(gl, gp) : gp[0];
    }
    const ratio = pInd / pJoint;
    return { mult: r2(standard * ratio), standard, linked, ratio: r4(ratio) };
  }

  // ── pasting a slip ──
  // One slip per block (blank line between), one leg per line. A line naming
  // an app, a $ amount, a multiplier or a date is the slip's header. Legs read
  //   Josh Allen Over 245.5 Pass Yds        Josh Allen o245.5 pass yds (NFL)
  //   Josh Allen 245.5 Pass Yds More        NFL: Josh Allen Under 245.5 Pass Yards
  const SIDE = { over: 'Over', more: 'Over', higher: 'Over', o: 'Over', under: 'Under', less: 'Under', lower: 'Under', u: 'Under' };
  const SPORTS = ['NFL', 'CFB', 'NCAAF', 'NBA', 'WNBA', 'CBB', 'NCAAB', 'NCAAM', 'MLB', 'NHL', 'MMA', 'UFC', 'SOCCER', 'TENNIS', 'GOLF', 'PGA', 'NASCAR', 'LOL', 'CS', 'CS2', 'VAL', 'VALORANT', 'DOTA', 'DOTA2', 'COD'];
  const SPORT_FIX = { NCAAF: 'CFB', NCAAB: 'CBB', NCAAM: 'CBB', UFC: 'MMA', CS2: 'CS', PGA: 'GOLF', VALORANT: 'VAL', DOTA2: 'DOTA' };
  const sportRe = new RegExp(`(?:^|[\\s(\\[])(${SPORTS.join('|')})(?:[\\s)\\]:]|$)`, 'i');
  const NUM = '(\\d+(?:\\.\\d+)?)';
  const SIDE_W = '(over|under|more|less|higher|lower)';
  const LEG_RES = [
    // player side line market
    new RegExp(`^(.+?)\\s+${SIDE_W}\\s+${NUM}\\s+(.+)$`, 'i'),
    // player o245.5 market
    new RegExp(`^(.+?)\\s+([ou])\\s?${NUM}\\s+(.+)$`, 'i'),
    // player line market side
    new RegExp(`^(.+?)\\s+${NUM}\\s+(.+?)\\s+${SIDE_W}$`, 'i'),
  ];
  function parseLeg(line) {
    let s = String(line || '').replace(/^[\s\-*•·\d.)]*(?=[A-Za-z])/, '').replace(/[✓✗✔✘❌✅]/g, '').trim();
    if (!s) return null;
    // an esports leg may name its opponent last: "(vs G2)", "vs. G2", "@ G2"
    let opp = null;
    const om = /\s*[(\[]?\s*\b(?:vs\.?|versus|against)\s+([^()\[\]]{2,40}?)\s*[)\]]?\s*$|\s*[(\[]?\s*@\s*([^()\[\]]{2,40}?)\s*[)\]]?\s*$/i.exec(s);
    if (om) { opp = (om[1] || om[2]).replace(/[.,:]+$/, '').trim(); s = s.slice(0, om.index).trim(); }
    let sport = null;
    const sm = sportRe.exec(s);
    if (sm) { sport = SPORT_FIX[sm[1].toUpperCase()] || sm[1].toUpperCase(); s = (s.slice(0, sm.index) + ' ' + s.slice(sm.index + sm[0].length)).replace(/\s+/g, ' ').replace(/^[\s:,-]+|[\s:,-]+$/g, '').trim(); }
    for (const [i, re] of LEG_RES.entries()) {
      const m = re.exec(s);
      if (!m) continue;
      const [player, side, lineS, market] = i === 2 ? [m[1], m[4], m[2], m[3]] : [m[1], m[2], m[3], m[4]];
      const ln = parseFloat(lineS);
      const mk = market.replace(/\s+[-–—]\s+.*$|\s*\|.*$/, '').trim();
      if (!ok(ln) || !mk || /\$/.test(player) || player.length > 60) continue;
      return { player: player.replace(/[,:]+$/, '').trim(), side: SIDE[side.toLowerCase()], line: ln, market: mk, sport, ...(opp ? { opp } : {}) };
    }
    return null;
  }
  // "10/14 7:05 pm", "2026-10-14 19:05", "Oct 14 7:05pm" → ms, or null
  function parseWhen(s, now) {
    const t = String(s || '');
    const iso = /\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/.exec(t);
    if (iso) { const x = Date.parse(`${iso[1]}T${iso[2] ? iso[2].padStart(5, '0') : '12:00'}:00`); if (ok(x)) return x; }
    const md = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:,?\s+(\d{1,2}):(\d{2})\s*(am|pm)?)?/i.exec(t);
    if (md) {
      const y0 = new Date(now).getFullYear();
      const y = md[3] ? (md[3].length === 2 ? 2000 + +md[3] : +md[3]) : y0;
      let h = md[4] != null ? +md[4] : 12;
      if (md[6]) h = (h % 12) + (/pm/i.test(md[6]) ? 12 : 0);
      const d = new Date(y, +md[1] - 1, +md[2], h, md[5] != null ? +md[5] : 0).getTime();
      // no year: last year's date when this one is still ahead
      return !md[3] && d > now + 86400e3 ? new Date(y - 1, +md[1] - 1, +md[2], h, md[5] != null ? +md[5] : 0).getTime() : d;
    }
    return null;
  }
  function parseHeader(line, now) {
    const s = String(line || '');
    const h = {};
    const app = appOf(s);
    if (app) h.app = app;
    const money = [...s.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)].map(m => num(m[1]));
    const payWord = /(to win|pays?|payout|returns?|won|win)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d+)?)/i.exec(s);
    if (payWord) h.payout = num(payWord[2]);
    const stakeWord = /(stake|entry|risk|bet|wager)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d+)?)/i.exec(s);
    if (stakeWord) h.stake = num(stakeWord[2]);
    if (h.stake == null && money.length) h.stake = money[0];
    if (h.payout == null && money.length > 1) h.payout = money[money.length - 1];
    const mult = /\b(\d+(?:\.\d+)?)\s?x\b/i.exec(s);
    if (mult) h.mult = num(mult[1]);
    if (/\bflex\b/i.test(s)) h.flex = true;
    const when = parseWhen(s, now);
    if (when != null) h.placedAt = when;
    if (/\b(won|win|hit|cashed)\b/i.test(s) && !payWord) h.result = 'win';
    if (/\b(lost|loss|miss(ed)?)\b/i.test(s)) h.result = 'loss';
    return Object.keys(h).length ? h : null;
  }
  let seq = 0;
  const newId = (t = Date.now()) => `s${t.toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;

  // text → { slips, skipped }: skipped are lines read as neither a leg nor a header
  function parseSlips(text, { now = Date.now(), app = null } = {}) {
    const blocks = String(text || '').replace(/\r/g, '').split(/\n\s*\n/);
    const slips = [], skipped = [];
    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const slip = { id: newId(now), app: app || null, stake: null, payout: null, mult: null, flex: false, placedAt: null, legs: [], source: 'paste' };
      for (const l of lines) {
        const leg = parseLeg(l);
        if (leg && !(appOf(l) && /\$/.test(l))) { slip.legs.push(leg); continue; }
        const h = parseHeader(l, now);
        if (h) { for (const [k, v] of Object.entries(h)) if (slip[k] == null || slip[k] === false) slip[k] = v; continue; }
        skipped.push(l);
      }
      if (!slip.legs.length) continue;
      slip.placedAt = new Date(slip.placedAt ?? now).toISOString();
      slip.app = slip.app || 'prizepicks';
      slips.push(slip);
    }
    return { slips, skipped };
  }

  // ── Pikkit's CSV export ──
  // Pikkit's export (Pro, "Bet Transaction Exporting") is read by column name:
  // its own header is bet_id, sportsbook, type, status, odds, closing_line, ev,
  // amount, profit, time_placed, time_settled, bet_info, tags, sports, leagues
  // (statuses SETTLED_WIN / SETTLED_LOSS / SETTLED_PUSH / SETTLED_VOID /
  // SETTLED_CASHOUT / PENDING); other trackers' names are matched too.
  // One row per bet, or one row per leg sharing a bet id; both come out as bets.
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    const s = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
      if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim()));
  }
  const COLS = {
    id: /^(bet[ _]?id|id|ticket( id)?|transaction( id)?)$/i,
    placed: /(time[ _]?placed|placed[ _]?(at|on|date|time)?|date[ _]?placed|^date$|^time$|created|bet date)/i,
    settled: /(settled|graded|closed)[ _]?(at|on|date|time)?$/i,
    book: /^(sportsbook|book|site|app|provider|operator|bookmaker)$/i,
    type: /^(bet[ _]?type|type|wager type)$/i,
    league: /^(leagues?)$/i,
    sport: /^(sports?)$/i,
    market: /^(market|markets|bet market|prop type|category)$/i,
    desc: /^(description|bet([ _]info|[ _]description|[ _]name)?|selection|selections|pick|picks|name|legs?|details|wager)$/i,
    close: /^(closing[ _]?(line|odds|price)|close[ _]?(odds|line)?|clv[ _]?odds)$/i,
    odds: /^(odds|american[ _]odds|price)$/i,
    stake: /^(amount|stake|risk|wager amount|bet amount|risked|wagered)$/i,
    payout: /^(payout|to win|potential payout|return|returns|winnings)$/i,
    profit: /^(profit|net|net profit|profit\/loss|p\/l|pnl)$/i,
    status: /^(status|result|outcome|bet status)$/i,
    clv: /clv/i,
    ev: /^ev$/i,
    legs: /^(legs|leg count|# legs|num legs)$/i,
  };
  function columns(header) {
    const at = {};
    header.forEach((h, i) => {
      const k = String(h || '').trim();
      for (const [name, re] of Object.entries(COLS)) if (at[name] == null && re.test(k)) { at[name] = i; break; }
    });
    return at;
  }
  const STATUS = [[/^(won|win|w|hit|cashed|settled[ _]win)$/i, 'win'], [/^(lost|loss|l|miss|settled[ _]loss)$/i, 'loss'],
    [/^(push|pushed|p|tie|refund(ed)?|settled[ _]push)$/i, 'push'], [/^(void|voided|cancel(l)?ed|canceled|settled[ _]void)$/i, 'void'], [/^(open|pending|active|ungraded|live)$/i, 'open'], [/cash(ed)?[ _]?out/i, 'cashout']];
  const statusOf = s => { const t = String(s || '').trim(); for (const [re, v] of STATUS) if (re.test(t)) return v; return t ? t.toLowerCase() : 'open'; };
  const amOdds = s => { const n = num(String(s || '').replace(/^\+/, '')); if (n == null) return null; return Math.abs(n) >= 100 ? (n > 0 ? 1 + n / 100 : 1 + 100 / -n) : n > 1 ? n : null; };
  function parsePikkitCsv(text, { now = Date.now() } = {}) {
    const rows = parseCsv(text);
    if (rows.length < 2) return { bets: [], columns: {}, header: rows[0] || [], error: 'The file has no rows' };
    const header = rows[0].map(h => String(h).trim());
    const at = columns(header);
    if (at.placed == null && at.stake == null && at.desc == null) return { bets: [], columns: at, header, error: `Couldn't find the date, stake or bet columns in: ${header.join(', ')}` };
    const get = (r, k) => (at[k] == null ? '' : String(r[at[k]] ?? '').trim());
    const byId = new Map(), bets = [];
    rows.slice(1).forEach((r, i) => {
      const id = get(r, 'id') || `row${i}`;
      const desc = get(r, 'desc');
      const legs = desc.split(/\s*(?:\||;|\n| \/ |,\s(?=[A-Z][a-z]+\s[A-Z]))\s*/).map(parseLeg).filter(Boolean);
      const t = Date.parse(get(r, 'placed'));
      let b = byId.get(id);
      if (!b) {
        b = { id: `pk-${id}`.slice(0, 64), source: 'pikkit', placedAt: ok(t) ? new Date(t).toISOString() : null,
          app: appOf(get(r, 'book')) || (get(r, 'book') || 'Other'), bookName: get(r, 'book') || 'Other',
          type: get(r, 'type') || null, league: get(r, 'league') || get(r, 'sport') || null, market: get(r, 'market') || null, closeOdds: amOdds(get(r, 'close')),
          odds: amOdds(get(r, 'odds')), stake: num(get(r, 'stake')), payout: num(get(r, 'payout')), profit: num(get(r, 'profit')),
          status: statusOf(get(r, 'status')), clv: get(r, 'clv') || null, desc, legs: [], legCount: num(get(r, 'legs')) };
        byId.set(id, b); bets.push(b);
      } else {
        // a further row of the same bet: one more leg
        if (!b.league && get(r, 'league')) b.league = get(r, 'league');
        if (!b.market && get(r, 'market')) b.market = get(r, 'market');
        b.desc += ` | ${desc}`;
      }
      b.legs.push(...legs);
    });
    for (const b of bets) {
      if (b.profit == null && b.stake != null) {
        b.profit = b.status === 'win' && b.payout != null ? r2(b.payout - (b.payout > b.stake ? b.stake : 0))
          : b.status === 'win' && b.odds ? r2(b.stake * (b.odds - 1)) : b.status === 'loss' ? -b.stake : b.status === 'push' || b.status === 'void' ? 0 : null;
      }
      if (!b.type) b.type = b.legs.length > 1 || b.legCount > 1 ? 'Parlay' : 'Straight';
      if (!b.league) b.league = [...new Set(b.legs.map(l => l.sport).filter(Boolean))].join('/') || null;
      if (!b.market && b.legs.length) b.market = [...new Set(b.legs.map(l => l.market))].length === 1 ? b.legs[0].market : 'Mixed';
    }
    return { bets: bets.filter(b => b.placedAt || b.stake != null), columns: at, header, now };
  }
  // a recent Pikkit bet with legs read → a slip to grade
  function slipFromPikkit(b) {
    return { id: b.id, app: APPS[b.app] ? b.app : 'other', stake: b.stake, payout: b.status === 'win' && b.payout ? b.payout : b.stake && b.odds ? r2(b.stake * b.odds) : null,
      mult: b.odds ? r4(b.odds) : null, flex: false, placedAt: b.placedAt, legs: b.legs, source: 'pikkit', result: ['win', 'loss', 'push', 'void'].includes(b.status) ? b.status : null };
  }

  // Pikkit's own numbers by app, league, market, bet type or month
  function pikkitBreakdown(bets, by = 'app') {
    const keyOf = {
      app: b => (APPS[b.app] ? APPS[b.app].label : b.bookName || 'Other'),
      league: b => b.league || 'Unknown', market: b => b.market || 'Unknown', type: b => b.type || 'Unknown',
      month: b => (b.placedAt ? b.placedAt.slice(0, 7) : 'Unknown'),
    }[by] || (b => b.app);
    const m = new Map();
    for (const b of bets) {
      const k = keyOf(b);
      const a = m.get(k) || { key: k, bets: 0, won: 0, lost: 0, push: 0, open: 0, staked: 0, profit: 0, clvN: 0, clvSum: 0, beat: 0 };
      // Pikkit's own closing line for the bet: CLV = your price over it
      if (b.odds > 1 && b.closeOdds > 1) { const c = b.odds / b.closeOdds - 1; a.clvN++; a.clvSum += c; if (c > 0) a.beat++; }
      a.bets++;
      if (b.status === 'win') a.won++; else if (b.status === 'loss') a.lost++; else if (b.status === 'push' || b.status === 'void') a.push++; else a.open++;
      if (b.status !== 'open' && b.stake > 0) { a.staked += b.stake; a.profit += b.profit || 0; }
      m.set(k, a);
    }
    return [...m.values()].map(({ clvSum, beat, ...a }) => ({ ...a, staked: r2(a.staked), profit: r2(a.profit), roi: a.staked ? r4(a.profit / a.staked) : null, winRate: a.won + a.lost ? r4(a.won / (a.won + a.lost)) : null,
      clv: a.clvN ? r4(clvSum / a.clvN) : null, beatShare: a.clvN ? r4(beat / a.clvN) : null }))
      .sort((a, b) => (by === 'month' ? b.key.localeCompare(a.key) : b.profit - a.profit));
  }

  // ── grading ──
  // what goes to the server: the leg alone, no stake or payout
  const legKey = (slip, leg) => `${slip.app}|${leg.sport || ''}|${String(leg.player).toLowerCase()}|${String(leg.market).toLowerCase()}|${leg.side}|${leg.line}|${String(leg.opp || '').toLowerCase()}|${String(slip.placedAt).slice(0, 13)}`;
  function gradeRequest(slips, { finalOk = g => g && g.final } = {}, grades = {}) {
    const out = [], seen = new Set();
    for (const s of slips) for (const l of s.legs) {
      const id = legKey(s, l);
      if (seen.has(id) || finalOk(grades[id])) continue;
      seen.add(id);
      out.push({ id, app: s.app, sport: l.sport || null, player: l.player, market: l.market, side: l.side, line: l.line, betAt: s.placedAt, ...(l.opp ? { opp: l.opp } : {}) });
    }
    return out;
  }
  // a leg with a counted close: frozen at the start, read within the hour before it (closeEv > 0 beat it)
  const hasClose = g => !!g && g.closeEv != null && g.closeOk !== false && (g.status === 'locked' || g.status === 'graded');
  // one slip with its legs' grades → close EV of the slip (legs independent),
  // legs beating the close, and the result from the legs or the user
  function slipView(slip, grades) {
    const legs = slip.legs.map(l => ({ ...l, g: grades[legKey(slip, l)] || null }));
    let table = payTable(slip), reprice = null;
    // no payout typed on a power slip with linked picks from one game: the repriced estimate
    if (table && !slip.flex && !(slip.stake > 0 && slip.payout > 0) && !(slip.mult > 0)) {
      const n = slip.legs.length;
      reprice = repriced(legs.map(l => ({ ...l, game: l.game || (l.g?.matched?.start ? `${l.g.matched.matchTitle || ''}|${l.g.matched.start}` : null), prob: l.g?.signalFair ?? null })), table[n], slip.app);
      if (reprice && reprice.linked && reprice.mult < table[n]) table = { [n]: reprice.mult }; else reprice = null;
    }
    const priced = legs.filter(l => hasClose(l.g));
    let closeEv = null;
    if (table && priced.length === legs.length && legs.length) {
      // P(k hits) from the legs' close fairs, then the table
      let dist = [1];
      for (const l of legs) { const p = l.g.closeFair; const nx = Array(dist.length + 1).fill(0); dist.forEach((q, k) => { nx[k] += q * (1 - p); nx[k + 1] += q * p; }); dist = nx; }
      closeEv = r4(dist.reduce((a, q, k) => a + q * (table[k] || 0), 0) - 1);
    }
    const st = settleSlip(slip, legs, table);
    // legs from one game move together: the close EV above treats them as
    // independent, and the apps pay less for same-game picks than their table
    const games = new Map();
    for (const l of legs) { const m = l.g?.matched; if (m?.start) { const k = `${m.matchTitle || m.sport}|${m.start}`; games.set(k, (games.get(k) || 0) + 1); } }
    const sameGame = [...games.values()].filter(n => n > 1).reduce((a, n) => a + n, 0);
    return { ...slip, legs, table, reprice, closeEv, legsBeat: priced.filter(l => l.g.closeEv > 0).length, legsPriced: priced.length, sameGame, ...st };
  }

  // How a slip settled, from its legs: a voided or tied pick drops out and the
  // app pays the smaller entry's table (fewer than 2 picks left: refunded); a
  // power slip loses on its first miss; a flex slip pays its table at the hits.
  // The user's own result wins over all of it. → { result, hits, live,
  // multiple (returned per $1), returned ($, when the stake is known) }
  // result: 'open' | 'win' (every live pick hit) | 'paid' (a flex partial) | 'loss' | 'push' | 'void'
  const legFinal = g => !!g && (['win', 'loss', 'push'].includes(g.outcome) || g.status === 'void');
  function settleSlip(slip, legs, table) {
    const n = legs.length, stake = slip.stake > 0 ? slip.stake : null;
    const back = m => (stake != null && m != null ? r2(stake * m) : null);
    const user = slip.result;
    if (user === 'win' || user === 'loss' || user === 'push' || user === 'void') {
      const m = user === 'win' ? (slip.payout > 0 && stake ? slip.payout / stake : table?.[n] ?? null) : user === 'loss' ? 0 : 1;
      return { result: user, hits: null, live: n, multiple: m == null ? null : r4(m), returned: back(m), by: 'user' };
    }
    const gs = legs.map(l => l.g);
    if (!slip.flex && gs.some(g => g?.outcome === 'loss')) return { result: 'loss', hits: gs.filter(g => g?.outcome === 'win').length, live: n, multiple: 0, returned: back(0), by: 'legs' };
    if (!n || !gs.every(legFinal)) return { result: 'open', hits: null, live: null, multiple: null, returned: null, by: null };
    const live = gs.filter(g => g.outcome === 'win' || g.outcome === 'loss').length;
    const hits = gs.filter(g => g.outcome === 'win').length;
    if (live < 2) return { result: 'void', hits, live, multiple: 1, returned: back(1), by: 'legs' };
    // a dropped pick: the app's own table for the smaller entry (the user's payout was for all n)
    const t = live === n ? table : payTable({ app: slip.app, flex: slip.flex, legs: Array(live).fill(0) });
    if (!t) return { result: hits === live ? 'win' : 'open', hits, live, multiple: null, returned: null, by: 'legs' };
    const m = t[hits] || 0;
    return { result: hits === live && m > 0 ? 'win' : m > 0 ? 'paid' : 'loss', hits, live, multiple: r4(m), returned: back(m), by: 'legs' };
  }
  // totals over every leg by app, league or market
  function legTotals(views, by = 'app') {
    const keyOf = { app: (s) => appLabel(s.app), league: (s, l) => l.g?.matched?.sport || l.sport || 'Unknown', market: (s, l) => l.g?.matched?.market || l.market }[by];
    const m = new Map();
    for (const s of views) for (const l of s.legs) {
      const k = keyOf(s, l);
      const a = m.get(k) || { key: k, legs: 0, priced: 0, beat: 0, evSum: 0, moveSum: 0, graded: 0, wins: 0, noHistory: 0 };
      a.legs++;
      if (l.g?.status === 'nohistory') a.noHistory++;
      if (hasClose(l.g) && l.g.status !== 'open') { a.priced++; a.evSum += l.g.closeEv; if (l.g.closeEv > 0) a.beat++; if (l.g.fairMove != null) a.moveSum += l.g.fairMove; }
      if (l.g?.outcome === 'win' || l.g?.outcome === 'loss') { a.graded++; if (l.g.outcome === 'win') a.wins++; }
      m.set(k, a);
    }
    return [...m.values()].map(a => ({ key: a.key, legs: a.legs, priced: a.priced, noHistory: a.noHistory, beatShare: a.priced ? r4(a.beat / a.priced) : null,
      closeEv: a.priced ? r2(a.evSum / a.priced) : null, fairMove: a.priced ? r2(a.moveSum / a.priced) : null, graded: a.graded, hitRate: a.graded ? r4(a.wins / a.graded) : null }))
      .sort((a, b) => b.legs - a.legs);
  }
  function summary(views) {
    const t = legTotals(views, 'app').reduce((a, x) => {
      a.legs += x.legs; a.priced += x.priced; a.noHistory += x.noHistory; a.graded += x.graded;
      a.beat += (x.beatShare || 0) * x.priced; a.ev += (x.closeEv || 0) * x.priced; a.wins += (x.hitRate || 0) * x.graded; return a;
    }, { legs: 0, priced: 0, noHistory: 0, graded: 0, beat: 0, ev: 0, wins: 0 });
    const closed = views.filter(s => s.closeEv != null);
    const settled = views.filter(s => ['win', 'loss', 'paid'].includes(s.result) && s.stake > 0 && s.returned != null);
    const staked = settled.reduce((a, s) => a + s.stake, 0);
    const profit = settled.reduce((a, s) => a + s.returned - s.stake, 0);
    return { slips: views.length, legs: t.legs, priced: t.priced, noHistory: t.noHistory, beatShare: t.priced ? r4(t.beat / t.priced) : null, closeEv: t.priced ? r2(t.ev / t.priced) : null,
      graded: t.graded, hitRate: t.graded ? r4(t.wins / t.graded) : null, slipsClosed: closed.length, slipsPlusEv: closed.filter(s => s.closeEv > 0).length,
      slipCloseEv: closed.length ? r4(closed.reduce((a, s) => a + s.closeEv, 0) / closed.length) : null, settled: settled.length, staked: r2(staked), profit: r2(profit), roi: staked ? r4(profit / staked) : null };
  }

  // Slip by slip, grouped by app, sport or month: record, money, units, and
  // the close. unitUsd turns profit into units (the user's unit, else none).
  const slipSport = v => { const ss = [...new Set(v.legs.map(l => l.g?.matched?.sport || l.sport).filter(Boolean))]; return ss.length === 1 ? ss[0] : ss.length ? 'Mixed' : 'Unknown'; };
  function slipTotals(views, by = 'app', { unitUsd = null } = {}) {
    const keyOf = { app: v => appLabel(v.app), sport: slipSport, month: v => String(v.placedAt || '').slice(0, 7) || 'Unknown' }[by] || (v => appLabel(v.app));
    const m = new Map();
    for (const v of views) {
      const k = keyOf(v);
      const a = m.get(k) || { key: k, slips: 0, open: 0, won: 0, lost: 0, push: 0, staked: 0, profit: 0, closed: 0, evSum: 0, plusEv: 0, legsPriced: 0, legsBeat: 0, legEv: 0 };
      a.slips++;
      if (v.result === 'open') a.open++;
      else if (v.result === 'win' || (v.result === 'paid' && v.multiple > 1)) a.won++;
      else if (v.result === 'loss' || (v.result === 'paid' && v.multiple < 1)) a.lost++;
      else a.push++;
      if (['win', 'loss', 'paid'].includes(v.result) && v.stake > 0 && v.returned != null) { a.staked += v.stake; a.profit += v.returned - v.stake; }
      if (v.closeEv != null) { a.closed++; a.evSum += v.closeEv; if (v.closeEv > 0) a.plusEv++; }
      for (const l of v.legs) if (hasClose(l.g) && l.g.status !== 'open') { a.legsPriced++; a.legEv += l.g.closeEv; if (l.g.closeEv > 0) a.legsBeat++; }
      m.set(k, a);
    }
    return [...m.values()].map(a => ({
      key: a.key, slips: a.slips, open: a.open, record: `${a.won}-${a.lost}${a.push ? `-${a.push}` : ''}`, won: a.won, lost: a.lost, push: a.push,
      staked: r2(a.staked), profit: r2(a.profit), units: unitUsd > 0 ? r2(a.profit / unitUsd) : null, roi: a.staked ? r4(a.profit / a.staked) : null,
      slipsClosed: a.closed, slipCloseEv: a.closed ? r4(a.evSum / a.closed) : null, slipsPlusEv: a.plusEv,
      legsPriced: a.legsPriced, legBeatShare: a.legsPriced ? r4(a.legsBeat / a.legsPriced) : null, legCloseEv: a.legsPriced ? r2(a.legEv / a.legsPriced) : null,
    })).sort((a, b) => (by === 'month' ? b.key.localeCompare(a.key) : b.slips - a.slips));
  }

  // A slip built in the app (a PROPS or esports board leg tray): the same
  // shape a pasted slip has, so it grades the same way
  function makeSlip({ app, legs, stake = null, payout = null, mult = null, flex = false, placedAt = null, source = 'board', now = Date.now() } = {}) {
    if (!APPS[app] || !Array.isArray(legs) || !legs.length) return null;
    const clean = legs.map(l => ({ player: String(l.player || '').trim(), side: l.side === 'Under' ? 'Under' : 'Over', line: Number(l.line), market: String(l.market || '').trim(),
      ...(l.team ? { team: String(l.team) } : {}), ...(l.game ? { game: String(l.game) } : {}),
      sport: l.sport ? (SPORT_FIX[String(l.sport).toUpperCase()] || String(l.sport).toUpperCase()) : null, ...(l.opp ? { opp: String(l.opp) } : {}) }))
      .filter(l => l.player && l.market && ok(l.line));
    if (clean.length !== legs.length) return null;
    return { id: newId(now), app, stake: num(stake), payout: num(payout), mult: num(mult), flex: !!flex, placedAt: new Date(placedAt ?? now).toISOString(), legs: clean, source };
  }

  return { APPS, appOf, appLabel, LEG_BE, legDecimal, POWER, FLEX, payTable, parseLeg, parseWhen, parseHeader, parseSlips, parseCsv, columns, parsePikkitCsv, slipFromPikkit,
    pikkitBreakdown, legKey, gradeRequest, slipView, settleSlip, repriced, pairLink, legTotals, slipTotals, makeSlip, summary, newId };
}));
