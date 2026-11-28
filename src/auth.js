const crypto = require('crypto');
const { db } = require('./db');

const COOKIE = 'yasser_sid';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

// Every visitor gets a session token (cookie). A database row is only written when the session holds
// something (a cart, or a logged-in user), so bots and one-page visits don't fill the sessions table.
const TOKEN_RE = /^[a-f0-9]{64}$/;
function sessionMiddleware(req, res, next) {
  let token = req.cookies[COOKIE];
  let session = TOKEN_RE.test(token || '') ? db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) : null;
  if (!session) {
    if (!TOKEN_RE.test(token || '')) {
      token = crypto.randomBytes(32).toString('hex');
      if (!req.stateless) setCookie(res, token);
    }
    session = { token, user_id: null, cart: '{}', persisted: false };
  } else {
    session.persisted = true;
    // Track activity (at most every 10 minutes) so old sessions can be cleaned up.
    if (!session.last_seen || Date.now() - Date.parse(session.last_seen + 'Z') > 10 * 60 * 1000) {
      db.prepare("UPDATE sessions SET last_seen = datetime('now') WHERE token = ?").run(token);
    }
  }
  req.session = session;
  req.cart = JSON.parse(session.cart || '{}');
  req.user = session.user_id
    ? db.prepare('SELECT id, name, email, role, suspended FROM users WHERE id = ?').get(session.user_id)
    : null;
  // Admins listed in ADMIN_EMAILS are promoted automatically on their next request.
  if (req.user && req.user.role !== 'admin' && ADMIN_EMAILS.includes(req.user.email)) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(req.user.id);
    req.user.role = 'admin';
  }
  // A suspended account is signed out.
  if (req.user?.suspended) {
    db.prepare('UPDATE sessions SET user_id = NULL WHERE token = ?').run(session.token);
    req.user = null;
  }
  if (req.user) req.user.isAdmin = req.user.role === 'admin';
  res.locals.user = req.user;
  next();
}

function saveCart(req) {
  db.prepare(
    `INSERT INTO sessions (token, cart, last_seen) VALUES (?, ?, datetime('now'))
     ON CONFLICT(token) DO UPDATE SET cart = excluded.cart, last_seen = excluded.last_seen`
  ).run(req.session.token, JSON.stringify(req.cart));
  req.session.persisted = true;
}

// Remove sessions nobody will come back to. Returns the number of rows deleted.
function cleanupSessions() {
  const r = db.prepare(
    `DELETE FROM sessions WHERE
       (user_id IS NULL AND cart IN ('{}', '') AND COALESCE(last_seen, created_at) < datetime('now', '-1 day'))
       OR COALESCE(last_seen, created_at) < datetime('now', '-30 days')`
  ).run();
  db.prepare('DELETE FROM password_resets WHERE expires_at < ? OR used = 1').run(Date.now() - 24 * 3600 * 1000);
  return r.changes;
}

function setCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

// Issue a fresh session token on login (prevents session fixation); the cart is kept.
function login(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions (token, user_id, cart, last_seen) VALUES (?, ?, ?, datetime('now'))").run(token, userId, JSON.stringify(req.cart || {}));
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.session.token);
  setCookie(res, token);
}

// Sign the user out everywhere (used after a password change).
function logoutEverywhere(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function logout(req) {
  db.prepare('UPDATE sessions SET user_id = NULL WHERE token = ?').run(req.session.token);
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (!req.user.isAdmin) return res.status(404).render('message', { title: 'غير موجود', message: 'الصفحة غير موجودة.' });
  next();
}

module.exports = { hashPassword, verifyPassword, sessionMiddleware, saveCart, login, logout, logoutEverywhere, requireLogin, requireAdmin, cleanupSessions };
