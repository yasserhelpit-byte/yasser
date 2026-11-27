const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, transaction } = require('./db');
const auth = require('./auth');
const uploads = require('./uploads');
const limiter = require('./limiter');
const mailer = require('./mailer');
const sections = require('./sections');

const app = express();
// Behind one reverse proxy (Codespaces, Render, Railway...): use X-Forwarded-For for req.ip.
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(uploads.uploadsDir, { maxAge: '30d', immutable: true }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(auth.sessionMiddleware);

// CSRF: a per-session token derived from the session token, checked on every POST.
const CSRF_SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
app.use((req, res, next) => {
  const csrf = crypto.createHmac('sha256', CSRF_SECRET).update(req.session.token).digest('hex');
  res.locals.csrf = csrf;
  res.locals.flash = null;
  const sent = req.body?._csrf || req.get('x-csrf-token');
  if (req.method === 'POST' && sent !== csrf) {
    return res.status(403).render('message', { title: 'خطأ', message: 'انتهت صلاحية النموذج، أعد المحاولة.' });
  }
  next();
});

const STATUSES = {
  new: 'جديد',
  confirmed: 'مؤكد',
  shipped: 'تم الشحن',
  delivered: 'تم التسليم',
  cancelled: 'ملغى',
};
app.locals.STATUSES = STATUSES;
const FONTS = {
  tajawal: { label: 'Tajawal · عصري', css: "'Tajawal'", g: 'Tajawal:wght@400;500;700;800' },
  cairo: { label: 'Cairo · واضح', css: "'Cairo'", g: 'Cairo:wght@400;600;700;800' },
  almarai: { label: 'Almarai · ناعم', css: "'Almarai'", g: 'Almarai:wght@400;700;800' },
  plex: { label: 'IBM Plex · أنيق', css: "'IBM Plex Sans Arabic'", g: 'IBM+Plex+Sans+Arabic:wght@400;500;700' },
  kufi: { label: 'Noto Kufi · فاخر', css: "'Noto Kufi Arabic'", g: 'Noto+Kufi+Arabic:wght@400;600;800' },
  amiri: { label: 'Amiri · كلاسيكي', css: "'Amiri'", g: 'Amiri:wght@400;700' },
};
const RADII = { sharp: { label: 'حادة', v: '2px' }, soft: { label: 'ناعمة', v: '12px' }, round: { label: 'دائرية', v: '22px' } };
const HEADERS = { classic: 'كلاسيكي (الشعار يميناً)', centered: 'الشعار في الوسط' };
app.locals.FONTS = FONTS;
app.locals.RADII = RADII;
app.locals.HEADERS = HEADERS;
app.locals.SCHEMA = sections.SCHEMA;
// Safe for embedding inside <script>: no "</script>" breakout.
app.locals.js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
app.locals.json = (v, fallback = []) => { try { return JSON.parse(v); } catch { return fallback; } };
app.locals.money = (n, cur) => `${Number(n).toFixed(2)} ${cur || ''}`.trim();

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const slugify = (s) =>
  str(s, 60).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

// ---------- Public pages ----------
app.get('/', (req, res) => {
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM stores) AS stores,
              (SELECT COUNT(*) FROM products WHERE active = 1) AS products,
              (SELECT COUNT(*) FROM orders) AS orders`
    )
    .get();
  res.render('home', { counts });
});

// Phone helpers. Local numbers starting with 0 get the default country code (Morocco unless configured).
const COUNTRY_CODE = (process.env.COUNTRY_CODE || '212').replace(/\D/g, '');
const cleanPhone = (v) => str(v, 30).replace(/[\s.\-()]/g, '');
const validPhone = (p) => /^(\+|00)?\d{9,15}$/.test(p);
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (String(phone).trim().startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = COUNTRY_CODE + d.slice(1);
  return d;
}
app.locals.waNumber = waNumber;

const baseUrl = (req) => process.env.BASE_URL || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
const MIN = 60 * 1000;

app.get('/signup', (req, res) => res.render('signup', { error: null, values: {} }));
app.post('/signup', (req, res) => {
  const name = str(req.body.name, 100);
  const email = str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  let error = null;
  if (!limiter.hit(`signup:${req.ip}`, 5, 60 * MIN)) error = 'محاولات كثيرة. حاول مرة أخرى بعد قليل.';
  else if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error = 'الرجاء إدخال الاسم والبريد الإلكتروني بشكل صحيح.';
  else if (password.length < 8) error = 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.';
  else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) error = 'هذا البريد مسجل مسبقاً.';
  if (error) return res.status(400).render('signup', { error, values: { name, email } });
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email, auth.hashPassword(password));
  auth.login(req, res, Number(lastInsertRowid));
  res.redirect('/dashboard');
});

// Login: max 5 failed attempts per email+IP and 20 per IP, per 15 minutes.
const LOGIN_WINDOW = 15 * MIN;
app.get('/login', (req, res) => res.render('login', { error: null, values: {}, notice: req.query.reset ? 'تم تغيير كلمة المرور. سجّل الدخول بكلمة المرور الجديدة.' : null }));
app.post('/login', (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const keyUser = `login:${email}:${req.ip}`;
  const keyIp = `login-ip:${req.ip}`;
  if (limiter.count(keyUser, LOGIN_WINDOW) >= 5 || limiter.count(keyIp, LOGIN_WINDOW) >= 20) {
    const wait = Math.max(limiter.retryAfterMin(keyUser, LOGIN_WINDOW), 1);
    return res.status(429).render('login', { error: `محاولات دخول فاشلة كثيرة. حاول مرة أخرى بعد ${wait} دقيقة، أو استعمل «نسيت كلمة المرور».`, values: { email }, notice: null });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !auth.verifyPassword(String(req.body.password || ''), user.password_hash)) {
    limiter.hit(keyUser, Infinity, LOGIN_WINDOW);
    limiter.hit(keyIp, Infinity, LOGIN_WINDOW);
    const left = 5 - limiter.count(keyUser, LOGIN_WINDOW);
    const error = 'البريد أو كلمة المرور غير صحيحة.' + (left <= 2 && left > 0 ? ` (تبقّت ${left} محاولة)` : '');
    return res.status(400).render('login', { error, values: { email }, notice: null });
  }
  if (user.suspended) return res.status(403).render('login', { error: 'هذا الحساب موقوف. تواصل مع إدارة المنصة.', values: { email }, notice: null });
  limiter.reset(keyUser);
  auth.login(req, res, user.id);
  res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
});

// Password reset: emailed link valid for 1 hour, single use. Only a hash of the token is stored.
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
app.get('/forgot', (req, res) => res.render('forgot', { error: null, sent: false, values: {} }));
app.post('/forgot', async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!limiter.hit(`forgot:${req.ip}`, 5, 60 * MIN) || !limiter.hit(`forgot:${email}`, 3, 60 * MIN)) {
    return res.status(429).render('forgot', { error: 'طلبات كثيرة. حاول مرة أخرى بعد ساعة.', sent: false, values: { email } });
  }
  const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(user.id, Date.now());
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, Date.now() + 60 * MIN);
    const link = `${baseUrl(req)}/reset/${token}`;
    await mailer.send({
      to: user.email,
      subject: 'إعادة تعيين كلمة المرور · YASSER',
      text: `مرحباً ${user.name}،\n\nلإعادة تعيين كلمة المرور افتح هذا الرابط (صالح لمدة ساعة):\n${link}\n\nإذا لم تطلب ذلك، تجاهل هذه الرسالة.`,
      html: mailer.layout('إعادة تعيين كلمة المرور', `<p>مرحباً ${mailer.esc(user.name)}،</p><p>اضغط الزر لاختيار كلمة مرور جديدة. الرابط صالح لمدة ساعة واحدة.</p>
        <p><a href="${mailer.esc(link)}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">تعيين كلمة مرور جديدة</a></p>
        <p style="color:#667085;font-size:13px">إذا لم تطلب ذلك، تجاهل هذه الرسالة وستبقى كلمة مرورك كما هي.</p>`),
    });
  }
  // Same answer whether or not the email exists, so accounts can't be enumerated.
  res.render('forgot', { error: null, sent: true, values: { email } });
});

function findReset(token) {
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(String(token || '')));
  return row && !row.used && row.expires_at > Date.now() ? row : null;
}
app.get('/reset/:token', (req, res) => {
  if (!findReset(req.params.token)) return res.status(400).render('reset', { error: null, invalid: true, token: '' });
  res.render('reset', { error: null, invalid: false, token: req.params.token });
});
app.post('/reset/:token', (req, res) => {
  const row = findReset(req.params.token);
  if (!row) return res.status(400).render('reset', { error: null, invalid: true, token: '' });
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).render('reset', { error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.', invalid: false, token: req.params.token });
  if (password !== req.body.password2) return res.status(400).render('reset', { error: 'كلمتا المرور غير متطابقتين.', invalid: false, token: req.params.token });
  transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), row.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(row.token_hash);
    auth.logoutEverywhere(row.user_id);
  });
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(row.user_id);
  limiter.reset(`login:${user.email}:${req.ip}`);
  res.redirect('/login?reset=1');
});

app.post('/logout', (req, res) => {
  auth.logout(req);
  res.redirect('/');
});

// ---------- Merchant dashboard ----------
const dash = express.Router();
dash.use(auth.requireLogin);
const shell = (req, res, next) => {
  res.locals.shell = true;
  res.locals.path = req.originalUrl.split('?')[0];
  // Sidebar store switcher.
  res.locals.myStores = db.prepare('SELECT id, name, color, logo_url FROM stores WHERE owner_id = ? ORDER BY id').all(req.user.id);
  next();
};
dash.use(shell);
const pendingFor = (userId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM orders o JOIN stores s ON s.id = o.store_id WHERE s.owner_id = ? AND o.status = 'new'`).get(userId).n;
dash.use((req, res, next) => {
  res.locals.pendingOrders = pendingFor(req.user.id);
  next();
});

// Polled by the dashboard every 30s to alert the merchant about new orders.
dash.get('/notifications', (req, res) => {
  const latest = db
    .prepare(
      `SELECT o.id, o.store_id, o.customer_name, o.total, s.name AS store_name, s.currency
       FROM orders o JOIN stores s ON s.id = o.store_id WHERE s.owner_id = ? ORDER BY o.id DESC LIMIT 1`
    )
    .get(req.user.id);
  res.json({ pending: res.locals.pendingOrders, latest: latest || null });
});

function ownStore(req, res, next) {
  const store = req.user.isAdmin
    ? db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.storeId)
    : db.prepare('SELECT * FROM stores WHERE id = ? AND owner_id = ?').get(req.params.storeId, req.user.id);
  if (!store) return res.status(404).render('message', { title: 'غير موجود', message: 'المتجر غير موجود.' });
  req.store = store;
  res.locals.store = store;
  // An admin working inside someone else's store sees a clear banner.
  if (store.owner_id !== req.user.id) {
    res.locals.actingAs = db.prepare('SELECT name, email FROM users WHERE id = ?').get(store.owner_id);
  }
  next();
}

dash.get('/', (req, res) => {
  const stores = db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS product_count,
        (SELECT COUNT(*) FROM orders o WHERE o.store_id = s.id) AS order_count,
        (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.store_id = s.id AND o.status != 'cancelled') AS revenue
       FROM stores s WHERE owner_id = ? ORDER BY id`
    )
    .all(req.user.id);
  const totals = db
    .prepare(
      `SELECT COUNT(o.id) AS orders,
              COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total END), 0) AS revenue,
              COALESCE(SUM(o.status = 'new'), 0) AS pending,
              COUNT(DISTINCT o.customer_phone) AS customers
       FROM orders o JOIN stores s ON s.id = o.store_id WHERE s.owner_id = ?`
    )
    .get(req.user.id);
  const recentOrders = db
    .prepare(
      `SELECT o.*, s.name AS store_name, s.currency, s.color
       FROM orders o JOIN stores s ON s.id = o.store_id
       WHERE s.owner_id = ? ORDER BY o.id DESC LIMIT 8`
    )
    .all(req.user.id);
  const lowStock = db
    .prepare(
      `SELECT p.id, p.name, p.stock, s.id AS store_id, s.name AS store_name
       FROM products p JOIN stores s ON s.id = p.store_id
       WHERE s.owner_id = ? AND p.active = 1 AND p.stock <= 3 ORDER BY p.stock LIMIT 5`
    )
    .all(req.user.id);
  // Currency shown on totals: the first store's (mixed currencies are summed as-is).
  const currency = stores[0]?.currency || 'MAD';
  const first = stores[0];
  const steps = [
    { done: stores.length > 0, label: 'أنشئ متجرك', href: '/dashboard/stores/new' },
    { done: stores.some((s) => s.product_count > 0), label: 'أضف أول منتج', href: first ? `/dashboard/stores/${first.id}/products/new` : '/dashboard/stores/new' },
    { done: stores.some((s) => s.description), label: 'أضف وصفاً لمتجرك', href: first ? `/dashboard/stores/${first.id}/settings` : '/dashboard/stores/new' },
    { done: totals.orders > 0, label: 'شارك رابط متجرك واستقبل أول طلب', href: first ? `/s/${first.slug}` : '/dashboard/stores/new' },
  ];
  res.render('dashboard/index', { stores, totals, recentOrders, lowStock, currency, steps });
});

dash.get('/stores/new', (req, res) => res.render('dashboard/store-form', { error: null, values: {}, action: '/dashboard/stores' }));
dash.post('/stores', (req, res) => {
  const values = readStoreForm(req.body);
  const error = validateStore(values);
  if (error) return res.status(400).render('dashboard/store-form', { error, values, action: '/dashboard/stores' });
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO stores (owner_id, ${STORE_FIELDS.join(', ')}) VALUES (?, ${STORE_FIELDS.map(() => '?').join(', ')})`)
    .run(req.user.id, ...STORE_FIELDS.map((f) => values[f]));
  res.redirect(`/dashboard/stores/${lastInsertRowid}`);
});

const STORE_FIELDS = 'name, slug, description, color, currency, logo_url, banner_url, tagline, announcement, whatsapp, phone, email, instagram, facebook, tiktok, city, shipping_fee, free_shipping_over'.split(', ');
const url = (v) => (/^https?:\/\//i.test(str(v, 1000)) ? str(v, 1000) : '');
const money0 = (v) => Math.max(0, Number(v) || 0);
// Accept a full profile URL or just a username for social links.
const social = (v, base) => {
  const s = str(v, 300).replace(/^@/, '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : base + encodeURIComponent(s);
};

function readStoreForm(body) {
  return {
    name: str(body.name, 100),
    slug: slugify(body.slug || body.name),
    description: str(body.description, 1000),
    color: /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#0f766e',
    currency: str(body.currency, 5).toUpperCase() || 'MAD',
    logo_url: uploads.isImageUrl(str(body.logo_url, 1000)) ? str(body.logo_url, 1000) : '',
    banner_url: uploads.isImageUrl(str(body.banner_url, 1000)) ? str(body.banner_url, 1000) : '',
    tagline: str(body.tagline, 120),
    announcement: str(body.announcement, 200),
    whatsapp: str(body.whatsapp, 20).replace(/[^0-9]/g, ''),
    phone: str(body.phone, 30),
    email: str(body.email, 200),
    instagram: social(body.instagram, 'https://instagram.com/'),
    facebook: social(body.facebook, 'https://facebook.com/'),
    tiktok: social(body.tiktok, 'https://www.tiktok.com/@'),
    city: str(body.city, 100),
    shipping_fee: money0(body.shipping_fee),
    free_shipping_over: money0(body.free_shipping_over),
  };
}

function validateStore(values, excludeId = 0) {
  if (!values.name) return 'اسم المتجر مطلوب.';
  if (!values.slug || values.slug.length < 3) return 'رابط المتجر يجب أن يكون 3 أحرف إنجليزية على الأقل (a-z, 0-9, -).';
  if (db.prepare('SELECT 1 FROM stores WHERE slug = ? AND id != ?').get(values.slug, excludeId)) return 'هذا الرابط مستخدم، اختر رابطاً آخر.';
  return null;
}

dash.get('/stores/:storeId', ownStore, (req, res) => {
  const id = req.store.id;
  const products = db.prepare('SELECT * FROM products WHERE store_id = ? ORDER BY id DESC').all(id);
  const orders = db.prepare('SELECT * FROM orders WHERE store_id = ? ORDER BY id DESC LIMIT 8').all(id);
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total END), 0) AS revenue,
              COALESCE(SUM(status = 'new'), 0) AS pending,
              COALESCE(AVG(CASE WHEN status != 'cancelled' THEN total END), 0) AS avg
       FROM orders WHERE store_id = ?`
    )
    .get(id);
  // Revenue per day for the last 7 days (including days with no sales).
  const rows = db
    .prepare(
      `SELECT date(created_at) AS day, SUM(total) AS total FROM orders
       WHERE store_id = ? AND status != 'cancelled' AND created_at >= date('now', '-6 days')
       GROUP BY day`
    )
    .all(id);
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.total]));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ day: d, total: byDay[d] || 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.total));
  const topProducts = db
    .prepare(
      `SELECT oi.name, SUM(oi.quantity) AS qty, SUM(oi.quantity * oi.price) AS total
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.store_id = ? AND o.status != 'cancelled'
       GROUP BY oi.name ORDER BY qty DESC LIMIT 5`
    )
    .all(id);
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const storeUrl = `${proto}://${host}/s/${req.store.slug}`;
  const today = db
    .prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total END), 0) AS revenue FROM orders WHERE store_id = ? AND date(created_at) = date('now')`)
    .get(id);
  const pageCount = db.prepare('SELECT COUNT(*) AS n FROM pages WHERE store_id = ?').get(id).n;
  res.render('dashboard/store', { products, orders, stats, days, max, topProducts, storeUrl, today, pageCount });
});

dash.get('/stores/:storeId/settings', ownStore, (req, res) =>
  res.render('dashboard/store-form', { error: null, values: req.store, action: `/dashboard/stores/${req.store.id}/settings` })
);
dash.post('/stores/:storeId/settings', ownStore, (req, res) => {
  const values = readStoreForm(req.body);
  const error = validateStore(values, req.store.id);
  const action = `/dashboard/stores/${req.store.id}/settings`;
  if (error) return res.status(400).render('dashboard/store-form', { error, values, action });
  db.prepare(`UPDATE stores SET ${STORE_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(
    ...STORE_FIELDS.map((f) => values[f]), req.store.id
  );
  res.redirect(`/dashboard/stores/${req.store.id}`);
});

function parseJSON(v, fallback) {
  try { return JSON.parse(v); } catch { return fallback; }
}
// Up to 2 options (e.g. size, color), each with up to 20 values.
function readOptions(body) {
  const opts = [];
  for (const i of [1, 2]) {
    const name = str(body[`opt${i}_name`], 30);
    const values = [...new Set(str(body[`opt${i}_values`], 500).split(/[,،\n]/).map((v) => v.trim().slice(0, 30)).filter(Boolean))].slice(0, 20);
    if (name && values.length) opts.push({ name, values });
  }
  return opts;
}

function readProductForm(body) {
  const images = (Array.isArray(parseJSON(body.images, [])) ? parseJSON(body.images, []) : [])
    .filter(uploads.isImageUrl).slice(0, uploads.MAX_FILES);
  const extra = url(body.image_url);
  if (extra && !images.includes(extra)) images.push(extra);
  return {
    images: JSON.stringify(images.slice(0, uploads.MAX_FILES)),
    options: JSON.stringify(readOptions(body)),
    sku: str(body.sku, 60),
    cost_price: money0(body.cost_price),
    name: str(body.name, 200),
    description: str(body.description, 3000),
    price: Number(body.price),
    stock: Math.max(0, parseInt(body.stock, 10) || 0),
    image_url: images[0] || '',
    category: str(body.category, 60),
    compare_price: money0(body.compare_price),
    active: body.active ? 1 : 0,
  };
}
const PRODUCT_FIELDS = ['name', 'description', 'price', 'stock', 'image_url', 'images', 'options', 'sku', 'cost_price', 'category', 'compare_price', 'active'];
function validateProduct(p) {
  if (!p.name) return 'اسم المنتج مطلوب.';
  if (!Number.isFinite(p.price) || p.price < 0) return 'السعر غير صحيح.';
  if (p.compare_price && p.compare_price <= p.price) return 'السعر قبل التخفيض يجب أن يكون أكبر من السعر الحالي.';
  return null;
}

// Existing categories, offered as suggestions in the product form.
function storeCategories(req, res, next) {
  res.locals.categories = db
    .prepare("SELECT DISTINCT category FROM products WHERE store_id = ? AND category != '' ORDER BY category")
    .all(req.store.id).map((r) => r.category);
  next();
}
dash.use('/stores/:storeId/products', ownStore, storeCategories);

dash.get('/stores/:storeId/products', ownStore, (req, res) => {
  const q = str(req.query.q, 100);
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const products = db.prepare(
    `SELECT * FROM products WHERE store_id = ? AND (? = '' OR name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')
     ORDER BY id DESC`
  ).all(req.store.id, q, like, like, like);
  res.render('dashboard/products', { products, q });
});

dash.get('/stores/:storeId/products/new', ownStore, (req, res) =>
  res.render('dashboard/product-form', { error: null, saved: !!req.query.saved, values: { active: 1, images: '[]', options: '[]' }, action: `/dashboard/stores/${req.store.id}/products` })
);
dash.post('/stores/:storeId/products', ownStore, (req, res) => {
  const p = readProductForm(req.body);
  const error = validateProduct(p);
  if (error) return res.status(400).render('dashboard/product-form', { error, values: p, action: req.originalUrl });
  db.prepare(`INSERT INTO products (store_id, ${PRODUCT_FIELDS.join(', ')}) VALUES (?, ${PRODUCT_FIELDS.map(() => '?').join(', ')})`).run(
    req.store.id, ...PRODUCT_FIELDS.map((f) => p[f])
  );
  res.redirect(req.body.next === 'another' ? `/dashboard/stores/${req.store.id}/products/new?saved=1` : `/dashboard/stores/${req.store.id}/products`);
});

function ownProduct(req, res, next) {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(req.params.productId, req.store.id);
  if (!product) return res.status(404).render('message', { title: 'غير موجود', message: 'المنتج غير موجود.' });
  req.product = product;
  next();
}

dash.get('/stores/:storeId/products/:productId', ownStore, ownProduct, (req, res) =>
  res.render('dashboard/product-form', { error: null, values: req.product, action: req.originalUrl })
);
dash.post('/stores/:storeId/products/:productId', ownStore, ownProduct, (req, res) => {
  const p = readProductForm(req.body);
  const error = validateProduct(p);
  if (error) return res.status(400).render('dashboard/product-form', { error, values: p, action: req.originalUrl });
  db.prepare(`UPDATE products SET ${PRODUCT_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(
    ...PRODUCT_FIELDS.map((f) => p[f]), req.product.id
  );
  res.redirect(`/dashboard/stores/${req.store.id}/products`);
});
dash.post('/stores/:storeId/products/:productId/delete', ownStore, ownProduct, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.product.id);
  res.redirect(`/dashboard/stores/${req.store.id}/products`);
});

dash.get('/stores/:storeId/orders', ownStore, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE store_id = ? ORDER BY id DESC').all(req.store.id);
  res.render('dashboard/orders', { orders });
});
dash.get('/stores/:storeId/orders/:orderId', ownStore, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(req.params.orderId, req.store.id);
  if (!order) return res.status(404).render('message', { title: 'غير موجود', message: 'الطلب غير موجود.' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  // This customer's history in this store (same phone), to spot fake/repeat-cancel orders.
  const history = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'delivered'), 0) AS delivered, COALESCE(SUM(status = 'cancelled'), 0) AS cancelled
       FROM orders WHERE store_id = ? AND customer_phone = ? AND id != ?`
    )
    .get(req.store.id, order.customer_phone, order.id);
  res.render('dashboard/order', { order, items, history });
});
dash.post('/stores/:storeId/orders/:orderId/status', ownStore, (req, res) => {
  const status = req.body.status;
  if (!STATUSES[status]) return res.status(400).render('message', { title: 'خطأ', message: 'حالة غير صحيحة.' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(req.params.orderId, req.store.id);
  if (!order) return res.status(404).render('message', { title: 'غير موجود', message: 'الطلب غير موجود.' });
  transaction(() => {
    // Return stock when an order is cancelled; take it again if it is un-cancelled.
    if (status === 'cancelled' && order.status !== 'cancelled') adjustStock(order.id, +1);
    if (status !== 'cancelled' && order.status === 'cancelled') adjustStock(order.id, -1);
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
  });
  res.redirect(`/dashboard/stores/${req.store.id}/orders/${order.id}`);
});

function adjustStock(orderId, sign) {
  const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ? AND product_id IS NOT NULL').all(orderId);
  const upd = db.prepare('UPDATE products SET stock = MAX(0, stock + ?) WHERE id = ?');
  for (const it of items) upd.run(sign * it.quantity, it.product_id);
}

// ----- Store design (homepage sections + theme) -----
const storeHome = (store) => {
  const list = sections.sanitize(store.home_sections || '');
  return store.home_sections ? list : sections.DEFAULT_HOME;
};
dash.get('/stores/:storeId/design', ownStore, (req, res) => {
  res.render('dashboard/design', { sectionsData: storeHome(req.store), presets: sections.PRESETS, saved: !!req.query.saved, wide: true });
});
// Live preview for the design editor: renders the storefront home with unsaved changes.
dash.post('/stores/:storeId/design/preview', ownStore, (req, res) => {
  const draft = {
    ...req.store,
    color: /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : req.store.color,
    font: FONTS[req.body.font] ? req.body.font : req.store.font,
    radius: RADII[req.body.radius] ? req.body.radius : req.store.radius,
    header_style: HEADERS[req.body.header_style] ? req.body.header_style : req.store.header_style,
  };
  const list = sections.sanitize(req.body.sections);
  Object.assign(res.locals, storefrontLocals(draft), { store: draft, cartCount: 0, isOwner: false, preview: true });
  res.set('Cache-Control', 'no-store');
  res.render('store/home', { blocks: resolveSections(draft, list), pageTitle: null });
});

dash.post('/stores/:storeId/design', ownStore, (req, res) => {
  const list = sections.sanitize(req.body.sections);
  const font = FONTS[req.body.font] ? req.body.font : 'tajawal';
  const radius = RADII[req.body.radius] ? req.body.radius : 'soft';
  const header = HEADERS[req.body.header_style] ? req.body.header_style : 'classic';
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : req.store.color;
  db.prepare('UPDATE stores SET home_sections = ?, font = ?, radius = ?, header_style = ?, color = ? WHERE id = ?')
    .run(JSON.stringify(list), font, radius, header, color, req.store.id);
  res.redirect(`/dashboard/stores/${req.store.id}/design?saved=1`);
});

// ----- Custom pages -----
const PAGE_TEMPLATES = {
  blank: { title: '', sections: [{ type: 'text' }] },
  about: { title: 'من نحن', sections: [
    { type: 'banner', title: 'من نحن', height: 's', align: 'center' },
    { type: 'image_text', eyebrow: 'قصتنا', title: 'بدأنا بشغف', text: 'اكتب هنا قصة متجرك: كيف بدأت، وما الذي يميز منتجاتك، ولماذا يثق بك عملاؤك.', side: 'start' },
    { type: 'features', title: 'قيمنا', items: [{ icon: '💎', title: 'الجودة', text: 'منتجات مختارة بعناية' }, { icon: '🤝', title: 'الثقة', text: 'نحترم وعودنا' }, { icon: '❤️', title: 'الاهتمام', text: 'رضاك أولويتنا' }] },
  ] },
  contact: { title: 'اتصل بنا', sections: [
    { type: 'text', title: 'تواصل معنا', text: 'يسعدنا الرد على أسئلتك. تواصل معنا عبر واتساب أو الهاتف وسنجيبك في أقرب وقت.', align: 'center' },
  ] },
  shipping: { title: 'سياسة التوصيل', sections: [
    { type: 'text', title: 'التوصيل', text: '• نوصل إلى جميع المدن.\n• مدة التوصيل من 24 إلى 72 ساعة.\n• الدفع عند الاستلام.\n\nعدّل هذا النص حسب سياستك.' },
  ] },
  returns: { title: 'سياسة الاستبدال والإرجاع', sections: [
    { type: 'text', title: 'الاستبدال والإرجاع', text: '• يمكنك استبدال المنتج خلال 7 أيام من الاستلام.\n• يجب أن يكون المنتج بحالته الأصلية.\n\nعدّل هذا النص حسب سياستك.' },
  ] },
  faq: { title: 'الأسئلة الشائعة', sections: [
    { type: 'faq', title: 'الأسئلة الشائعة', items: [{ q: 'كم يستغرق التوصيل؟', a: 'من 24 إلى 72 ساعة حسب مدينتك.' }, { q: 'كيف أدفع؟', a: 'الدفع نقداً عند الاستلام.' }, { q: 'هل يمكنني استبدال المنتج؟', a: 'نعم، خلال 7 أيام.' }] },
  ] },
};
const pageSlug = (s) => str(s, 60).trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06ff-]+/g, '-').replace(/^-+|-+$/g, '');
const RESERVED = new Set(['products', 'cart', 'checkout', 'thanks', 'p', 'page']);

dash.get('/stores/:storeId/pages', ownStore, (req, res) => {
  const pages = db.prepare('SELECT * FROM pages WHERE store_id = ? ORDER BY position, id').all(req.store.id);
  res.render('dashboard/pages', { pages, templates: PAGE_TEMPLATES });
});
dash.post('/stores/:storeId/pages', ownStore, (req, res) => {
  const tpl = PAGE_TEMPLATES[req.body.template] || PAGE_TEMPLATES.blank;
  const title = str(req.body.title, 80) || tpl.title || 'صفحة جديدة';
  let slug = pageSlug(title) || 'page';
  if (RESERVED.has(slug)) slug += '-1';
  for (let i = 2; db.prepare('SELECT 1 FROM pages WHERE store_id = ? AND slug = ?').get(req.store.id, slug); i++) slug = `${pageSlug(title) || 'page'}-${i}`;
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM pages WHERE store_id = ?').get(req.store.id).p;
  const { lastInsertRowid } = db.prepare('INSERT INTO pages (store_id, title, slug, sections, position) VALUES (?, ?, ?, ?, ?)')
    .run(req.store.id, title, slug, JSON.stringify(sections.sanitize(tpl.sections)), pos);
  res.redirect(`/dashboard/stores/${req.store.id}/pages/${lastInsertRowid}`);
});
function ownPage(req, res, next) {
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND store_id = ?').get(req.params.pageId, req.store.id);
  if (!page) return res.status(404).render('message', { title: 'غير موجود', message: 'الصفحة غير موجودة.' });
  req.page = page;
  next();
}
dash.get('/stores/:storeId/pages/:pageId', ownStore, ownPage, (req, res) => {
  res.render('dashboard/page-edit', { page: req.page, sectionsData: sections.sanitize(req.page.sections), error: null, saved: !!req.query.saved });
});
dash.post('/stores/:storeId/pages/:pageId', ownStore, ownPage, (req, res) => {
  const title = str(req.body.title, 80);
  const slug = pageSlug(req.body.slug || title);
  const list = sections.sanitize(req.body.sections);
  const render = (error) => res.status(400).render('dashboard/page-edit', { page: { ...req.page, title, slug }, sectionsData: list, error, saved: false });
  if (!title) return render('عنوان الصفحة مطلوب.');
  if (!slug || RESERVED.has(slug)) return render('رابط الصفحة غير صالح.');
  if (db.prepare('SELECT 1 FROM pages WHERE store_id = ? AND slug = ? AND id != ?').get(req.store.id, slug, req.page.id)) return render('هذا الرابط مستخدم في صفحة أخرى.');
  db.prepare('UPDATE pages SET title = ?, slug = ?, sections = ?, in_menu = ?, in_footer = ? WHERE id = ?')
    .run(title, slug, JSON.stringify(list), req.body.in_menu ? 1 : 0, req.body.in_footer ? 1 : 0, req.page.id);
  res.redirect(`/dashboard/stores/${req.store.id}/pages/${req.page.id}?saved=1`);
});
dash.post('/stores/:storeId/pages/:pageId/move', ownStore, ownPage, (req, res) => {
  const pages = db.prepare('SELECT id FROM pages WHERE store_id = ? ORDER BY position, id').all(req.store.id).map((p) => p.id);
  const i = pages.indexOf(req.page.id);
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < pages.length) [pages[i], pages[j]] = [pages[j], pages[i]];
  transaction(() => pages.forEach((id, k) => db.prepare('UPDATE pages SET position = ? WHERE id = ?').run(k, id)));
  res.redirect(`/dashboard/stores/${req.store.id}/pages`);
});
dash.post('/stores/:storeId/pages/:pageId/delete', ownStore, ownPage, (req, res) => {
  db.prepare('DELETE FROM pages WHERE id = ?').run(req.page.id);
  res.redirect(`/dashboard/stores/${req.store.id}/pages`);
});

// Image upload (used by product and store forms via fetch). Returns { urls: [...] }.
dash.post('/stores/:storeId/uploads', ownStore, (req, res) => {
  uploads.upload.array('files', uploads.MAX_FILES)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'حجم الصورة يجب ألا يتجاوز 5 ميغابايت.' : 'تعذّر رفع الصور.';
      return res.status(400).json({ error: msg });
    }
    const files = req.files || [];
    const good = files.filter((f) => {
      if (uploads.looksLikeImage(f)) return true;
      fs.unlinkSync(f.path);
      return false;
    });
    if (!good.length) return res.status(400).json({ error: 'الملفات يجب أن تكون صوراً (JPG, PNG, WEBP, GIF).' });
    res.json({ urls: good.map((f) => `/uploads/${f.filename}`) });
  });
});

app.use('/dashboard', dash);

// ---------- Platform admin ----------
const admin = express.Router();
admin.use(auth.requireAdmin);
admin.use(shell);
admin.use((req, res, next) => {
  res.locals.pendingOrders = pendingFor(req.user.id);
  next();
});

admin.get('/', (req, res) => {
  const q = str(req.query.q, 100);
  const filter = ['active', 'suspended', 'empty'].includes(req.query.f) ? req.query.f : 'all';
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const totals = db.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE role != 'admin') AS merchants,
            (SELECT COUNT(*) FROM stores) AS stores,
            (SELECT COUNT(*) FROM stores WHERE suspended = 1) AS suspended,
            (SELECT COUNT(*) FROM products) AS products,
            (SELECT COUNT(*) FROM orders) AS orders,
            (SELECT COUNT(*) FROM orders WHERE created_at >= datetime('now', '-7 days')) AS orders7,
            (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status != 'cancelled') AS gmv,
            (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-7 days')) AS signups7`
  ).get();
  const stores = db.prepare(
    `SELECT s.*, u.name AS owner_name, u.email AS owner_email,
       (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS product_count,
       (SELECT COUNT(*) FROM orders o WHERE o.store_id = s.id) AS order_count,
       (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.store_id = s.id AND o.status != 'cancelled') AS revenue,
       (SELECT MAX(created_at) FROM orders o WHERE o.store_id = s.id) AS last_order
     FROM stores s JOIN users u ON u.id = s.owner_id
     WHERE (? = '' OR s.name LIKE ? ESCAPE '\\' OR s.slug LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')
       AND (? = 'all' OR (? = 'active' AND s.suspended = 0) OR (? = 'suspended' AND s.suspended = 1)
            OR (? = 'empty' AND NOT EXISTS (SELECT 1 FROM products p WHERE p.store_id = s.id)))
     ORDER BY s.id DESC LIMIT 200`
  ).all(q, like, like, like, like, filter, filter, filter, filter);
  res.render('admin/index', { totals, stores, q, filter });
});

admin.get('/merchants', (req, res) => {
  const merchants = db.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.suspended, u.created_at,
       (SELECT COUNT(*) FROM stores s WHERE s.owner_id = u.id) AS store_count,
       (SELECT COUNT(*) FROM orders o JOIN stores s ON s.id = o.store_id WHERE s.owner_id = u.id) AS order_count,
       (SELECT MAX(created_at) FROM sessions se WHERE se.user_id = u.id) AS last_seen
     FROM users u ORDER BY u.id DESC LIMIT 500`
  ).all();
  res.render('admin/merchants', { merchants });
});

admin.post('/stores/:id/suspend', (req, res) => {
  const on = req.body.suspend === '1' ? 1 : 0;
  db.prepare('UPDATE stores SET suspended = ?, suspend_reason = ? WHERE id = ?').run(on, on ? str(req.body.reason, 200) : '', req.params.id);
  res.redirect(req.get('referer')?.includes('/admin') ? req.get('referer') : '/admin');
});

admin.post('/merchants/:id/suspend', (req, res) => {
  const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!target || target.role === 'admin') return res.status(400).render('message', { title: 'خطأ', message: 'لا يمكن إيقاف هذا الحساب.' });
  const on = req.body.suspend === '1' ? 1 : 0;
  transaction(() => {
    db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(on, target.id);
    if (on) auth.logoutEverywhere(target.id);
  });
  res.redirect('/admin/merchants');
});

app.use('/admin', admin);

// ---------- Storefront ----------
// Theme + navigation values every storefront page needs (also used by the editor preview).
function storefrontLocals(store) {
  return {
    menuPages: db.prepare('SELECT title, slug, in_menu, in_footer FROM pages WHERE store_id = ? ORDER BY position, id').all(store.id),
    font: FONTS[store.font] || FONTS.tajawal,
    radius: (RADII[store.radius] || RADII.soft).v,
    // Store-relative links: "/products" -> "/s/<slug>/products".
    href: (link) => (link && link.startsWith('/') ? `/s/${store.slug}${link === '/' ? '' : link}` : link),
  };
}

const shop = express.Router({ mergeParams: true });
shop.use((req, res, next) => {
  const store = db.prepare('SELECT * FROM stores WHERE slug = ?').get(req.params.slug);
  if (!store) return res.status(404).render('message', { title: 'غير موجود', message: 'المتجر غير موجود.' });
  const canSee = req.user && (req.user.id === store.owner_id || req.user.isAdmin);
  if (store.suspended && !canSee) return res.status(503).render('message', { title: 'غير متاح', message: 'هذا المتجر غير متاح حالياً.' });
  if (store.suspended && req.method === 'POST') return res.status(503).render('message', { title: 'غير متاح', message: 'هذا المتجر موقوف ولا يستقبل طلبات.' });
  req.store = store;
  res.locals.store = store;
  res.locals.cartCount = Object.values(req.cart[store.id] || {}).reduce((a, b) => a + b, 0);
  res.locals.isOwner = !!req.user && req.user.id === store.owner_id;
  Object.assign(res.locals, storefrontLocals(store));
  next();
});

// Cart keys are "<productId>" or "<productId>::<variant>" (e.g. "5::M / أحمر").
function cartLines(req) {
  const items = req.cart[req.store.id] || {};
  const keys = Object.keys(items);
  if (!keys.length) return { lines: [], subtotal: 0, shipping: 0, total: 0 };
  const ids = [...new Set(keys.map((k) => parseInt(k, 10)))];
  const products = db
    .prepare(`SELECT * FROM products WHERE store_id = ? AND active = 1 AND id IN (${ids.map(() => '?').join(',')})`)
    .all(req.store.id, ...ids);
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const lines = keys.map((key) => {
    const p = byId[parseInt(key, 10)];
    if (!p) return null;
    const variant = key.includes('::') ? key.slice(key.indexOf('::') + 2) : '';
    const quantity = Math.min(items[key], p.stock);
    return { key, product: p, variant, quantity, subtotal: quantity * p.price };
  }).filter((l) => l && l.quantity > 0);
  const subtotal = lines.reduce((a, l) => a + l.subtotal, 0);
  const { shipping_fee: fee, free_shipping_over: freeOver } = req.store;
  const shipping = !lines.length || (freeOver > 0 && subtotal >= freeOver) ? 0 : fee;
  return { lines, subtotal, shipping, total: subtotal + shipping };
}

const SORTS = {
  new: 'id DESC',
  price_asc: 'price ASC, id DESC',
  price_desc: 'price DESC, id DESC',
};
// Load the data each section needs (products, categories...).
function resolveSections(store, list) {
  return list.map((sec, idx) => ({ ...sec, idx })).filter((sec) => !sec.hidden).map((sec) => {
    const out = { ...sec };
    if (sec.type === 'products') {
      const limit = Number(sec.limit) || 8;
      const base = `SELECT p.* FROM products p WHERE p.store_id = ? AND p.active = 1`;
      let rows;
      if (sec.source === 'sale') rows = db.prepare(`${base} AND p.compare_price > p.price ORDER BY p.stock = 0, p.id DESC LIMIT ?`).all(store.id, limit);
      else if (sec.source === 'category') rows = db.prepare(`${base} AND p.category = ? ORDER BY p.stock = 0, p.id DESC LIMIT ?`).all(store.id, sec.category, limit);
      else if (sec.source === 'best') rows = db.prepare(
        `${base} ORDER BY p.stock = 0, (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE oi.product_id = p.id AND o.status != 'cancelled') DESC, p.id DESC LIMIT ?`).all(store.id, limit);
      else rows = db.prepare(`${base} ORDER BY p.stock = 0, p.id DESC LIMIT ?`).all(store.id, limit);
      out.products = rows;
      out.moreLink = sec.source === 'sale' ? '/products?sale=1' : sec.source === 'category' && sec.category ? `/products?c=${encodeURIComponent(sec.category)}` : '/products';
    }
    if (sec.type === 'categories') {
      // No items configured: build cards automatically from the store's categories.
      const cats = db.prepare(
        `SELECT category AS name, COUNT(*) AS n, (SELECT image_url FROM products q WHERE q.store_id = p.store_id AND q.category = p.category AND q.active = 1 AND q.image_url != '' ORDER BY q.id DESC LIMIT 1) AS cover
         FROM products p WHERE store_id = ? AND active = 1 AND category != '' GROUP BY category ORDER BY n DESC LIMIT 8`).all(store.id);
      const byName = Object.fromEntries(cats.map((c) => [c.name, c]));
      out.cards = (sec.items?.length ? sec.items.filter((i) => i.name) : cats).map((i) => ({ name: i.name, image: i.image || byName[i.name]?.cover || i.cover || '', n: byName[i.name]?.n || 0 }));
    }
    if (sec.type === 'video') out.videoId = sections.youtubeId(sec.url);
    return out;
  });
}

shop.get('/', (req, res) => {
  const list = req.store.home_sections ? sections.sanitize(req.store.home_sections) : sections.DEFAULT_HOME;
  res.render('store/home', { blocks: resolveSections(req.store, list), pageTitle: null });
});

shop.get('/page/:pageSlug', (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE store_id = ? AND slug = ?').get(req.store.id, req.params.pageSlug);
  if (!page) return res.status(404).render('message', { title: 'غير موجود', message: 'الصفحة غير موجودة.' });
  res.render('store/home', { blocks: resolveSections(req.store, sections.sanitize(page.sections)), pageTitle: page.title });
});

shop.get('/products', (req, res) => {
  const q = str(req.query.q, 100);
  const c = str(req.query.c, 60);
  const sale = req.query.sale ? 1 : 0;
  const sort = SORTS[req.query.sort] ? req.query.sort : 'new';
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  // In-stock products first, then the chosen order.
  const products = db
    .prepare(
      `SELECT * FROM products WHERE store_id = ? AND active = 1
         AND (? = '' OR name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
         AND (? = '' OR category = ?)
         AND (? = 0 OR compare_price > price)
       ORDER BY (stock = 0), ${SORTS[sort]}`
    )
    .all(req.store.id, q, like, like, c, c, sale);
  const total = db.prepare('SELECT COUNT(*) AS n FROM products WHERE store_id = ? AND active = 1').get(req.store.id).n;
  const newest = db.prepare('SELECT MAX(id) AS id FROM products WHERE store_id = ? AND active = 1').get(req.store.id).id;
  const categories = db
    .prepare(
      `SELECT category AS name, COUNT(*) AS n FROM products
       WHERE store_id = ? AND active = 1 AND category != '' GROUP BY category ORDER BY category`
    )
    .all(req.store.id);
  res.render('store/products', { products, q, c, sale, sort, total, newest, categories });
});

shop.get('/p/:productId', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ? AND active = 1').get(req.params.productId, req.store.id);
  if (!product) return res.status(404).render('message', { title: 'غير موجود', message: 'المنتج غير موجود.' });
  res.render('store/product', { product, choose: !!req.query.choose });
});

shop.post('/cart', (req, res) => {
  const cart = (req.cart[req.store.id] ||= {});
  const qty = Math.max(0, parseInt(req.body.quantity, 10) || 0);
  let key = null;
  let product = null;
  if (req.body.mode === 'set') {
    // Updating an existing line: the key must already be in the cart.
    key = Object.hasOwn(cart, req.body.key) ? req.body.key : null;
    if (key) product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(parseInt(key, 10), req.store.id);
  } else {
    product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ? AND active = 1').get(req.body.product_id, req.store.id);
    if (product) {
      const options = JSON.parse(product.options || '[]');
      const chosen = options.map((o, i) => str(req.body[`opt${i}`], 30));
      // Every option must be chosen, and from the allowed values.
      if (options.some((o, i) => !o.values.includes(chosen[i]))) {
        return res.redirect(`/s/${req.store.slug}/p/${product.id}?choose=1`);
      }
      key = options.length ? `${product.id}::${chosen.join(' / ')}` : String(product.id);
    }
  }
  if (key && product) {
    const next = req.body.mode === 'set' ? qty : (cart[key] || 0) + qty;
    if (next <= 0) delete cart[key];
    else cart[key] = Math.min(next, product.stock);
    auth.saveCart(req);
  }
  res.redirect(`/s/${req.store.slug}/cart`);
});

shop.get('/cart', (req, res) => res.render('store/cart', cartLines(req)));

shop.get('/checkout', (req, res) => {
  const cart = cartLines(req);
  if (!cart.lines.length) return res.redirect(`/s/${req.store.slug}/cart`);
  res.render('store/checkout', { ...cart, error: null, values: {} });
});

shop.post('/checkout', (req, res) => {
  const values = {
    customer_name: str(req.body.customer_name, 100),
    customer_phone: cleanPhone(req.body.customer_phone),
    customer_address: str(req.body.customer_address, 500),
    note: str(req.body.note, 1000),
  };
  const cart = cartLines(req);
  if (!cart.lines.length) return res.redirect(`/s/${req.store.slug}/cart`);
  const fail = (error, status = 400) => res.status(status).render('store/checkout', { ...cart, error, values });

  // Bots: a hidden field humans never fill, and a form submitted impossibly fast.
  const startedAt = Number(req.body._t) || 0;
  if (req.body.website || (startedAt && Date.now() - startedAt < 3000)) return fail('تعذّر إرسال الطلب، أعد المحاولة.');

  if (values.customer_name.length < 3) return fail('الرجاء إدخال الاسم الكامل.');
  if (!validPhone(values.customer_phone)) return fail('رقم الهاتف غير صحيح. مثال: 0612345678');
  if (values.customer_address.length < 8) return fail('الرجاء إدخال العنوان الكامل (المدينة، الحي، الشارع).');

  // Abuse limits: per IP and per phone number.
  if (!limiter.hit(`order-ip:${req.ip}`, 5, 60 * MIN)) return fail('طلبات كثيرة من نفس الجهاز. حاول لاحقاً أو تواصل مع المتجر.', 429);
  const recent = db
    .prepare(
      `SELECT id FROM orders WHERE store_id = ? AND customer_phone = ? AND status = 'new'
         AND created_at >= datetime('now', '-30 minutes') ORDER BY id DESC LIMIT 1`
    )
    .get(req.store.id, values.customer_phone);
  if (recent) return fail(`لديك طلب قيد المراجعة (رقم #${recent.id}). سيتصل بك المتجر قريباً لتأكيده. لتعديل طلبك تواصل مع المتجر.`, 409);
  const today = db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND customer_phone = ? AND created_at >= datetime('now', '-1 day')`)
    .get(req.store.id, values.customer_phone).n;
  if (today >= 3) return fail('تجاوزت عدد الطلبات المسموح به اليوم لهذا الرقم. تواصل مع المتجر مباشرة.', 429);
  let orderId;
  try {
    orderId = transaction(() => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO orders (store_id, customer_name, customer_phone, customer_address, note, shipping, total, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.store.id, values.customer_name, values.customer_phone, values.customer_address, values.note, cart.shipping, cart.total, req.ip || '');
      const take = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
      const addItem = db.prepare('INSERT INTO order_items (order_id, product_id, name, price, quantity) VALUES (?, ?, ?, ?, ?)');
      for (const l of cart.lines) {
        if (take.run(l.quantity, l.product.id, l.quantity).changes !== 1) throw new Error('OUT_OF_STOCK');
        addItem.run(lastInsertRowid, l.product.id, l.variant ? `${l.product.name} (${l.variant})` : l.product.name, l.product.price, l.quantity);
      }
      return Number(lastInsertRowid);
    });
  } catch (err) {
    if (err.message !== 'OUT_OF_STOCK') throw err;
    return res.status(409).render('store/checkout', { ...cartLines(req), error: 'نفدت كمية أحد المنتجات، راجع السلة.', values });
  }
  delete req.cart[req.store.id];
  auth.saveCart(req);
  notifyNewOrder(req, orderId); // fire and forget
  res.redirect(`/s/${req.store.slug}/thanks/${orderId}`);
});

shop.get('/thanks/:orderId', (req, res) => {
  const order = db.prepare('SELECT id, total FROM orders WHERE id = ? AND store_id = ?').get(req.params.orderId, req.store.id);
  if (!order) return res.redirect(`/s/${req.store.slug}`);
  res.render('store/thanks', { order });
});

// Email the merchant about a new order (account email + store contact email).
function notifyNewOrder(req, orderId) {
  const store = req.store;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  const owner = db.prepare('SELECT email, name FROM users WHERE id = ?').get(store.owner_id);
  const to = [...new Set([owner?.email, store.email].filter(Boolean))].join(', ');
  const money = app.locals.money;
  const link = `${baseUrl(req)}/dashboard/stores/${store.id}/orders/${orderId}`;
  const lines = items.map((i) => `• ${i.name} × ${i.quantity} — ${money(i.price * i.quantity, store.currency)}`).join('\n');
  const e = mailer.esc;
  mailer.send({
    to,
    subject: `🛒 طلب جديد #${orderId} — ${money(order.total, store.currency)} · ${store.name}`,
    text: `طلب جديد في متجر ${store.name}\n\nالعميل: ${order.customer_name}\nالهاتف: ${order.customer_phone}\nالعنوان: ${order.customer_address}\n\n${lines}\n\nالإجمالي: ${money(order.total, store.currency)}\n\nعرض الطلب: ${link}`,
    html: mailer.layout(`طلب جديد #${orderId}`, `
      <p>وصلك طلب جديد في متجر <strong>${e(store.name)}</strong> 🎉</p>
      <table style="width:100%;border-collapse:collapse;margin:12px 0">
        ${items.map((i) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${e(i.name)} × ${i.quantity}</td><td style="text-align:left;border-bottom:1px solid #eee">${e(money(i.price * i.quantity, store.currency))}</td></tr>`).join('')}
        ${order.shipping ? `<tr><td style="padding:6px 0">التوصيل</td><td style="text-align:left">${e(money(order.shipping, store.currency))}</td></tr>` : ''}
        <tr><td style="padding:8px 0"><strong>الإجمالي</strong></td><td style="text-align:left"><strong>${e(money(order.total, store.currency))}</strong></td></tr>
      </table>
      <p><strong>العميل:</strong> ${e(order.customer_name)}<br><strong>الهاتف:</strong> <span dir="ltr">${e(order.customer_phone)}</span><br><strong>العنوان:</strong> ${e(order.customer_address)}</p>
      <p><a href="${e(link)}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">عرض الطلب وتأكيده</a></p>`),
  });
}

app.use('/s/:slug', shop);

app.use((req, res) => res.status(404).render('message', { title: 'غير موجود', message: 'الصفحة غير موجودة.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('message', { title: 'خطأ', message: 'حدث خطأ غير متوقع.' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`YASSER running on http://localhost:${PORT}`));
}
module.exports = app;
