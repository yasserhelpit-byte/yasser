// Store visitor analytics, privacy-friendly: no IP, no cookie of our own, no personal data. A visit is a
// one-way hash of (store, session, day), so the same person is counted once per day and can't be traced.
const crypto = require('crypto');
const { db } = require('./db');

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp\/|telegram|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|go-http/i;
const SOURCES = {
  facebook: { label: 'فيسبوك', icon: '📘' }, instagram: { label: 'إنستغرام', icon: '📸' }, tiktok: { label: 'تيك توك', icon: '🎵' },
  google: { label: 'Google', icon: '🔎' }, whatsapp: { label: 'واتساب', icon: '💬' }, youtube: { label: 'يوتيوب', icon: '▶️' },
  other: { label: 'مواقع أخرى', icon: '🌐' }, direct: { label: 'مباشر / رابط محفوظ', icon: '🔗' },
};

// Where a visitor came from: ?utm_source=… first, then the referring site.
function sourceOf(req) {
  const utm = String(req.query.utm_source || req.query.ref || '').toLowerCase();
  const ref = String(req.get('referer') || '').toLowerCase();
  const host = (() => { try { return new URL(ref).hostname; } catch { return ''; } })();
  const s = `${utm} ${host}`;
  if (/(^|\W)(fb|facebook)|fbclid/.test(s) || req.query.fbclid) return 'facebook';
  if (/instagram|(^|\W)ig(\W|$)/.test(s)) return 'instagram';
  if (/tiktok/.test(s) || req.query.ttclid) return 'tiktok';
  if (/google/.test(s) || req.query.gclid) return 'google';
  if (/whatsapp|wa\.me/.test(s)) return 'whatsapp';
  if (/youtube|youtu\.be/.test(s)) return 'youtube';
  if (host && host !== String(req.get('host') || '').toLowerCase().replace(/:\d+$/, '')) return 'other';
  if (utm) return 'other';
  return host ? '' : 'direct'; // '' = a page inside the store (not the start of a visit)
}

const insert = db.prepare('INSERT INTO visits (store_id, day, vkey, kind, product_id, source) VALUES (?, ?, ?, ?, ?, ?)');
// Record one page view. kind: home | list | product | page | cart | checkout.
function track(req, store, kind, productId = null) {
  try {
    if (req.method !== 'GET' || BOT.test(req.get('user-agent') || '')) return;
    if (req.user && (req.user.id === store.owner_id || req.user.isAdmin)) return; // the merchant browsing their own store
    const day = new Date().toISOString().slice(0, 10);
    const vkey = crypto.createHash('sha256').update(`${store.id}:${req.session.token}:${day}`).digest('hex').slice(0, 20);
    insert.run(store.id, day, vkey, kind, productId, sourceOf(req));
  } catch {}
}

// Everything the analytics page shows, for the last `days` days.
function report(storeId, days) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const q = (sql, ...a) => db.prepare(sql).all(storeId, since, ...a);
  const one = (sql, ...a) => db.prepare(sql).get(storeId, since, ...a);
  const totals = one(`SELECT COUNT(DISTINCT day || vkey) AS visitors, COUNT(*) AS views,
      COUNT(DISTINCT CASE WHEN kind = 'product' THEN day || vkey END) AS productVisitors,
      COUNT(DISTINCT CASE WHEN kind IN ('cart', 'checkout') THEN day || vkey END) AS checkoutVisitors
    FROM visits WHERE store_id = ? AND day >= ?`);
  const orders = one(`SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS revenue FROM orders WHERE store_id = ? AND date(created_at) >= ?
    AND status != 'cancelled' AND payment_status NOT IN ('pending', 'failed', 'expired')`);
  const perDay = Object.fromEntries(q(`SELECT day, COUNT(DISTINCT vkey) AS v FROM visits WHERE store_id = ? AND day >= ? GROUP BY day`).map((r) => [r.day, r.v]));
  const ordersDay = Object.fromEntries(q(`SELECT date(created_at) AS day, COUNT(*) AS v FROM orders WHERE store_id = ? AND date(created_at) >= ?
    AND status != 'cancelled' AND payment_status NOT IN ('pending', 'failed', 'expired') GROUP BY day`).map((r) => [r.day, r.v]));
  const daysList = [];
  for (let i = days - 1; i >= 0; i--) daysList.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  // A visit's source = the source of its first page view that day.
  const sources = q(`SELECT source, COUNT(*) AS n FROM (
      SELECT v.source FROM visits v WHERE v.store_id = ? AND v.day >= ? AND v.source != ''
        AND v.rowid = (SELECT MIN(rowid) FROM visits w WHERE w.store_id = v.store_id AND w.day = v.day AND w.vkey = v.vkey AND w.source != '')
    ) GROUP BY source ORDER BY n DESC`);
  const products = db.prepare(`SELECT p.id, p.name, p.image_url, COUNT(DISTINCT v.day || v.vkey) AS views,
      (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id = p.id AND o.status != 'cancelled' AND date(o.created_at) >= $since) AS sold
    FROM visits v JOIN products p ON p.id = v.product_id
    WHERE v.store_id = $store AND v.day >= $since AND v.kind = 'product'
    GROUP BY p.id ORDER BY views DESC LIMIT 10`).all({ store: storeId, since });
  return {
    days, totals, orders,
    conversion: totals.visitors ? (orders.n / totals.visitors) * 100 : 0,
    visitors: daysList.map((d) => ({ day: d, v: perDay[d] || 0 })),
    ordersSeries: daysList.map((d) => ({ day: d, v: ordersDay[d] || 0 })),
    sources: sources.map((s) => ({ ...s, ...(SOURCES[s.source] || SOURCES.other) })),
    products,
  };
}

const cleanup = (keepDays = 400) => db.prepare("DELETE FROM visits WHERE day < date('now', ?)").run(`-${keepDays} days`).changes;

module.exports = { track, report, cleanup, sourceOf, SOURCES, BOT };
