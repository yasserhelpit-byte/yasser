const crypto = require('crypto');
const { db } = require('./db');

const COOKIE = 'yasser_sid';

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

// Every visitor gets a session (holds the cart); logging in attaches a user.
function sessionMiddleware(req, res, next) {
  let token = req.cookies[COOKIE];
  let session = token && db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) {
    token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token) VALUES (?)').run(token);
    session = { token, user_id: null, cart: '{}' };
    setCookie(res, token);
  }
  req.session = session;
  req.cart = JSON.parse(session.cart || '{}');
  req.user = session.user_id
    ? db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(session.user_id)
    : null;
  res.locals.user = req.user;
  next();
}

function saveCart(req) {
  db.prepare('UPDATE sessions SET cart = ? WHERE token = ?').run(JSON.stringify(req.cart), req.session.token);
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
  db.prepare('INSERT INTO sessions (token, user_id, cart) VALUES (?, ?, ?)').run(token, userId, JSON.stringify(req.cart || {}));
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

module.exports = { hashPassword, verifyPassword, sessionMiddleware, saveCart, login, logout, logoutEverywhere, requireLogin };
