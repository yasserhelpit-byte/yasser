// Notifications: stored in the database (bell menu), pushed to the user's devices (Web Push, works
// with the browser closed), and optionally emailed - each according to the user's preferences.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { db } = require('./db');
const mailer = require('./mailer');

// What can be notified, and the defaults for each channel.
const KINDS = {
  order: { label: 'طلب جديد', icon: '🛒', push: true, email: true },
  chat: { label: 'رسائل العملاء', icon: '💬', push: true, email: true },
  stock: { label: 'مخزون منخفض', icon: '⚠️', push: true, email: false },
  review: { label: 'تقييمات المنتجات', icon: '⭐', push: true, email: false },
  billing: { label: 'الاشتراك والباقات', icon: '💎', push: true, email: true },
  admin: { label: 'إدارة المنصة (للمسؤول)', icon: '🛡️', push: true, email: false, adminOnly: true },
};

// VAPID keys identify this server to the browsers' push services. From env, or generated once and
// kept in the data directory (changing them would invalidate every device subscription).
function loadVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const file = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'vapid.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}
const vapid = loadVapid();
const subject = process.env.VAPID_SUBJECT || (/^https:/.test(process.env.BASE_URL || '') ? process.env.BASE_URL : 'mailto:admin@yasser.local');
webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);

function prefsOf(user) {
  let saved = {};
  try { saved = JSON.parse(user.notify_prefs || '{}'); } catch {}
  const out = {};
  for (const [k, d] of Object.entries(KINDS)) out[k] = { push: saved[k]?.push ?? d.push, email: saved[k]?.email ?? d.email };
  return out;
}

// Send one payload to every device of a user; forget devices the push service says are gone.
async function pushToUser(userId, payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  await Promise.all(subs.map(async (s) => {
    try {
      await module.exports.transport.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      db.prepare("UPDATE push_subscriptions SET last_ok = datetime('now') WHERE id = ?").run(s.id);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      else console.error('Push failed:', err.statusCode || '', err.message);
    }
  }));
  return subs.length;
}

/**
 * notify(userId, { kind, title, body, link, storeId, tag, email: { subject, text, html } })
 * Stores the notification, then pushes and emails in the background (never throws).
 */
function notify(userId, n) {
  const user = db.prepare('SELECT id, email, notify_prefs FROM users WHERE id = ?').get(userId);
  if (!user || !KINDS[n.kind]) return null;
  // collapse: update an unread notification with the same link instead of adding another (chat threads).
  const prev = n.collapse && n.link
    ? db.prepare('SELECT id FROM notifications WHERE user_id = ? AND link = ? AND read_at IS NULL ORDER BY id DESC LIMIT 1').get(user.id, n.link)
    : null;
  let lastInsertRowid;
  if (prev) {
    db.prepare("UPDATE notifications SET title = ?, body = ?, created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
      .run(String(n.title).slice(0, 200), String(n.body || '').slice(0, 500), prev.id);
    lastInsertRowid = prev.id;
  } else {
    lastInsertRowid = db.prepare('INSERT INTO notifications (user_id, store_id, kind, title, body, link) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, n.storeId || null, n.kind, String(n.title).slice(0, 200), String(n.body || '').slice(0, 500), n.link || '').lastInsertRowid;
  }
  const prefs = prefsOf(user)[n.kind];
  if (prefs.push) {
    pushToUser(user.id, { title: n.title, body: n.body || '', url: n.link || '/dashboard', tag: n.tag || `${n.kind}-${lastInsertRowid}` })
      .catch((e) => console.error('Push error:', e.message));
  }
  if (prefs.email && n.email) mailer.send({ to: user.email, ...n.email });
  return Number(lastInsertRowid);
}

function notifyAdmins(n) {
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND suspended = 0").all()) notify(a.id, { ...n, kind: 'admin' });
}

module.exports = {
  KINDS, notify, notifyAdmins, pushToUser, prefsOf,
  vapidPublicKey: vapid.publicKey,
  // Replaceable in tests.
  transport: { send: (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: 'high' }) },
};
