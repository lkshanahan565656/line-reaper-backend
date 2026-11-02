// ─── SECURITY: response headers, per-address limits, safe compares ──────────
// One place for the cross-cutting parts of request safety, so every route gets
// the same answer:
//   - headers(): CSP, HSTS (https only), nosniff, referrer and frame rules.
//     Widgets under /embed/ may be framed by any site (that is their job);
//     everything else only by this site.
//   - createWindowLimiter(): a fixed-window counter per key (an address, an
//     email). writeLimit() puts one on every write under /api.
//   - callerIp(): the address Railway's proxy saw (the LAST X-Forwarded-For
//     entry; the first ones are whatever the client sent).
//   - safeEqual(): a constant-time compare for the admin token.
//   - jsonErrors(): bad JSON, oversized bodies and anything thrown answer
//     short JSON, never Express's HTML page with a stack trace.
'use strict';
const crypto = require('crypto');

function callerIp(req) {
  const xf = String(req.get?.('x-forwarded-for') || '').split(',').map(s => s.trim()).filter(Boolean);
  return xf[xf.length - 1] || req.ip || req.socket?.remoteAddress || '';
}

// a request from this machine with no proxy in front (tests, a local copy):
// the per-address limits leave it alone. Behind Railway every request carries
// X-Forwarded-For, so this is never true there.
function isLocal(req) {
  if (req.get?.('x-forwarded-for')) return false;
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const h = s => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// take(key) → { ok, retryAfter (s), remaining }. The map is cleared past `max`
// keys so a flood of addresses can't grow it without bound.
function createWindowLimiter({ limit, windowMs, max = 20000, now = () => Date.now() }) {
  const hits = new Map();
  function take(key, n = 1) {
    const t = now();
    let h = hits.get(key);
    if (!h || t - h.at >= windowMs) {
      if (!h && hits.size >= max) hits.clear();
      h = { at: t, n: 0 };
      hits.set(key, h);
    }
    h.n += n;
    const retryAfter = Math.max(1, Math.ceil((h.at + windowMs - t) / 1000));
    return { ok: h.n <= limit, retryAfter, remaining: Math.max(0, limit - h.n) };
  }
  // how many a key has used in its window, without counting one
  const peek = key => { const h = hits.get(key); return h && now() - h.at < windowMs ? h.n : 0; };
  const reset = key => hits.delete(key);
  return { take, peek, reset, size: () => hits.size };
}

const tooMany = (res, lim, msg) => res.status(429).set({ 'Retry-After': String(lim.retryAfter), 'Cache-Control': 'no-store' })
  .json({ error: msg || `Too many requests from this address. Try again in ${lim.retryAfter} s.` });

// every POST/PUT/PATCH/DELETE under /api, per address. Generous: the app's own
// bursts (logging a slip, settling bets on open) stay far under it.
function writeLimit({ limit = 120, windowMs = 60e3, skip = () => false } = {}) {
  const lim = createWindowLimiter({ limit, windowMs });
  const mw = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || isLocal(req) || skip(req)) return next();
    const r = lim.take(callerIp(req));
    if (!r.ok) return tooMany(res, r);
    next();
  };
  mw.limiter = lim;
  return mw;
}

function csp({ connect = [], framedBy = "'self'" } = {}) {
  return [
    "default-src 'self'",
    // the app and the server-drawn pages use inline scripts and handlers
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${connect.join(' ')}`.trim(),
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${framedBy}`,
  ].join('; ');
}

function headers({ connect = [] } = {}) {
  const page = csp({ connect }), embed = csp({ connect, framedBy: '*' });
  return (req, res, next) => {
    const embeddable = req.path.startsWith('/embed/');
    res.set({
      'Content-Security-Policy': embeddable ? embed : page,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    if (!embeddable) res.set('X-Frame-Options', 'SAMEORIGIN');
    // HSTS only over https (Railway's proxy says so); never on local http
    if (String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim() === 'https') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

// the last middleware: a body that is not JSON, too big, or an error nobody caught
function jsonErrors(log = console) {
  return (err, req, res, next) => {
    if (res.headersSent) return;
    const t = err?.type;
    if (t === 'entity.parse.failed') return res.status(400).json({ error: 'The body is not valid JSON.' });
    if (t === 'entity.too.large') return res.status(413).json({ error: 'The body is too large.' });
    if (err?.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.expose ? err.message : 'Bad request.' });
    log.warn?.(`Unhandled route error ${req.method} ${req.path}: ${err?.message || err}`);
    res.status(500).json({ error: 'Something went wrong on our side. Try again in a minute.' });
  };
}

// what is set up for taking money, as booleans only (never the values)
function readiness(env = process.env) {
  const on = k => !!String(env[k] || '').trim();
  const paywall = /^(1|on|true|yes)$/i.test(String(env.PAYWALL || ''));
  const missing = [];
  if (paywall && !on('AUTH_SECRET')) missing.push('AUTH_SECRET (logins end at every restart)');
  if (paywall && !on('DATABASE_URL')) missing.push('DATABASE_URL (accounts live in a file on one container)');
  if (on('STRIPE_SECRET_KEY') && !on('STRIPE_WEBHOOK_SECRET')) missing.push('STRIPE_WEBHOOK_SECRET (paid plans never switch on)');
  if (!on('TRACKER_ADMIN_TOKEN')) missing.push('TRACKER_ADMIN_TOKEN (admin routes are off, and /api/ops/profile and /api/ops/heap are open to anyone)');
  else if (String(env.TRACKER_ADMIN_TOKEN).length < 24) missing.push('TRACKER_ADMIN_TOKEN is short: use 24+ random characters');
  // safe to set on a running deploy: the backup still reads the snapshot with
  // the Railway-id key and seals the next one with the new key, and connected
  // feeds still open with the old key
  if (!on('RESULTS_BACKUP_KEY')) missing.push('RESULTS_BACKUP_KEY (the backup and saved webhooks are sealed with a key made from Railway ids; a new service would not open them)');
  if (!on('FEED_SECRET')) missing.push('FEED_SECRET (connected Discord webhooks and bot tokens are sealed with the backup key)');
  return { paywall, ready: missing.length === 0, missing };
}

module.exports = { callerIp, isLocal, safeEqual, createWindowLimiter, writeLimit, tooMany, headers, csp, jsonErrors, readiness };
