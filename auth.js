// ─── ACCOUNTS ─────────────────────────────────────────────────────────────────
// Email + password accounts with signed bearer tokens. No new dependencies:
// passwords use Node's scrypt, tokens are an HMAC-SHA256 over a small JSON
// payload (the same idea as a JWT, minus the parts we don't need).
//
// Storage follows the tracker: Postgres when DATABASE_URL is set, otherwise
// memory/file. Users are small documents keyed by id with an email index.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_TTL_MS = 30 * 86400000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── passwords ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}

// ── tokens ──
const b64u = buf => Buffer.from(buf).toString('base64url');

function signToken(payload, secret, now = Date.now()) {
  const body = b64u(JSON.stringify({ ...payload, exp: now + TOKEN_TTL_MS }));
  const sig = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function verifyToken(token, secret, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > now ? payload : null;
  } catch { return null; }
}

// ── stores: all() / get(id) / byEmail(e) / byCustomer(c) / put(user) ──
function indexed(rows) {
  return {
    get: id => rows.get(id) || null,
    byEmail: e => [...rows.values()].find(u => u.email === e) || null,
    byCustomer: c => [...rows.values()].find(u => u.stripeCustomerId === c) || null,
  };
}

function createMemoryUserStore() {
  const rows = new Map();
  return { kind: 'memory', async init() {}, ...wrap(indexed(rows)), async put(u) { rows.set(u.id, u); } };
}

function createFileUserStore(file) {
  const rows = new Map();
  let writing = Promise.resolve();
  return {
    kind: 'file',
    async init() {
      try { for (const u of JSON.parse(fs.readFileSync(file, 'utf8'))) rows.set(u.id, u); }
      catch (e) { if (e.code !== 'ENOENT') console.warn(`Users: could not read ${file}: ${e.message}`); }
    },
    ...wrap(indexed(rows)),
    async put(u) {
      rows.set(u.id, u);
      writing = writing.then(() => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify([...rows.values()]));
        fs.renameSync(`${file}.tmp`, file);
      }).catch(e => console.warn(`Users: write failed: ${e.message}`));
      return writing;
    },
  };
}

function createPgUserStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  const rows = new Map();
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, doc JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const r = await pool.query('SELECT doc FROM users');
      for (const { doc } of r.rows) rows.set(doc.id, doc);
    },
    ...wrap(indexed(rows)),
    async put(u) {
      rows.set(u.id, u);
      await pool.query(
        `INSERT INTO users (id, email, doc) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, doc = EXCLUDED.doc, updated_at = now()`,
        [u.id, u.email, u]);
    },
  };
}

function wrap(idx) {
  return { async get(id) { return idx.get(id); }, async byEmail(e) { return idx.byEmail(e); }, async byCustomer(c) { return idx.byCustomer(c); } };
}

function createUserStoreFromEnv(env = process.env) {
  if (env.DATABASE_URL) return createPgUserStore(env.DATABASE_URL);
  return createFileUserStore(env.USERS_FILE || path.join(__dirname, 'data', 'users.json'));
}

// What the client is allowed to see about a user.
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, createdAt: u.createdAt,
    plan: u.plan || 'free', planStatus: u.planStatus || null,
    currentPeriodEnd: u.currentPeriodEnd || null, isPro: isPro(u),
  };
}

// Active, trialing, or paid through the end of a cancelled period.
function isPro(u, now = Date.now()) {
  if (!u) return false;
  if (u.comp) return true;                                    // comped by the owner
  if (u.planStatus === 'active' || u.planStatus === 'trialing') return true;
  return !!(u.currentPeriodEnd && new Date(u.currentPeriodEnd).getTime() > now && u.planStatus !== 'unpaid');
}

function createAuth({ store, secret, now = () => Date.now() }) {
  if (!secret) throw new Error('createAuth: secret required');
  const ready = store.init();

  async function signup(email, password) {
    await ready;
    const e = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(e)) throw httpError(400, 'Enter a valid email');
    if (String(password || '').length < 8) throw httpError(400, 'Password must be at least 8 characters');
    if (await store.byEmail(e)) throw httpError(409, 'An account with that email already exists');
    const user = { id: crypto.randomUUID(), email: e, passwordHash: hashPassword(password), createdAt: new Date(now()).toISOString(), plan: 'free' };
    await store.put(user);
    return { user: publicUser(user), token: signToken({ sub: user.id }, secret, now()) };
  }

  async function login(email, password) {
    await ready;
    const user = await store.byEmail(String(email || '').trim().toLowerCase());
    // same message either way, so the endpoint can't be used to find accounts
    if (!user || !verifyPassword(String(password || ''), user.passwordHash)) throw httpError(401, 'Wrong email or password');
    return { user: publicUser(user), token: signToken({ sub: user.id }, secret, now()) };
  }

  async function fromToken(token) {
    await ready;
    const p = verifyToken(token, secret, now());
    return p ? store.get(p.sub) : null;
  }

  // Express middleware: sets req.user when a valid token is present.
  // Accepts "Authorization: Bearer <t>" or ?token= (EventSource can't set headers).
  function attach() {
    return async (req, res, next) => {
      const h = req.get('authorization') || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : req.query?.token;
      try { req.user = token ? await fromToken(token) : null; } catch { req.user = null; }
      next();
    };
  }

  return { signup, login, fromToken, attach, store, ready: () => ready };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = {
  hashPassword, verifyPassword, signToken, verifyToken, createAuth, publicUser, isPro, httpError,
  createMemoryUserStore, createFileUserStore, createPgUserStore, createUserStoreFromEnv, TOKEN_TTL_MS,
};
