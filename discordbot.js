'use strict';
// ─── DISCORD SLASH COMMANDS: THE PUBLIC NUMBERS, ASKED FOR IN A CHANNEL ──────
// /odds, /props, /moves, /record, /lines and /settings answer in the channel
// with the same public numbers the site and the API show everyone: each side's
// best price at a venue a resident of the server's state can use, Pinnacle's
// price (its no-vig fair where the API shows the fair), the line history link
// and a share card. Nothing is sized or picked per person, nothing places a
// bet, and "proven" is said only of what RESULTS marks proven (with a profit
// only where RESULTS shows one).
//
// It runs as Discord's interactions webhook (HTTP POSTs Discord signs with the
// app's Ed25519 key) inside the Express server: no gateway connection, no
// extra process.
//   - The owner's app: DISCORD_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN.
//     Interactions Endpoint URL <site>/discord/interactions. With any of the
//     three missing the endpoint answers 404 and nothing is registered.
//   - A customer's own app, connected on /developers#bot with their API key:
//     <site>/discord/interactions/<their app id>, checked with their public key,
//     each command counted against their key's plan limits like an API call.
//     Their bot token is used once to register the commands and never stored.
//
// Pure builders (verify, commands, messages) plus createBot (the I/O, with
// the HTTP client passed in so tests never touch the network).

const crypto = require('crypto');
const { clean } = require('./outfeed');

const API = 'https://discord.com/api/v10';
const TYPE = { PING: 1, COMMAND: 2 };
const REPLY = { PONG: 1, MESSAGE: 4, DEFERRED: 5 };
const EPHEMERAL = 64;
const MANAGE_GUILD = 1n << 5n;
const COLOR = { odds: 0x34d399, props: 0x60a5fa, moves: 0xfbbf24, record: 0x34d399, lines: 0x94a3b8, settings: 0x94a3b8, error: 0xf87171 };
const FOOTER = 'Information only: Line Reaper takes no bets. Check the price at the venue before you bet. 21+. Gambling problem? 1-800-GAMBLER.';
const APP_ID_RE = /^\d{15,22}$/;
const KEY_RE = /^[0-9a-f]{64}$/i;
const TOKEN_RE = /^[\w-]{20,40}\.[\w-]{4,10}\.[\w-]{20,60}$/;
const SKEW_S = 600;
const ODDS_FMTS = ['american', 'decimal', 'fractional', 'probability'];

// ── signatures ──
// Discord signs timestamp + raw body with the app's Ed25519 key; the public
// key is the 32 raw bytes in hex, wrapped here in its SPKI header
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function publicKeyOf(hex) {
  if (!KEY_RE.test(String(hex || ''))) return null;
  try { return crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' }); } catch { return null; }
}
// true only for a good signature on a timestamp within ten minutes of now
function verify(key, { signature, timestamp, body, now = Date.now() } = {}) {
  if (!key || !Buffer.isBuffer(body)) return false;
  const sig = String(signature || ''), ts = String(timestamp || '');
  if (!/^[0-9a-f]{128}$/i.test(sig) || !/^\d{9,12}$/.test(ts)) return false;
  if (Math.abs(now / 1000 - Number(ts)) > SKEW_S) return false;
  try { return crypto.verify(null, Buffer.concat([Buffer.from(ts), body]), key, Buffer.from(sig, 'hex')); } catch { return false; }
}

// the owner's app from env → { on, appId, key, token, problems }
function ownerConfig(env = process.env) {
  const appId = String(env.DISCORD_APP_ID || '').trim(), pk = String(env.DISCORD_PUBLIC_KEY || '').trim(), token = String(env.DISCORD_BOT_TOKEN || '').trim();
  const problems = [];
  const any = appId || pk || token;
  if (any) {
    if (!appId) problems.push('DISCORD_APP_ID is empty');
    else if (!APP_ID_RE.test(appId)) problems.push('DISCORD_APP_ID is not an application id (the long number under General Information)');
    if (!pk) problems.push('DISCORD_PUBLIC_KEY is empty');
    else if (!publicKeyOf(pk)) problems.push('DISCORD_PUBLIC_KEY is not a public key (64 hex characters under General Information)');
    if (!token) problems.push('DISCORD_BOT_TOKEN is empty');
    else if (!TOKEN_RE.test(token)) problems.push('DISCORD_BOT_TOKEN does not look like a bot token (Bot > Reset Token)');
  }
  const on = !!any && !problems.length;
  return { on, appId: on ? appId : null, key: on ? publicKeyOf(pk) : null, token: on ? token : null, problems };
}

// ── the commands (registered as global application commands) ──
const str = (name, description, required = false, extra = {}) => ({ type: 3, name, description, required, ...extra });
const COMMANDS = [
  { name: 'odds', description: 'A game\'s best price at each venue, beside Pinnacle', options: [str('game', 'A team or game, like Lakers or Lakers Celtics', true, { min_length: 2, max_length: 60 })] },
  { name: 'props', description: 'A player\'s props: each app\'s line, beside Pinnacle\'s where it has one', options: [str('player', 'A player, like Mahomes or LeBron James', true, { min_length: 2, max_length: 60 })] },
  { name: 'moves', description: 'Today\'s biggest line moves and which venues followed', options: [
    str('league', 'One league key, like nfl, nba or nhl', false, { max_length: 20 }),
    str('type', 'Price or line moves (price when left out)', false, { choices: [{ name: 'price', value: 'price' }, { name: 'line', value: 'line' }] }),
    str('window', 'Since first seen, the last 3 hours or the last hour', false, { choices: [{ name: 'since first seen', value: 'open' }, { name: 'last 3 hours', value: '3h' }, { name: 'last hour', value: '1h' }] }),
  ] },
  { name: 'record', description: 'The public record on RESULTS, or one bettor\'s verified record', options: [str('handle', 'A bettor\'s handle from /r, like @logan (the site\'s record when left out)', false, { max_length: 21 })] },
  { name: 'lines', description: 'Line history: markets we keep, with a chart and CSV each', options: [str('market', 'A team, player or stat, like Lakers or Mahomes Pass Yards', true, { min_length: 2, max_length: 60 })] },
  { name: 'settings', description: 'This server\'s state (for legal venues) and odds format', default_member_permissions: String(MANAGE_GUILD), dm_permission: false, options: [
    str('state', 'Two-letter state code, like TX, or ALL for every US venue', false, { max_length: 3 }),
    str('odds', 'How prices are written', false, { choices: ODDS_FMTS.map(f => ({ name: f, value: f })) }),
  ] },
];
const commandsHash = () => crypto.createHash('sha256').update(JSON.stringify(COMMANDS)).digest('hex').slice(0, 16);
// PUT replaces the app's global commands with this list (one request)
function registerRequest(appId, token) {
  return { method: 'put', url: `${API}/applications/${appId}/commands`, data: COMMANDS, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' } };
}
const installUrl = appId => `https://discord.com/oauth2/authorize?client_id=${appId}&scope=applications.commands`;

// an interaction's command and options → { name, opts: { name: value } }
function commandOf(i) {
  const d = i?.data || {};
  const opts = {};
  for (const o of d.options || []) if (o && typeof o.name === 'string') opts[o.name] = typeof o.value === 'string' ? o.value.slice(0, 80) : o.value;
  return { name: String(d.name || ''), opts };
}
// a member who can manage the server (Discord sends the member's permissions as a string)
function canManage(i) {
  try { const p = BigInt(i?.member?.permissions || '0'); return (p & MANAGE_GUILD) === MANAGE_GUILD || (p & 8n) === 8n; } catch { return false; }
}

// ── text ──
const cut = (s, n) => { const t = String(s ?? ''); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };
const safe = s => clean(s).replace(/([*_`~|>\\])/g, '\\$1');
const origin0 = o => { const s = String(o || '').replace(/\/+$/, ''); return /^https?:\/\/[^\s/]+$/.test(s) ? s : ''; };
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
const unix = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? Math.floor(x / 1000) : null; };
const when = t => { const u = unix(t); return u ? `<t:${u}:R>` : 'start time unknown'; };
const pct = x => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${Number(x).toFixed(1)}%`);
const bucket = now => Math.floor(now / 600e3).toString(36);

// a message: embeds with the footer, link buttons only (they open a page, so
// none can do nothing), and no mentions ever
function message(embeds, { links = [], ephemeral = false, now = Date.now() } = {}) {
  const list = (Array.isArray(embeds) ? embeds : [embeds]).filter(Boolean).slice(0, 4).map((e, n) => {
    const out = { ...e, title: e.title ? cut(clean(e.title), 250) : undefined, description: e.description ? cut(clean(e.description), 3800) : undefined,
      fields: (e.fields || []).slice(0, 12).map(f => ({ name: cut(clean(f.name), 250) || '—', value: cut(clean(f.value), 1000) || '—', inline: !!f.inline })) };
    if (!out.fields.length) delete out.fields;
    if (n === 0) { out.footer = { text: FOOTER }; if (!out.timestamp) out.timestamp = new Date(now).toISOString(); }
    return out;
  });
  const buttons = links.filter(l => l && /^https:\/\//.test(l.url) && !/polymarket\.com/i.test(l.url)).slice(0, 5)
    .map(l => ({ type: 2, style: 5, label: cut(l.label, 80), url: l.url.slice(0, 512) }));
  const data = { embeds: list, allowed_mentions: { parse: [] } };
  if (buttons.length) data.components = [{ type: 1, components: buttons }];
  if (ephemeral) data.flags = EPHEMERAL;
  return data;
}
const note = (title, text, opts = {}) => message({ title, description: text, color: opts.color ?? COLOR.error }, { ephemeral: true, ...opts });

// ── /odds ──
// game: an odds-screen game (oddsscreen.build, finished for the state)
function priceText(v, fmt) {
  return `${v.name || v.venue} ${fmt(v.american)}${v.secondHand ? ' (copy)' : ''}`;
}
function sideLine(s, { withFair, fmt }) {
  const bettable = (s.venues || []).filter(v => !v.ref && !v.lineDiffers && v.decimal > 1 && v.legal !== 'unknown');
  const best = bettable.find(v => v.best) || null;
  const pin = (s.venues || []).find(v => v.venue === 'pinnacle');
  const others = bettable.filter(v => v !== best).sort((a, b) => b.decimal - a.decimal).slice(0, 3);
  const parts = [best ? `best **${priceText(best, fmt)}**` : 'no venue in this state prices it'];
  if (withFair && s.fairAmerican != null) parts.push(`Pinnacle fair ${fmt(s.fairAmerican)}`);
  else if (pin) parts.push(`Pinnacle ${fmt(pin.american)}`);
  if (others.length) parts.push(`also ${others.map(v => priceText(v, fmt)).join(', ')}`);
  return `${safe(s.label)}: ${parts.join(' · ')}`;
}
function oddsMessage({ q, games = [], more = [], stale = false, linesAt = null, withFair = false, state = null, stateName = null, origin = '', fmt = a => String(a), hasHistory = () => false, setter = 'a server manager', now = Date.now() } = {}) {
  const o = origin0(origin);
  if (stale) return note('Prices are not fresh', 'The price feeds have not read in the last few minutes, so nothing is shown rather than an old price. Try again shortly.');
  if (!games.length) return note('No game found', `Nothing on the board in the next 48 hours matches "${safe(q)}". Try a team name, like Lakers or Chiefs.`, { color: COLOR.settings });
  const g = games[0];
  const fields = (g.markets || []).map(m => ({ name: m.label, value: m.sides.map(s => sideLine(s, { withFair, fmt })).join('\n') }));
  const where = state ? `Venues a ${stateName || state} resident can use, by our state table (check with the venue).` : `Every US venue we read: ${setter} can set the state with /settings.`;
  const desc = [`${g.leagueLabel || g.league} · starts ${when(g.start)}`, where,
    withFair ? 'Fair is Pinnacle\'s no-vig price. A price beside the fair is information, not a proven edge.' : 'Pinnacle\'s own price is shown; its no-vig fair is for subscribers while the paywall is on.'];
  if (more.length) desc.push(`Also found: ${more.slice(0, 3).map(x => safe(`${x.away} @ ${x.home}`)).join('; ')}.`);
  const market = (g.markets || [])[0]?.key || 'ml';
  const page = o ? `${o}/lines/game/${encodeURIComponent(g.id)}?${qs({ market, state })}` : null;
  const embed = { title: `${g.away} @ ${g.home}`, url: page || undefined, description: desc.join('\n'), color: COLOR.odds, fields, timestamp: linesAt || undefined };
  if (o && hasHistory(g.id)) embed.image = { url: `${o}/card/move.png?${qs({ game: g.id, market, v: bucket(now) })}` };
  return message(embed, { now, links: o ? [{ label: 'LINE HISTORY', url: page }, { label: 'OPEN ODDS SCREEN', url: `${o}/app?start=odds` }] : [] });
}

// ── /props ──
const APP_NAME = { underdog: 'Underdog', prizepicks: 'PrizePicks', sleeper: 'Sleeper', pick6: 'DK Pick6' };
function propsMessage({ q, player = null, rows = [], more = [], withFair = false, origin = '', updatedAt = null, now = Date.now() } = {}) {
  const o = origin0(origin);
  if (!player || !rows.length) return note('No player found', `No props on the board match "${safe(q)}". Try a last name, like Mahomes.`, { color: COLOR.settings });
  const fields = rows.slice(0, 10).map(r => {
    const apps = Object.entries(r.books || {}).filter(([, c]) => Number.isFinite(c?.line)).map(([k, c]) => `${APP_NAME[k] || k} ${c.line}`);
    const pin = withFair && r.pinnacle && Number.isFinite(r.pinnacle.line) ? `Pinnacle ${r.pinnacle.line}${Number.isFinite(r.pinnacle.pOver) ? `: ${r.pinnacle.pOver}% over, no-vig` : ''}` : null;
    return { name: r.market, value: [apps.join(' · ') || 'no app line', pin].filter(Boolean).join('\n'), inline: true };
  });
  const first = rows.find(r => r.startTime)?.startTime || null;
  const desc = [[player.sub, first ? `starts ${when(first)}` : null].filter(Boolean).join(' · '),
    withFair ? 'Each pick\'em app\'s line, with Pinnacle\'s no-vig chance of the over where Pinnacle hangs the prop. A line beside Pinnacle\'s is information, not a proven edge.'
      : 'Each pick\'em app\'s line. Pinnacle\'s price on props is for subscribers while the paywall is on.'];
  if (rows.length > 10) desc.push(`${rows.length - 10} more on the props board.`);
  if (more.length) desc.push(`Also found: ${more.slice(0, 3).map(x => safe(x.title)).join('; ')}.`);
  return message({ title: player.title, description: desc.join('\n'), color: COLOR.props, fields, timestamp: updatedAt || undefined },
    { now, links: o ? [{ label: 'LINE HISTORY', url: `${o}/lines?${qs({ q: player.title, kind: 'prop' })}` }, { label: 'OPEN PROPS', url: `${o}/app?start=props` }] : [] });
}

// ── /moves ── rows: publicapi.moveRow
function movesMessage({ rows = [], type = 'price', window = 'open', league = null, stale = false, at = null, origin = '', fmt = a => String(a), now = Date.now() } = {}) {
  const o = origin0(origin);
  if (stale) return note('Prices are not fresh', 'The price feeds have not read in the last few minutes, so no moves are shown. Try again shortly.');
  const span = { open: 'since we first saw each market', '3h': 'in the last 3 hours', '1h': 'in the last hour' }[window] || '';
  if (!rows.length) return note('No moves', `No ${type} moves ${span}${league ? ` in ${String(league).toUpperCase()}` : ''} yet today.`, { color: COLOR.settings });
  const lines = rows.slice(0, 6).map(r => {
    const moved = (r.followers || []).filter(f => f.status === 'moved').length, old = (r.followers || []).filter(f => f.status === 'old').length;
    const from = type === 'line' ? r.from : fmt(r.from), to = type === 'line' ? r.to : fmt(r.to);
    return `• **${safe(r.leagueLabel || String(r.league || '').toUpperCase())}** ${safe(r.event)} · ${safe(r.side)}: ${safe(r.venueName)} ${from} → ${to} (${r.move} ${r.unit === 'points' ? 'pts' : 'pts of win chance'}). ${moved} followed, ${old} still at the old ${type === 'line' ? 'number' : 'price'}.`;
  });
  lines.push('', 'A move is information, not an edge: venues still at the old number have graded as no edge against the close.');
  const top = rows.find(r => r.kind === 'game' && r.gameId);
  const embed = { title: `Biggest ${type} moves ${span}`, description: lines.join('\n'), color: COLOR.moves, timestamp: at || undefined };
  if (o && top) embed.image = { url: `${o}/card/move.png?${qs({ game: top.gameId, market: top.market, side: top.side, v: bucket(now) })}` };
  return message(embed, { now, links: o ? [{ label: 'OPEN BIGGEST MOVES', url: `${o}/app?start=odds` }, ...(top ? [{ label: 'LINE HISTORY', url: `${o}/lines/game/${encodeURIComponent(top.gameId)}?${qs({ market: top.market })}` }] : [])] : [] });
}

// ── /record ── card: publicapi.recordCard (the site's); row: pubrecord.indexRow (a bettor's)
function recordMessage({ card = null, origin = '', now = Date.now() } = {}) {
  const o = origin0(origin);
  const p = card?.proven || [];
  const lines = p.length
    ? ['Proven on the strict rule:', ...p.map(r => `• ${safe(r.venueName)} ${safe(r.kindLabel || r.kind)}: ${r.graded} graded, CLV ${pct(r.clvPct)} vs Pinnacle's close${r.profitShown && r.units != null ? `, ${r.units > 0 ? '+' : ''}${r.units}u` : ', profit not shown'}${r.texas ? '' : ' (not a Texas venue)'}`)]
    : ['Nothing is proven yet on the strict rule.'];
  lines.push(`${card?.notProven ?? 0} other kinds are not proven: ${card?.building ?? 0} building toward 50 graded, ${card?.losing ?? 0} losing to the close.`);
  lines.push('', card?.rule || 'Proven means 50 graded at one venue with a CLV t of 2 or more against Pinnacle\'s close. A profit is shown only where RESULTS shows one.');
  const embed = { title: 'The public record (RESULTS)', url: o ? `${o}/results` : undefined, description: lines.join('\n'), color: COLOR.record, timestamp: card?.at || undefined };
  if (o) embed.image = { url: `${o}/card/record.png?${qs({ v: bucket(now) })}` };
  return message(embed, { now, links: o ? [{ label: 'FULL RECORD', url: `${o}/results` }, { label: 'ALERT HISTORY', url: `${o}/alerts` }] : [] });
}
function bettorMessage({ handle, row = null, status = null, origin = '', now = Date.now() } = {}) {
  const o = origin0(origin);
  if (!row) return note('No record', status === 'unpublished' ? `@${safe(handle)} took their record down.` : `No public record with the handle @${safe(handle)}. The list is at /r.`, { color: COLOR.settings });
  const lines = [`${row.onTime} pick${row.onTime === 1 ? '' : 's'} logged before the start${row.late ? `; ${row.late} logged late (shown on the record, never counted)` : ''}.`];
  if (row.proven.length) lines.push(`Proven: ${row.proven.map(safe).join(', ')}.`);
  for (const k of (row.kinds || []).slice(0, 6)) lines.push(`• ${safe(k.name)}: ${k.n || 0} graded against Pinnacle's close (${safe(k.label)})`);
  lines.push('', 'Imported or typed in by the bettor, not placed through Line Reaper. Proven needs 50 picks logged before the start with a CLV t of 2 or more, judged one app or venue at a time. Units show only on the record page, and only where proven.');
  const embed = { title: `@${row.handle}: verified record`, url: o ? `${o}/r/${row.handle}` : undefined, description: lines.join('\n'), color: COLOR.record };
  if (o) embed.image = { url: `${o}/card/record-${row.handle}.png?${qs({ v: bucket(now) })}` };
  return message(embed, { now, links: o ? [{ label: 'OPEN RECORD', url: `${o}/r/${row.handle}` }, { label: 'ALL RECORDS', url: `${o}/r` }] : [] });
}

// ── /lines ── body: lineIndexBody
function linesMessage({ q, body = null, origin = '', now = Date.now() } = {}) {
  const o = origin0(origin);
  const rows = body?.rows || [];
  if (!rows.length) return note('No markets kept', `No market in the line history matches "${safe(q)}"${body?.windowDays ? ` in the last ${body.windowDays} days` : ''}. Try a team or player name.`, { color: COLOR.settings });
  const MK = { ml: 'Moneyline', spread: 'Spread', total: 'Total' };
  const lines = rows.slice(0, 8).map(r => {
    const page = r.kind === 'game' ? `/lines/game/${encodeURIComponent(r.key)}?market=${r.market}` : `/lines/prop?key=${encodeURIComponent(r.key)}`;
    const name = r.kind === 'game' ? `${r.event || r.key} · ${MK[r.market] || r.market}` : `${r.player || r.event || r.key} · ${r.stat || ''}${r.line != null ? ` ${r.line}` : ''}`;
    const label = `${safe(name)}${r.leagueLabel || r.league ? ` (${safe(r.leagueLabel || String(r.league).toUpperCase())})` : ''}`;
    return `• ${o ? `[${label}](${o}${page})` : label}: ${r.reads} read${r.reads === 1 ? '' : 's'}${r.archived ? ', closed' : ''}, starts ${when(r.start)}`;
  });
  const total = body.total ?? rows.length;
  if (total > rows.length) lines.push(`…and ${total - Math.min(rows.length, 8)} more on the line history page.`);
  lines.push('', 'Every point is a price we read, at every venue, Pinnacle included. Each chart page has a CSV download.');
  return message({ title: `Line history: ${q}`, description: lines.join('\n'), color: COLOR.lines },
    { now, links: o ? [{ label: 'OPEN LINE HISTORY', url: `${o}/lines?${qs({ q })}` }] : [] });
}

// ── /settings ── current: { state, stateName, odds }
function settingsMessage({ current = {}, changed = false, problem = null } = {}) {
  if (problem) return note('Settings not changed', problem);
  const st = current.state ? `${current.stateName || current.state} (${current.state}): best prices only at venues a resident can use, by our state table.` : 'None: best prices at every US venue we read.';
  const lines = [`State: ${st}`, `Odds format: ${current.odds || 'american'}.`, '',
    changed ? 'Saved for everyone in this server.' : 'Change them with /settings state:TX odds:decimal (Manage Server only). The same for everyone here.'];
  return message({ title: 'Line Reaper settings for this server', description: lines.join('\n'), color: COLOR.settings }, { ephemeral: true });
}

// ── the handler ──
// handlers: { odds(opts, ctx), props, moves, record, lines } → message data
// (or a promise). ctx: { guild, settings, app }. settings: { get(app, guild),
// set(app, guild, patch) }. http: an axios-like client. limit(ctx) → null to
// go on, or a message saying why not.
function createBot({ handlers = {}, settings = null, http = null, deferAfterMs = 2200, log = console, now = () => Date.now(), stateOf = s => s, stateName = s => s } = {}) {
  const stats = { interactions: 0, pings: 0, badSignature: 0, deferred: 0, errors: 0, limited: 0, byCommand: {}, lastAt: null, lastError: null, followupErrors: 0 };
  const client = http || require('axios');
  async function settingsCmd(i, opts, ctx) {
    if (!ctx.guild) return settingsMessage({ problem: 'Settings belong to a server. Use /settings in a server channel.' });
    const cur = await settings.get(ctx.app, ctx.guild);
    const view = c => ({ state: c.state || null, stateName: c.state ? stateName(c.state) : null, odds: c.odds || 'american' });
    if (opts.state == null && opts.odds == null) return settingsMessage({ current: view(cur) });
    if (!canManage(i)) return settingsMessage({ problem: 'Only someone with Manage Server can change this server\'s settings.' });
    const patch = {};
    if (opts.state != null) {
      const s = String(opts.state).trim().toUpperCase();
      if (s === 'ALL' || s === 'NONE') patch.state = null;
      else { const st = stateOf(s); if (!st) return settingsMessage({ problem: `"${safe(opts.state)}" is not a US state code. Use two letters, like TX, or ALL.` }); patch.state = st; }
    }
    if (opts.odds != null) {
      if (!ODDS_FMTS.includes(opts.odds)) return settingsMessage({ problem: 'Odds format is american, decimal, fractional or probability.' });
      patch.odds = opts.odds;
    }
    const next = await settings.set(ctx.app, ctx.guild, patch);
    return settingsMessage({ current: view(next), changed: true });
  }
  async function answer(i, ctx) {
    const { name, opts } = commandOf(i);
    stats.byCommand[name] = (stats.byCommand[name] || 0) + 1;
    if (name === 'settings') return settingsCmd(i, opts, ctx);
    const h = handlers[name];
    if (!h) return note('Unknown command', 'This bot answers /odds, /props, /moves, /record, /lines and /settings.');
    return h(opts, ctx);
  }
  // → { status, body } for Express to send. body: the raw request bytes.
  async function handle({ key, appId, signature, timestamp, body, limit = null, ctx: extra = {} }) {
    if (!verify(key, { signature, timestamp, body, now: now() })) { stats.badSignature++; return { status: 401, body: { error: 'bad signature' } }; }
    let i;
    try { i = JSON.parse(body.toString('utf8')); } catch { return { status: 400, body: { error: 'bad json' } }; }
    if (i.type === TYPE.PING) { stats.pings++; return { status: 200, body: { type: REPLY.PONG } }; }
    if (i.type !== TYPE.COMMAND) return { status: 200, body: { type: REPLY.MESSAGE, data: note('Not supported', 'This bot answers slash commands only.') } };
    stats.interactions++;
    stats.lastAt = new Date(now()).toISOString();
    const guild = i.guild_id ? String(i.guild_id) : null;
    const cur = settings && guild ? await settings.get(appId, guild).catch(() => ({})) : {};
    const ctx = { ...extra, app: appId, guild, user: String(i.member?.user?.id || i.user?.id || ''), settings: cur || {} };
    const stop = limit ? await limit(ctx, commandOf(i).name) : null;
    if (stop) { stats.limited++; return { status: 200, body: { type: REPLY.MESSAGE, data: stop } }; }
    const work = answer(i, ctx).catch(e => {
      stats.errors++; stats.lastError = String(e?.message || e).slice(0, 160);
      log.warn?.(`Discord bot (${commandOf(i).name}): ${stats.lastError}`);
      return note('Something went wrong', 'That could not be answered just now. Try again in a minute.');
    });
    let timer;
    const late = new Promise(r => { timer = setTimeout(() => r(null), deferAfterMs); timer.unref?.(); });
    const first = await Promise.race([work, late]);
    clearTimeout(timer);
    if (first) return { status: 200, body: { type: REPLY.MESSAGE, data: first } };
    // slower than Discord's 3 s: "thinking…" now, the answer edited in when ready
    stats.deferred++;
    const followup = work.then(data => client.patch(`${API}/webhooks/${i.application_id || appId}/${i.token}/messages/@original`, data, { timeout: 10000, headers: { 'Content-Type': 'application/json' } }))
      .catch(e => { stats.followupErrors++; log.warn?.(`Discord bot follow-up: ${String(e?.response?.status || e?.message || e).slice(0, 80)}`); });
    return { status: 200, body: { type: REPLY.DEFERRED, data: commandOf(i).name === 'settings' ? { flags: EPHEMERAL } : {} }, followup };
  }
  // register the commands on an app (owner at boot, a customer when they connect)
  async function register(appId, token) {
    const r = registerRequest(appId, token);
    try {
      const res = await client.put(r.url, r.data, { timeout: 10000, headers: r.headers });
      return { ok: true, count: Array.isArray(res?.data) ? res.data.length : COMMANDS.length };
    } catch (e) {
      const st = e?.response?.status;
      return { ok: false, status: st || null, why: st === 401 ? 'Discord turned the bot token away (Bot > Reset Token, then copy the new one).'
        : st === 403 || st === 404 ? 'That token is not this application\'s bot token, or the application id is wrong.'
          : st === 429 ? 'Discord is rate limiting command updates. Try again in a minute.' : 'Could not reach Discord to register the commands. Try again in a minute.' };
    }
  }
  return { handle, register, stats: () => ({ ...stats, byCommand: { ...stats.byCommand } }) };
}

// a settings store over a document store ({ init, all, put }): one doc per app and server
function createSettings({ store, prefix = 'bot-guild|' } = {}) {
  const map = new Map();
  let ready = null;
  const init = () => (ready ||= (async () => { await store.init?.(); for (const d of await store.all()) if (d && typeof d.id === 'string' && d.id.startsWith(prefix)) map.set(d.id, d); })());
  const id = (app, guild) => `${prefix}${app}|${guild}`;
  async function get(app, guild) { await init(); const d = map.get(id(app, guild)); return d ? { state: d.state || null, odds: d.odds || null } : {}; }
  async function set(app, guild, patch) {
    await init();
    const prev = map.get(id(app, guild)) || { id: id(app, guild) };
    const d = { ...prev, ...patch, at: new Date().toISOString() };
    map.set(d.id, d);
    await store.put(d);
    return { state: d.state || null, odds: d.odds || null };
  }
  const count = () => map.size;
  return { init, get, set, count };
}

module.exports = { API, TYPE, REPLY, EPHEMERAL, COMMANDS, FOOTER, APP_ID_RE, KEY_RE, TOKEN_RE, publicKeyOf, verify, ownerConfig, commandsHash, registerRequest, installUrl,
  commandOf, canManage, message, oddsMessage, propsMessage, movesMessage, recordMessage, bettorMessage, linesMessage, settingsMessage, createBot, createSettings };
