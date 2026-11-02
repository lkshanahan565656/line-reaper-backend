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
// the same two off the event loop (scrypt takes ~50 ms of CPU; a burst of
// sign-ins must not stall every other request)
const scryptAsync = (pw, salt, len) => new Promise((ok, no) => crypto.scrypt(pw, salt, len, (e, k) => (e ? no(e) : ok(k))));
async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scryptAsync(password, salt, 64)).toString('hex')}`;
}
// a stored hash to check against when there is no account, so a wrong email
// costs the same time as a wrong password
const DUMMY_HASH = hashPassword('line-reaper-no-such-account');
async function verifyPasswordAsync(password, stored) {
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = await scryptAsync(password, Buffer.from(saltHex, 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}
// passwords and emails arrive as JSON: anything but a string is not one
const PASSWORD_MAX = 256;
const str = v => (typeof v === 'string' ? v : '');

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

// ── stores: get(id) / byEmail(e) / byCustomer(c) / count(fn) / put(user) ──
function indexed(rows) {
  return {
    get: id => rows.get(id) || null,
    byEmail: e => [...rows.values()].find(u => u.email === e) || null,
    byCustomer: c => [...rows.values()].find(u => u.stripeCustomerId === c) || null,
    // how many accounts match (founding seats taken, for the pricing page)
    count: fn => { let n = 0; for (const u of rows.values()) if (fn(u)) n++; return n; },
  };
}

function createMemoryUserStore() {
  const rows = new Map();
  return { kind: 'memory', async init() {}, ...wrap(indexed(rows)), async put(u) { rows.set(u.id, u); }, async remove(id) { rows.delete(id); } };
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
    async remove(id) {
      rows.delete(id);
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
    async remove(id) {
      rows.delete(id);
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    },
  };
}

function wrap(idx) {
  return { async get(id) { return idx.get(id); }, async byEmail(e) { return idx.byEmail(e); }, async byCustomer(c) { return idx.byCustomer(c); }, async count(fn) { return idx.count(fn); } };
}

function createUserStoreFromEnv(env = process.env) {
  if (env.DATABASE_URL) return createPgUserStore(env.DATABASE_URL);
  return createFileUserStore(env.USERS_FILE || path.join(process.env.LR_DATA_DIR || path.join(__dirname, 'data'), 'users.json'));
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

// Comped; active / trialing / past_due (Stripe still retrying) within the
// period; or cancelled at period end and still inside the paid period.
// Anything else (incomplete, incomplete_expired, unpaid, paused, ...) is not Pro.
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);
const RENEWAL_GRACE_MS = 3 * 86400000;
function isPro(u, now = Date.now()) {
  if (!u) return false;
  if (u.comp) return true;                                    // comped by the owner
  const end = u.currentPeriodEnd ? new Date(u.currentPeriodEnd).getTime() : null;
  const inPeriod = end != null && isFinite(end) && end > now;
  // a paying sub gets 3 days past its period end, so a late renewal webhook
  // doesn't lock out someone who has paid
  if (PAID_STATUSES.has(u.planStatus)) return end == null || !isFinite(end) || end + RENEWAL_GRACE_MS > now;
  if (u.planStatus === 'canceled') return inPeriod;
  return false;
}

// termsVersion: when set, sign-up needs consent { terms: true, age: true } and
// records which version was accepted (legal.js TERMS_VERSION).
function createAuth({ store, secret, now = () => Date.now(), termsVersion = null, minAge = 21 }) {
  if (!secret) throw new Error('createAuth: secret required');
  const ready = store.init();

  async function signup(email, password, consent = {}) {
    await ready;
    const e = str(email).trim().toLowerCase();
    if (!EMAIL_RE.test(e) || e.length > 254) throw httpError(400, 'Enter a valid email');
    if (str(password).length < 8) throw httpError(400, 'Password must be at least 8 characters');
    if (str(password).length > PASSWORD_MAX) throw httpError(400, `Password must be at most ${PASSWORD_MAX} characters`);
    if (termsVersion) {
      if (consent.age !== true) throw httpError(400, `Confirm you are ${minAge} or older`);
      if (consent.terms !== true) throw httpError(400, 'Agree to the Terms of Service and Privacy Policy to continue');
    }
    if (await store.byEmail(e)) throw httpError(409, 'An account with that email already exists');
    const at = new Date(now()).toISOString();
    const user = { id: crypto.randomUUID(), email: e, passwordHash: await hashPasswordAsync(password), createdAt: at, plan: 'free' };
    if (termsVersion) user.consent = { termsVersion, acceptedAt: at, ageConfirmed: minAge, ip: consent.ip ? String(consent.ip).slice(0, 64) : null };
    await store.put(user);
    return { user: publicUser(user), token: signToken({ sub: user.id }, secret, now()) };
  }

  async function login(email, password) {
    await ready;
    const pw = str(password).slice(0, PASSWORD_MAX + 1);
    const user = await store.byEmail(str(email).trim().toLowerCase());
    // same message and the same work either way, so the endpoint can't be used to find accounts
    const ok = await verifyPasswordAsync(pw, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok || pw.length > PASSWORD_MAX) throw httpError(401, 'Wrong email or password');
    return { user: publicUser(user), token: signToken({ sub: user.id }, secret, now()) };
  }

  // Deletes the account for good. A live paid subscription must be cancelled
  // first (Billing), so a deleted account can't keep being charged.
  async function deleteAccount(user, password) {
    await ready;
    if (!user) throw httpError(401, 'Log in first');
    const fresh = await store.get(user.id);
    if (!fresh) throw httpError(404, 'Account not found');
    if (!(await verifyPasswordAsync(str(password).slice(0, PASSWORD_MAX + 1), fresh.passwordHash))) throw httpError(401, 'Wrong password');
    if (!fresh.comp && PAID_STATUSES.has(fresh.planStatus) && !fresh.cancelAtPeriodEnd) {
      throw httpError(409, 'Cancel your subscription in Billing first, then delete the account');
    }
    await store.remove(fresh.id);
    return { deleted: true };
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

  return { signup, login, deleteAccount, fromToken, attach, store, ready: () => ready, termsVersion };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = {
  hashPassword, verifyPassword, hashPasswordAsync, verifyPasswordAsync, PASSWORD_MAX, signToken, verifyToken, createAuth, publicUser, isPro, httpError,
  createMemoryUserStore, createFileUserStore, createPgUserStore, createUserStoreFromEnv, TOKEN_TTL_MS,
};
