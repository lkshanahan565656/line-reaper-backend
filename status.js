// ─── STATUS PAGE: feed health and uptime (/status, /api/uptime) ──────────────
// What every venue and recorder looks like right now, read from the state the
// server already keeps (the same numbers /api/status and /api/ops report),
// plus a small rolling history: one sample every 5 minutes, kept 7 days, saved
// with the results backup so it lasts across deploys.
//
//   up      the last good read is younger than that feed's stale limit
//   stale   it read once, but not inside the limit
//   down    on, but no good read since this server started
//   off     switched off on this server (an env flag or a licence)
//
// Uptime is the share of samples a feed was up, among the samples it was on.
// The site's own uptime is the share of 5-minute slots that have a sample: a
// slot with none means the server was not running (a deploy, a crash). With
// no samples yet the page says so; nothing is filled in.

const SAMPLE_MS = 5 * 60e3;
const KEEP_MS = 7 * 24 * 3600e3;
const DAY_MS = 24 * 3600e3;
const CODE = { up: 'u', stale: 's', down: 'd', off: 'o' };
const FROM_CODE = { u: 'up', s: 'stale', d: 'down', o: 'off' };
const GROUPS = [
  ['sharp', 'Sharp lines'], ['book', 'Sportsbooks'], ['exchange', 'Exchanges'], ['app', "Pick'em apps"],
  ['data', 'Stats and esports data'], ['recorder', 'Recorders and graders'],
];

const iso = t => (t ? new Date(t).toISOString() : null);
const ms = v => { const t = typeof v === 'number' ? v : Date.parse(v || ''); return Number.isFinite(t) && t > 0 ? t : null; };

// state of one probe row at time t, given the newest good read we know of
function stateOf(row, okAt, t) {
  if (!row.enabled) return 'off';
  if (!okAt) return 'down';
  return t - okAt <= row.staleMs ? 'up' : 'stale';
}

// probe(): [{ key, name, group, enabled, okAt, count, unit, error, staleMs, note }]
function createStatusBoard({ probe, now = () => Date.now(), version = () => null, sampleMs = SAMPLE_MS, keepMs = KEEP_MS } = {}) {
  const lastOk = new Map();         // key → newest good read seen (ms)
  const samples = [];               // { id: ISO minute, at, v, s: { key: code } }, oldest first
  const ids = new Set();

  function read() {
    let rows;
    try { rows = probe() || []; } catch (e) { rows = []; read.error = e.message; }
    const t = now();
    return rows.map(r => {
      const ok = ms(r.okAt);
      if (ok && ok > (lastOk.get(r.key) || 0)) lastOk.set(r.key, ok);
      const okAt = lastOk.get(r.key) || null;
      return { ...r, okAt, state: stateOf(r, okAt, t) };
    });
  }

  function add(s) {
    if (!s || typeof s.id !== 'string' || ids.has(s.id) || !ms(s.at) || typeof s.s !== 'object') return false;
    ids.add(s.id);
    samples.push({ id: s.id, at: s.at, v: s.v || null, s: s.s });
    return true;
  }
  function trim() {
    samples.sort((a, b) => ms(a.at) - ms(b.at));
    const cut = now() - keepMs;
    while (samples.length && ms(samples[0].at) < cut) ids.delete(samples.shift().id);
  }

  // one sample per slot: the id is the slot's start, so a second call inside it is a no-op
  function sample() {
    const t = now(), slot = Math.floor(t / sampleMs) * sampleMs;
    const id = new Date(slot).toISOString();
    if (ids.has(id)) return null;
    const s = { id, at: new Date(t).toISOString(), v: version(), s: Object.fromEntries(read().map(r => [r.key, CODE[r.state]])) };
    add(s); trim();
    return s;
  }

  // share of slots in [from, to) that have a sample, counted from the first sample ever kept
  function siteUptime(windowMs, t) {
    if (!samples.length) return null;
    const first = ms(samples[0].at), from = Math.max(t - windowMs, Math.floor(first / sampleMs) * sampleMs);
    const slots = Math.max(1, Math.floor((t - from) / sampleMs));
    const seen = samples.filter(s => ms(s.at) >= from).length;
    return { pct: Math.min(1, seen / slots), samples: seen, slots, since: new Date(from).toISOString() };
  }
  function feedUptime(key, windowMs, t) {
    let on = 0, up = 0;
    for (const s of samples) {
      if (ms(s.at) < t - windowMs) continue;
      const c = s.s[key];
      if (!c || c === 'o') continue;
      on++; if (c === 'u') up++;
    }
    return on ? { pct: up / on, samples: on } : null;
  }
  // the last 24 hours as hourly cells for a strip: worst state in the hour, or null with no sample
  function strip(key, t) {
    const out = [];
    const rank = { u: 1, s: 2, d: 3 };
    for (let h = 23; h >= 0; h--) {
      const a = t - (h + 1) * 3600e3, b = t - h * 3600e3;
      let worst = null, any = false;
      for (const s of samples) {
        const st = ms(s.at);
        if (st < a || st >= b) continue;
        any = true;
        const c = s.s[key];
        if (c && c !== 'o' && (!worst || rank[c] > rank[worst])) worst = c;
      }
      out.push(any ? (worst ? FROM_CODE[worst] : 'off') : null);
    }
    return out;
  }

  function view({ liveCheck = null, uptimeS = null } = {}) {
    const t = now();
    const rows = read().map(r => ({
      key: r.key, name: r.name, group: r.group, state: r.state, enabled: !!r.enabled,
      okAt: iso(r.okAt), ageS: r.okAt ? Math.round((t - r.okAt) / 1000) : null, staleAfterS: Math.round(r.staleMs / 1000),
      count: Number.isFinite(r.count) ? r.count : null, unit: r.unit || null, error: r.error ? String(r.error).slice(0, 160) : null, note: r.note || null,
      uptime24h: feedUptime(r.key, DAY_MS, t), uptime7d: feedUptime(r.key, 7 * DAY_MS, t), last24h: strip(r.key, t),
    }));
    const on = rows.filter(r => r.enabled);
    return {
      at: new Date(t).toISOString(), version: version(), uptimeS,
      summary: { on: on.length, up: on.filter(r => r.state === 'up').length, stale: on.filter(r => r.state === 'stale').length, down: on.filter(r => r.state === 'down').length, off: rows.length - on.length },
      site: { uptime24h: siteUptime(DAY_MS, t), uptime7d: siteUptime(7 * DAY_MS, t), samples: samples.length, firstSampleAt: samples[0]?.at || null, sampleEveryS: sampleMs / 1000, keepDays: keepMs / DAY_MS },
      liveCheck: liveCheck && liveCheck.last ? { ok: liveCheck.last.ok, at: liveCheck.last.at || null, version: liveCheck.last.version, failures: liveCheck.last.failures, tabs: liveCheck.last.tabs, clicks: liveCheck.last.clicks } : null,
      groups: GROUPS.map(([key, name]) => ({ key, name })).filter(g => rows.some(r => r.group === g.key)),
      feeds: rows,
    };
  }

  return {
    sample, view, read,
    dump: () => samples.map(s => ({ ...s })),
    load: list => { let n = 0; for (const s of list || []) if (add(s)) n++; trim(); return n; },
    size: () => samples.length,
  };
}

// ── the public page ──────────────────────────────────────────────────────────
const STATE_COLOR = { up: '#34d399', stale: '#fbbf24', down: '#f87171', off: '#8391a7' };
const pct = u => (u ? `${(u.pct * 100).toFixed(u.pct >= 0.999 || u.pct === 0 ? 0 : 1)}%` : 'no data yet');
function ago(s) {
  if (s == null) return 'never';
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const limit = s => (s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

function renderPage(v, { origin = '' } = {}) {
  const learn = require('./learn');
  const { esc } = learn;
  const o = String(origin).replace(/[^\w.:/-]/g, '').replace(/\/+$/, '');
  const s = v.summary;
  const headline = !s.on ? 'No feeds are on' : s.up === s.on ? 'Every feed that is on is reading' : `${s.on - s.up} of ${s.on} feeds are not reading right now`;
  const headColor = !s.on ? '#94a3b8' : s.up === s.on ? STATE_COLOR.up : s.down + s.stale > s.on / 2 ? STATE_COLOR.down : STATE_COLOR.stale;
  const cells = l => `<span class="strip" aria-hidden="true">${l.map(c => `<i style="background:${c ? STATE_COLOR[c] : 'var(--border)'}"></i>`).join('')}</span>`;
  const row = f => `<tr>
<td><b>${esc(f.name)}</b>${f.note ? `<div class="sub">${esc(f.note)}</div>` : ''}${f.error && (f.state === 'down' || f.state === 'stale') ? `<div class="sub err">${esc(f.error)}</div>` : ''}</td>
<td><span class="st" style="color:${STATE_COLOR[f.state]}">${esc(f.state.toUpperCase())}</span><div class="sub">${f.enabled ? `stale after ${esc(limit(f.staleAfterS))}` : 'switched off here'}</div></td>
<td class="n">${f.enabled ? esc(ago(f.ageS)) : '—'}<div class="sub">${f.count != null && f.enabled ? `${f.count.toLocaleString('en-US')} ${esc(f.unit || '')}` : ''}</div></td>
<td class="n">${f.enabled ? esc(pct(f.uptime24h)) : '—'}<div class="sub">7d ${f.enabled ? esc(pct(f.uptime7d)) : '—'}</div></td>
<td class="hide-s">${f.enabled ? cells(f.last24h) : ''}</td></tr>`;
  const tables = v.groups.map(g => `<h2>${esc(g.name)}</h2><div class="scroll"><table class="feeds"><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5 hide-s"></colgroup><thead><tr><th>Feed</th><th>Now</th><th class="n">Last read</th><th class="n">Up 24h</th><th class="hide-s">Last 24 hours</th></tr></thead><tbody>${v.feeds.filter(f => f.group === g.key).map(row).join('')}</tbody></table></div>`).join('');
  const lc = v.liveCheck;
  const lcText = lc ? `<b style="color:${lc.ok ? STATE_COLOR.up : STATE_COLOR.down}">${lc.ok ? 'PASSED' : 'FAILED'}</b><i>v${esc(lc.version || '?')} · ${esc(String(lc.at).slice(0, 16).replace('T', ' '))} UTC</i>` : '<b style="color:var(--text2)">—</b><i>no data yet</i>';
  const site = v.site;
  const siteTxt = site.uptime24h ? `<b>${esc(pct(site.uptime24h))}</b><i>7d ${esc(pct(site.uptime7d))} · ${site.samples} sample${site.samples === 1 ? '' : 's'} since ${esc(String(site.firstSampleAt).slice(0, 10))}</i>` : '<b style="color:var(--text2)">—</b><i>no data yet: the first sample lands within 5 minutes of a start</i>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Status | Line Reaper</title>
<meta name="description" content="Live feed health for every venue Line Reaper reads: last good read, staleness and uptime.">
${o ? `<link rel="canonical" href="${esc(o)}/status">` : ''}
<meta name="theme-color" content="#080b10">
<link rel="icon" href="${learn.FAVICON}">
<style>${learn.CSS}
main { max-width:960px; }
.top-in { max-width:960px; }
.st { font:700 11px var(--mono); letter-spacing:.06em; white-space:nowrap; }
.sub { color:var(--muted); font-size:11px; font-family:inherit; }
.sub.err { color:#fca5a5; overflow-wrap:anywhere; }
td.n, th.n { text-align:right; white-space:nowrap; }
.feeds { table-layout:fixed; }
.feeds .c1 { width:34%; } .feeds .c2 { width:18%; } .feeds .c3 { width:16%; } .feeds .c4 { width:12%; } .feeds .c5 { width:20%; }
.feeds td:first-child { overflow-wrap:anywhere; }
.strip { display:inline-flex; gap:2px; }
.strip i { display:block; width:5px; height:16px; border-radius:1px; }
.rl { font:600 10px var(--mono); letter-spacing:.08em; color:var(--text2); background:none; border:1px solid var(--border); border-radius:6px; padding:3px 8px; cursor:pointer; margin-left:4px; }
.tiles { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 18px; }
.tiles div { flex:1 1 160px; min-width:0; background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
.tiles span { display:block; font:600 10px var(--mono); letter-spacing:.1em; color:var(--muted); }
.tiles b { display:block; font-size:20px; margin:2px 0; }
.tiles i { font-style:normal; color:var(--text2); font-size:12px; overflow-wrap:anywhere; }
@media (max-width:640px) { .hide-s { display:none; } .feeds .c1 { width:40%; } .feeds .c2 { width:24%; } .feeds .c3 { width:20%; } .feeds .c4 { width:16%; } .feeds th.n { white-space:normal; } th, td { padding:8px 6px; } }
</style>
</head>
<body>
<header class="top"><div class="top-in"><a class="brand" href="/">${learn.LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app">OPEN THE APP</a></div></header>
<main>
<p class="kicker">Status</p>
<h1 style="color:${headColor}">${esc(headline)}</h1>
<p class="lead">Every venue and recorder this server reads, from its own state. Read ${esc(v.at.slice(0, 16).replace('T', ' '))} UTC; this page reloads every minute. <button type="button" id="rl" class="rl" aria-pressed="false">PAUSE RELOADING</button></p>
<div class="tiles">
<div><span>FEEDS UP NOW</span><b>${s.up} / ${s.on}</b><i>${s.stale} stale · ${s.down} down · ${s.off} off here</i></div>
<div><span>SITE UP 24H</span>${siteTxt}</div>
<div><span>VERSION</span><b>v${esc(v.version || '?')}</b><i>running ${v.uptimeS != null ? esc(ago(v.uptimeS).replace(' ago', '')) : '—'}</i></div>
<div><span>LAST LIVE CHECK</span>${lcText}</div>
</div>
${tables.replace(/<div class="scroll">/g, '<div class="scroll" tabindex="0" role="region" aria-label="Feed table">')}
<p class="note">How to read it: UP means the last good read is younger than the feed's stale limit; STALE means it read before but not inside the limit; DOWN means it is on but has not read since this server started; OFF means it is switched off on this server. Uptime is the share of 5-minute samples a feed was up, among the samples it was on, kept ${site.keepDays} days. Site uptime is the share of 5-minute slots with a sample since the first one; a slot with none means the server was not running, and samples taken in the minutes before a deploy can be lost before the backup saves them. Nothing here is a price or a pick.</p>
<p><a class="go" href="/api/uptime">THE SAME AS JSON →</a></p>
</main>
<script id="reload">
(function () {
  // reload every minute unless the viewer paused it (WCAG 2.2.1), or the tab is in the background
  var paused = false, b = document.getElementById('rl');
  try { paused = localStorage.getItem('lr_status_pause') === '1'; } catch (e) {}
  function show() { b.textContent = paused ? 'RESUME RELOADING' : 'PAUSE RELOADING'; b.setAttribute('aria-pressed', String(paused)); }
  b.onclick = function () { paused = !paused; try { localStorage.setItem('lr_status_pause', paused ? '1' : '0'); } catch (e) {} show(); };
  show();
  setInterval(function () { if (!paused && !document.hidden) location.reload(); }, 60000);
})();
</script>
<footer><div class="in"><nav><a href="/">Line Reaper</a><a href="/learn">Learn</a><a href="/terms">Terms</a><a href="/responsible-gambling">Responsible gambling</a></nav>
<div>Line Reaper is an information service, not a sportsbook. It does not take bets. 21+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></div></footer>
</body>
</html>`;
}

module.exports = { createStatusBoard, renderPage, stateOf, SAMPLE_MS, KEEP_MS, GROUPS };
