// ─── PRICE AGE: HOW LONG AGO EACH VENUE LAST ANSWERED ───────────────────────
// Every price on ODDS SCREEN, SHOP, BEST PLAYS and /lines came from a read of
// its venue. This turns each venue's last good read into what the screens
// show next to its prices: "8s", "3m", greyed once it is older than that
// venue's stale mark. The age is of the venue's last answer, not of the last
// time the price moved: a price that sat still for an hour on a venue we read
// a minute ago is a minute old.
//
// Kalshi is read two ways: polled once a minute, or streamed (kalshiws.js).
// While the stream is live and holds every market the polls track, Kalshi's
// age is the stream's last word (it pings every 10 s); otherwise the poll's.
//
// Pure: server.js hands in the read times.

'use strict';

const ms = t => { if (t == null || t === '') return null; const x = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(x) && x > 0 ? x : null; };

// list: [{ key, name, at (ms or ISO), staleMs, via? }] → { now, venues: { key: { name, at, ageSec, staleSec, stale, via } } }
function build(list, now = Date.now()) {
  const venues = {};
  for (const v of list || []) {
    if (!v?.key) continue;
    const at = ms(v.at);
    const ageSec = at == null ? null : Math.max(0, Math.round((now - at) / 1000));
    const staleSec = Math.round((v.staleMs || 5 * 60e3) / 1000);
    venues[v.key] = { name: v.name || v.key, at: at == null ? null : new Date(at).toISOString(), ageSec, staleSec, stale: ageSec == null || ageSec > staleSec, via: v.via || 'poll' };
  }
  return { now: new Date(now).toISOString(), venues };
}
// 8 → "8s", 200 → "3m", 7300 → "2h", 200000 → "2d"
function fmtAge(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
// one venue's age as words, for a title: "Kalshi answered 8 s ago (streamed)"
function describe(v, sec = v?.ageSec) {
  if (!v) return 'No read of this venue yet';
  if (sec == null) return `${v.name}: not read yet`;
  const t = sec < 60 ? `${sec} s` : sec < 3600 ? `${Math.floor(sec / 60)} min` : `${Math.floor(sec / 3600)} h`;
  return `${v.name} last answered ${t} ago${v.via === 'stream' ? ' (live stream)' : ''}${sec > v.staleSec ? `: stale, older than ${Math.round(v.staleSec / 60) || 1} min` : ''}`;
}

module.exports = { build, fmtAge, describe };
