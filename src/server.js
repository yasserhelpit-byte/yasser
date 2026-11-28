const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, transaction, getSettings, setSetting } = require('./db');
const auth = require('./auth');
const uploads = require('./uploads');
const limiter = require('./limiter');
const mailer = require('./mailer');
const sections = require('./sections');
const aiAds = require('./ai-ads');
const notifier = require('./notify');
const payments = require('./payments');
const themeLib = require('./theme');
const billing = require('./billing');

const dns = require('dns').promises;
const maintenance = require('./maintenance');
const app = express();
app.disable('x-powered-by');
// Behind one reverse proxy (Codespaces, Render, Railway...): use X-Forwarded-For for req.ip.
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
// Security headers. Inline scripts/styles are allowed (the views use them); everything else is locked down.
const cspWith = (extra = {}) => [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${extra.script || ''}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https:",
  "frame-src https://www.youtube-nocookie.com https://maps.google.com https://www.google.com",
  `connect-src 'self'${extra.connect || ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  // Checkout forms may hand over to a payment page (CMI posts a form; Stripe/PayPal redirect).
  "form-action 'self' https://payment.cmi.co.ma https://testpayment.cmi.co.ma https://checkout.stripe.com https://www.paypal.com https://www.sandbox.paypal.com",
  "frame-ancestors 'self'",
].join('; ');
const CSP = cspWith();
// Storefronts that use ad pixels also load Meta's / TikTok's tracking scripts.
const PIXEL_CSP = cspWith({
  script: ' https://connect.facebook.net https://analytics.tiktok.com',
  connect: ' https://www.facebook.com https://connect.facebook.net https://analytics.tiktok.com https://*.tiktok.com https://*.tiktokw.us',
});
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use('/uploads', express.static(uploads.uploadsDir, { maxAge: '30d', immutable: true }));

// ---------- Custom domains ----------
// PLATFORM_HOSTS: the platform's own hostnames (comma separated). Requests for any other host that
// matches a verified store domain are served that store at the root: "/products" -> "/s/<slug>/products".
const PLATFORM_HOSTS = new Set(['localhost', '127.0.0.1', ...(process.env.PLATFORM_HOSTS || '').split(',')].map((h) => h.trim().toLowerCase()).filter(Boolean));
const DNS_TARGET = process.env.DNS_TARGET || (process.env.PLATFORM_HOSTS || '').split(',')[0].trim() || 'yasser.example.com';
const DNS_IP = process.env.DNS_IP || '';
const hostOf = (req) => String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
const bareHost = (h) => h.replace(/^www\./, '');

// For HTTPS on custom domains (e.g. Caddy "on_demand_tls ask"): 200 only for verified store domains.
app.get('/_domain-check', (req, res) => {
  const d = String(req.query.domain || '').toLowerCase();
  const ok = db.prepare('SELECT 1 FROM stores WHERE domain_verified = 1 AND suspended = 0 AND (custom_domain = ? OR custom_domain = ?)').get(d, bareHost(d));
  res.status(ok ? 200 : 404).end(ok ? 'ok' : 'no');
});

app.use((req, res, next) => {
  const host = hostOf(req);
  if (!host || PLATFORM_HOSTS.has(host) || host.endsWith('.app.github.dev') || host.endsWith('.up.railway.app')) return next();
  const store = db.prepare('SELECT slug FROM stores WHERE domain_verified = 1 AND (custom_domain = ? OR custom_domain = ?)').get(host, bareHost(host));
  if (!store) return next();
  req.customDomain = host;
  // Only the storefront lives on a merchant's domain.
  if (!req.url.startsWith('/s/')) req.url = `/s/${store.slug}${req.url === '/' ? '' : req.url}`;
  next();
});
app.use(express.urlencoded({ extended: false, limit: '1mb' })); // page designs can be large
app.use(cookieParser());
// CMI posts the payment result to these from its own servers / pages: they carry a signed hash instead
// of a CSRF token, and must not get a fresh session cookie (that would replace the customer's own).
const CMI_POST = /^\/s\/[^/]+\/pay\/\d+\/cmi\/(ok|fail|callback)$/;
app.use((req, res, next) => { req.stateless = req.method === 'POST' && CMI_POST.test(req.path); next(); });
app.use(auth.sessionMiddleware);

// CSRF: a per-session token derived from the session token, checked on every POST.
// SECRET env var, or a random secret generated once and kept in the data directory, so forms keep
// working across restarts.
function loadSecret() {
  if (process.env.SECRET) return process.env.SECRET;
  const file = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'secret.key');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const CSRF_SECRET = loadSecret();
payments.init(CSRF_SECRET);
app.use((req, res, next) => {
  if (req.method === 'POST' && CMI_POST.test(req.path)) return next();
  const csrf = crypto.createHmac('sha256', CSRF_SECRET).update(req.session.token).digest('hex');
  res.locals.csrf = csrf;
  res.locals.flash = null;
  const sent = req.body?._csrf || req.get('x-csrf-token');
  if (req.method === 'POST' && sent !== csrf) {
    return res.status(403).render('message', { title: 'خطأ', message: 'انتهت صلاحية النموذج، أعد المحاولة.' });
  }
  next();
});

app.use((req, res, next) => {
  res.locals.platform = getSettings();
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
// Changes on every deploy, so browsers fetch the new CSS/JS right away instead of a cached copy.
app.locals.assetV = (process.env.RAILWAY_GIT_COMMIT_SHA || Date.now().toString(36)).slice(0, 10);
app.locals.PAY_METHODS = payments.METHODS;
app.locals.PAY_STATUS = payments.PAY_STATUS;
app.locals.payOrder = payments.ORDER;
app.locals.SECTION_COUNT = Object.keys(sections.SCHEMA).length; // shown on the landing page
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
app.locals.THEME_OPTIONS = themeLib.withFonts(FONTS);
app.locals.THEME_KITS = themeLib.KITS;
app.locals.billingOf = (store) => billing.statusOf(store);
app.locals.PLAN_PERIODS = billing.PERIODS;
app.locals.PAY_WAYS = billing.METHODS;
app.locals.RADII = RADII;
app.locals.HEADERS = HEADERS;
app.locals.SCHEMA = sections.SCHEMA;
// Safe for embedding inside <script>: no "</script>" breakout.
app.locals.js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
app.locals.json = (v, fallback = []) => { try { return JSON.parse(v); } catch { return fallback; } };
// Short stable hash, e.g. so a dismissed announcement reappears when its text changes.
app.locals.require_hash = (v) => crypto.createHash('sha1').update(String(v)).digest('hex').slice(0, 12);
app.locals.money = (n, cur) => `${Number(n).toFixed(2)} ${cur || ''}`.trim();

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const slugify = (s) =>
  str(s, 60).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

// ---------- App manifest & icons (install on the home screen; required for push on iPhone) ----------
let sharpLib = null;
try { sharpLib = require('sharp'); } catch {}
const iconCache = {};
app.get(/^\/icon-(192|512)\.png$/, async (req, res) => {
  const size = Number(req.params[0]);
  if (!iconCache[size] && sharpLib) {
    const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'logo-mark.svg')).toString().replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 64" width="512" height="512"');
    iconCache[size] = await sharpLib(Buffer.from(svg)).resize(size, size).png().toBuffer();
  }
  if (!iconCache[size]) return res.status(404).end();
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).send(iconCache[size]);
});
app.get('/healthz', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.type('text').send('ok'); } catch (e) { res.status(503).type('text').send('db error'); }
});
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: 'YASSER · لوحة التاجر', short_name: 'YASSER', lang: 'ar', dir: 'rtl',
    start_url: '/dashboard', scope: '/', display: 'standalone', background_color: '#f6f7f9', theme_color: '#0f766e',
    icons: [192, 512].map((s) => ({ src: `/icon-${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'any maskable' })),
  });
});

// ---------- Legal pages ----------
app.get(['/terms', '/privacy'], (req, res) => {
  const st = res.locals.platform;
  res.render(`legal/${req.path.slice(1)}`, {
    legalName: st.legal_name || 'YASSER', legalAddress: st.legal_address, updated: st.legal_updated || '2026-11-27',
    title: req.path === '/terms' ? 'شروط الاستخدام' : 'سياسة الخصوصية',
  });
});

// ---------- Public pages ----------
app.get('/', (req, res) => {
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM stores) AS stores,
              (SELECT COUNT(*) FROM products WHERE active = 1) AS products,
              (SELECT COUNT(*) FROM orders) AS orders`
    )
    .get();
  res.render('home', { counts, plans: billing.plans(), trialDays: billing.settings().trialDays });
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
  if (res.locals.platform.signups_open !== '1') return res.status(403).render('signup', { error: null, values: {} });
  const name = str(req.body.name, 100);
  const email = str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  let error = null;
  if (!limiter.hit(`signup:${req.ip}`, 5, 60 * MIN)) error = 'محاولات كثيرة. حاول مرة أخرى بعد قليل.';
  else if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error = 'الرجاء إدخال الاسم والبريد الإلكتروني بشكل صحيح.';
  else if (password.length < 8) error = 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.';
  else if (!req.body.accept_terms) error = 'يجب الموافقة على شروط الاستخدام وسياسة الخصوصية.';
  else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) error = 'هذا البريد مسجل مسبقاً.';
  if (error) return res.status(400).render('signup', { error, values: { name, email } });
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email, auth.hashPassword(password));
  auth.login(req, res, Number(lastInsertRowid));
  notifier.notifyAdmins({ title: `👤 تاجر جديد: ${name}`, body: email, link: `/admin/merchants/${Number(lastInsertRowid)}` });
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
  res.locals.vapidKey = notifier.vapidPublicKey;
  res.locals.path = req.originalUrl.split('?')[0];
  // Sidebar store switcher.
  res.locals.myStores = db.prepare('SELECT id, name, color, logo_url FROM stores WHERE owner_id = ? ORDER BY id').all(req.user.id);
  next();
};
dash.use(shell);
const pendingFor = (userId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM orders o JOIN stores s ON s.id = o.store_id WHERE s.owner_id = ? AND o.status = 'new' AND o.payment_status NOT IN ('pending', 'failed', 'expired')`).get(userId).n;
const unreadChatsFor = (userId) =>
  db.prepare('SELECT COALESCE(SUM(c.unread_merchant), 0) AS n FROM conversations c JOIN stores s ON s.id = c.store_id WHERE s.owner_id = ?').get(userId).n;
dash.use((req, res, next) => {
  res.locals.pendingOrders = pendingFor(req.user.id);
  res.locals.unreadChats = unreadChatsFor(req.user.id);
  next();
});

// ----- Notification center & devices -----
const notesUnread = (userId) => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
dash.use((req, res, next) => { res.locals.notesUnread = notesUnread(req.user.id); next(); });
dash.get('/notes', (req, res) => {
  const notes = db.prepare('SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.user.id);
  res.json({ unread: notesUnread(req.user.id), notes });
});
dash.post('/notes/read', (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (id) db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL").run(id, req.user.id);
  else db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
  res.json({ unread: notesUnread(req.user.id) });
});
const deviceName = (ua) => {
  ua = String(ua || '');
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'جهاز';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${os}${br ? ' · ' + br : ''}`;
};
dash.post('/push/subscribe', (req, res) => {
  const endpoint = str(req.body.endpoint, 1000);
  const p256dh = str(req.body.p256dh, 200);
  const authKey = str(req.body.auth, 100);
  if (!/^https:\/\//.test(endpoint) || !p256dh || !authKey) return res.status(400).json({ error: 'اشتراك غير صالح.' });
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`
  ).run(req.user.id, endpoint, p256dh, authKey, deviceName(req.get('user-agent')));
  res.json({ ok: true });
});
dash.post('/push/unsubscribe', (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND (endpoint = ? OR id = ?)').run(req.user.id, str(req.body.endpoint, 1000), parseInt(req.body.id, 10) || 0);
  if ((req.get('accept') || '').includes('json')) return res.json({ ok: true });
  res.redirect('/dashboard/settings/notifications');
});
dash.post('/push/test', async (req, res) => {
  const sent = await notifier.pushToUser(req.user.id, { title: '🔔 YASSER', body: 'الإشعارات تعمل! ستصلك الطلبات هنا فوراً.', url: '/dashboard', tag: 'test' });
  res.json({ sent });
});
dash.get('/settings/notifications', (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const devices = db.prepare('SELECT id, device, created_at, last_ok FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.render('dashboard/notify-settings', { prefs: notifier.prefsOf(me), KINDS: notifier.KINDS, devices, saved: !!req.query.saved });
});
dash.post('/settings/notifications', (req, res) => {
  const prefs = {};
  for (const k of Object.keys(notifier.KINDS)) prefs[k] = { push: !!req.body[`${k}_push`], email: !!req.body[`${k}_email`] };
  db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?').run(JSON.stringify(prefs), req.user.id);
  res.redirect('/dashboard/settings/notifications?saved=1');
});

// Polled by the dashboard every 30s to alert the merchant about new orders.
dash.get('/notifications', (req, res) => {
  const latest = db
    .prepare(
      `SELECT o.id, o.store_id, o.customer_name, o.total, s.name AS store_name, s.currency
       FROM orders o JOIN stores s ON s.id = o.store_id WHERE s.owner_id = ? ORDER BY o.id DESC LIMIT 1`
    )
    .get(req.user.id);
  const latestChat = db.prepare(
    `SELECT c.id, c.store_id, c.name, c.last_message, m.id AS mid FROM conversations c JOIN stores s ON s.id = c.store_id
     JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE conversation_id = c.id AND sender = 'visitor')
     WHERE s.owner_id = ? AND c.unread_merchant > 0 ORDER BY m.id DESC LIMIT 1`
  ).get(req.user.id);
  res.json({ pending: res.locals.pendingOrders, latest: latest || null, unreadChats: res.locals.unreadChats, latestChat: latestChat || null, notesUnread: res.locals.notesUnread });
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
  billing.startTrial(lastInsertRowid);
  if (!req.user.isAdmin) notifier.notifyAdmins({ title: `🏪 متجر جديد: ${values.name}`, body: `${req.user.name} · /s/${values.slug}`, link: `/admin/stores/${lastInsertRowid}` });
  res.redirect(`/dashboard/stores/${lastInsertRowid}`);
});

const STORE_FIELDS = 'name, slug, description, color, currency, logo_url, banner_url, tagline, announcement, whatsapp, phone, email, instagram, facebook, tiktok, city, shipping_fee, free_shipping_over, fb_pixel_id, tiktok_pixel_id, ad_language, ad_daily_budget, ad_days'.split(', ');
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
    // Pixel IDs: Meta = digits; TikTok = letters and digits.
    fb_pixel_id: (str(body.fb_pixel_id, 40).match(/^\d{8,20}$/) || [''])[0],
    tiktok_pixel_id: (str(body.tiktok_pixel_id, 40).toUpperCase().match(/^[A-Z0-9]{10,32}$/) || [''])[0],
    ad_language: aiAds.LANGUAGES[body.ad_language] ? body.ad_language : 'darija',
    ad_daily_budget: Math.min(Math.max(10, Number(body.ad_daily_budget) || 50), 100000),
    ad_days: Math.min(Math.max(1, parseInt(body.ad_days, 10) || 5), 60),
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
  const storeUrl = req.store.domain_verified ? `https://${req.store.custom_domain}` : `${proto}://${host}/s/${req.store.slug}`;
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
  const max = billing.statusOf(req.store).limits.products;
  const count = db.prepare('SELECT COUNT(*) AS n FROM products WHERE store_id = ?').get(req.store.id).n;
  const error = validateProduct(p) || (max && count >= max ? `وصلت إلى الحد الأقصى لباقتك (${max} منتجاً). رقِّ باقتك من صفحة «الاشتراك» لإضافة المزيد.` : null);
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
  res.render('dashboard/order', { order, items, history, check: str(req.query.check, 10) });
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

// Merchant confirms a bank / agency transfer (or cash) has arrived.
dash.post('/stores/:storeId/orders/:orderId/paid', ownStore, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(req.params.orderId, req.store.id);
  if (!order) return res.status(404).render('message', { title: 'غير موجود', message: 'الطلب غير موجود.' });
  if (req.body.undo) db.prepare("UPDATE orders SET payment_status = ?, paid_at = NULL WHERE id = ? AND payment_status = 'paid'").run(payments.isManual(order.payment_method) ? 'awaiting' : 'unpaid', order.id);
  else markPaid(req, order, 'تأكيد يدوي من التاجر');
  res.redirect(`/dashboard/stores/${req.store.id}/orders/${order.id}`);
});
// Ask Stripe / PayPal again whether an online order was paid.
dash.post('/stores/:storeId/orders/:orderId/verify', ownStore, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(req.params.orderId, req.store.id);
  if (!order) return res.status(404).render('message', { title: 'غير موجود', message: 'الطلب غير موجود.' });
  let msg = 'paid';
  try {
    const r = order.payment_status === 'paid' ? { paid: true } : await payments.PROVIDERS[order.payment_method]?.verify({ store: req.store, order });
    if (r?.paid) markPaid(req, order, r.ref); else msg = 'unpaid';
  } catch (err) {
    console.error('verify payment:', err.message);
    msg = 'error';
  }
  res.redirect(`/dashboard/stores/${req.store.id}/orders/${order.id}?check=${msg}`);
});

// ----- Subscription (merchant side) -----
dash.get('/stores/:storeId/billing', ownStore, (req, res) => {
  const pending = billing.pendingOf(req.store.id);
  res.render('dashboard/billing', {
    sub: billing.statusOf(req.store), plans: billing.plans(), pending, aiOn: getSettings().ai_enabled === '1', ref: pending ? billing.reference(pending) : '',
    history: billing.historyOf(req.store.id), info: billing.settings().info, sent: !!req.query.sent,
    productCount: db.prepare('SELECT COUNT(*) AS n FROM products WHERE store_id = ?').get(req.store.id).n,
  });
});
dash.post('/stores/:storeId/billing/request', ownStore, (req, res) => {
  const sub = billing.request({ store: req.store, userId: req.user.id, planKey: str(req.body.plan, 20), months: parseInt(req.body.months, 10), method: str(req.body.method, 20), note: str(req.body.note, 300) });
  if (!sub) return res.status(400).render('message', { title: 'خطأ', message: 'اختر باقة ومدة صحيحتين.' });
  const plan = billing.planByKey(sub.plan);
  notifier.notifyAdmins({
    title: `💎 طلب اشتراك: ${req.store.name}`,
    body: `${plan.name} · ${billing.PERIODS[sub.months].label} · ${sub.amount} درهم (${billing.METHODS[sub.method]})`,
    link: '/admin/billing',
  });
  res.redirect(`/dashboard/stores/${req.store.id}/billing?sent=1`);
});
dash.post('/stores/:storeId/billing/cancel', ownStore, (req, res) => {
  db.prepare("DELETE FROM subscriptions WHERE store_id = ? AND status = 'pending'").run(req.store.id);
  res.redirect(`/dashboard/stores/${req.store.id}/billing`);
});

// ----- Payment methods -----
const paymentsView = (req, extra = {}) => ({
  cfg: payments.settingsOf(req.store),
  secretSet: Object.fromEntries(Object.entries(payments.secretsOf(req.store)).map(([m, v]) => [m, Object.fromEntries(Object.keys(v).map((k) => [k, true]))])),
  errors: [], saved: !!req.query.saved, ...extra,
});
dash.get('/stores/:storeId/payments', ownStore, (req, res) => res.render('dashboard/payments', paymentsView(req)));
dash.post('/stores/:storeId/payments', ownStore, (req, res) => {
  const r = payments.parseForm(req.body, req.store);
  if (r.errors.length) {
    // Show what was typed (secrets are never echoed back).
    const values = {};
    for (const m of payments.ORDER) values[m] = Object.fromEntries(payments.METHODS[m].fields.filter((f) => !f.secret).map((f) => [f.k, str(req.body[`${m}_${f.k}`], 600)]));
    const enabled = payments.ORDER.filter((m) => req.body[`${m}_enabled`]);
    return res.status(400).render('dashboard/payments', paymentsView(req, { errors: r.errors, cfg: { enabled, values } }));
  }
  db.prepare('UPDATE stores SET payment_config = ?, payment_secrets = ? WHERE id = ?').run(r.payment_config, r.payment_secrets, req.store.id);
  res.redirect(`/dashboard/stores/${req.store.id}/payments?saved=1`);
});

function adjustStock(orderId, sign) {
  const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ? AND product_id IS NOT NULL').all(orderId);
  const upd = db.prepare('UPDATE products SET stock = MAX(0, stock + ?) WHERE id = ?');
  for (const it of items) upd.run(sign * it.quantity, it.product_id);
}

// ----- Store design (homepage sections + theme) -----
const productChoices = (storeId) => db.prepare('SELECT id, name, price, active FROM products WHERE store_id = ? ORDER BY id DESC').all(storeId);
const storeHome = (store) => {
  const list = sections.sanitize(store.home_sections || '');
  return store.home_sections ? list : sections.DEFAULT_HOME;
};
dash.get('/stores/:storeId/design', ownStore, (req, res) => {
  res.render('dashboard/design', { sectionsData: storeHome(req.store), presets: sections.PRESETS, saved: !!req.query.saved, wide: true, productChoices: productChoices(req.store.id), theme: themeLib.sanitize(req.store.theme), groups: sections.GROUPS, proTemplates: billing.statusOf(req.store).limits.templates });
});
// Live preview for the design editor: renders the storefront home with unsaved changes.
dash.post('/stores/:storeId/design/preview', ownStore, (req, res) => {
  const draft = {
    ...req.store,
    color: /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : req.store.color,
    font: FONTS[req.body.font] ? req.body.font : req.store.font,
    radius: RADII[req.body.radius] ? req.body.radius : req.store.radius,
    header_style: HEADERS[req.body.header_style] ? req.body.header_style : req.store.header_style,
    theme: JSON.stringify(themeLib.sanitize(req.body)),
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
  db.prepare('UPDATE stores SET home_sections = ?, font = ?, radius = ?, header_style = ?, color = ?, theme = ? WHERE id = ?')
    .run(JSON.stringify(list), font, radius, header, color, JSON.stringify(themeLib.sanitize(req.body)), req.store.id);
  res.redirect(`/dashboard/stores/${req.store.id}/design?saved=1`);
});

// ----- Inbox (storefront chat) -----
function ownConv(req, res, next) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND store_id = ?').get(req.params.convId, req.store.id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  req.conv = conv;
  next();
}
const inboxList = (storeId, filter) => db.prepare(
  `SELECT id, name, phone, status, unread_merchant, last_message, last_at FROM conversations
   WHERE store_id = ? AND (? = 'all' OR status = ?) ORDER BY last_at DESC LIMIT 200`
).all(storeId, filter, filter);

dash.get(['/stores/:storeId/inbox', '/stores/:storeId/inbox/:convId'], ownStore, (req, res) => {
  const filter = ['open', 'closed'].includes(req.query.f) ? req.query.f : 'all';
  let active = null;
  let messages = [];
  if (req.params.convId) {
    active = db.prepare('SELECT * FROM conversations WHERE id = ? AND store_id = ?').get(req.params.convId, req.store.id);
    if (!active) return res.redirect(`/dashboard/stores/${req.store.id}/inbox`);
    messages = db.prepare(`SELECT ${msgFields} FROM messages WHERE conversation_id = ? ORDER BY id`).all(active.id);
    // Opening a conversation marks it read (before the list and the sidebar badge are computed).
    db.prepare('UPDATE conversations SET unread_merchant = 0 WHERE id = ?').run(active.id);
    active.unread_merchant = 0;
    res.locals.unreadChats = unreadChatsFor(req.user.id);
  }
  const conversations = inboxList(req.store.id, filter);
  res.render('dashboard/inbox', { conversations, active, messages, filter, wide: true });
});
// JSON for live updates of the inbox
dash.get('/stores/:storeId/inbox.json', ownStore, (req, res) => {
  res.json({ conversations: inboxList(req.store.id, ['open', 'closed'].includes(req.query.f) ? req.query.f : 'all') });
});
dash.get('/stores/:storeId/inbox/:convId/messages', ownStore, ownConv, (req, res) => {
  const messages = db.prepare(`SELECT ${msgFields} FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id`).all(req.conv.id, Number(req.query.after) || 0);
  if (messages.length) db.prepare('UPDATE conversations SET unread_merchant = 0 WHERE id = ?').run(req.conv.id);
  res.json({ messages });
});
dash.post('/stores/:storeId/inbox/:convId/reply', ownStore, ownConv, (req, res) => {
  const body = str(req.body.body, 2000);
  if (!body) return res.status(400).json({ error: 'اكتب ردك.' });
  const { lastInsertRowid } = db.prepare("INSERT INTO messages (conversation_id, sender, body) VALUES (?, 'merchant', ?)").run(req.conv.id, body);
  db.prepare("UPDATE conversations SET unread_visitor = unread_visitor + 1, unread_merchant = 0, last_message = ?, last_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
    .run(body.slice(0, 140), req.conv.id);
  res.json({ message: db.prepare(`SELECT ${msgFields} FROM messages WHERE id = ?`).get(lastInsertRowid) });
});
dash.post('/stores/:storeId/inbox/:convId/status', ownStore, ownConv, (req, res) => {
  db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(req.body.status === 'closed' ? 'closed' : 'open', req.conv.id);
  res.redirect(`/dashboard/stores/${req.store.id}/inbox/${req.conv.id}`);
});
dash.post('/stores/:storeId/chat-settings', ownStore, (req, res) => {
  db.prepare('UPDATE stores SET chat_enabled = ?, chat_greeting = ? WHERE id = ?').run(req.body.chat_enabled ? 1 : 0, str(req.body.chat_greeting, 300), req.store.id);
  res.redirect(`/dashboard/stores/${req.store.id}/inbox`);
});

// ----- AI ads ("Launch an ad") -----
const monthStart = "datetime('now', 'start of month')";
function aiQuota(storeId) {
  const st = getSettings();
  const usedStore = db.prepare(`SELECT COUNT(*) AS n FROM ai_usage WHERE store_id = ? AND kind = 'ad' AND ok = 1 AND created_at >= ${monthStart}`).get(storeId).n;
  const spent = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_usage WHERE created_at >= ${monthStart}`).get().c;
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  const perStore = store ? billing.statusOf(store).limits.ai : 0; // set by the store's plan
  const cap = Math.max(0, Number(st.ai_cap_usd_month) || 0);
  let blocked = null;
  if (st.ai_enabled !== '1') blocked = 'ميزة الإعلانات الذكية متوقفة حالياً من إدارة المنصة.';
  else if (aiAds.isConfigured() && usedStore >= perStore) blocked = `استعملت ${perStore} إعلانات هذا الشهر، وهو الحد المسموح. يتجدد الرصيد أول الشهر القادم.`;
  else if (aiAds.isConfigured() && spent >= cap) blocked = 'وصلت المنصة إلى حدّها الشهري لإنشاء الإعلانات. حاول الشهر القادم أو تواصل مع الدعم.';
  return { usedStore, perStore, left: Math.max(0, perStore - usedStore), spent, cap, blocked, demo: !aiAds.isConfigured() };
}
const AI_LIVE = new Set(); // stores with a generation in progress (one at a time per store)

// Build (or refresh) the product's landing page from Claude's copy. Returns the page row.
function upsertAdLanding(store, product, ad) {
  const L = ad.landing;
  const list = sections.sanitize([
    { type: 'product_hero', product: String(product.id), eyebrow: L.eyebrow, headline: L.headline, subtitle: L.subtitle, button: 'اطلب الآن · الدفع عند الاستلام' },
    { type: 'features', title: 'لماذا تختار منتجنا؟', items: L.benefits },
    { type: 'features', title: 'اطلب وأنت مطمئن', items: [
      { icon: '💵', title: 'الدفع عند الاستلام', text: 'لا تدفع حتى يصلك طلبك' },
      { icon: '🚚', title: store.shipping_fee > 0 ? `التوصيل ${store.shipping_fee} ${store.currency}` : 'توصيل مجاني', text: store.free_shipping_over > 0 ? `مجاني فوق ${store.free_shipping_over} ${store.currency}` : 'إلى باب منزلك' },
      { icon: '📞', title: 'نتصل بك للتأكيد', text: 'قبل الشحن' },
    ] },
    { type: 'faq', title: 'الأسئلة الشائعة', items: L.faq },
    { type: 'order_form', product: String(product.id), title: 'اطلب الآن والدفع عند الاستلام', subtitle: 'املأ معلوماتك وسنتصل بك لتأكيد الطلب.', button: 'تأكيد الطلب' },
  ]);
  const slug = `offer-${product.id}`;
  const existing = db.prepare('SELECT * FROM pages WHERE store_id = ? AND slug = ?').get(store.id, slug);
  if (existing) {
    db.prepare('UPDATE pages SET title = ?, sections = ? WHERE id = ?').run(product.name.slice(0, 80), JSON.stringify(list), existing.id);
    return db.prepare('SELECT * FROM pages WHERE id = ?').get(existing.id);
  }
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM pages WHERE store_id = ?').get(store.id).p;
  const { lastInsertRowid } = db.prepare('INSERT INTO pages (store_id, title, slug, sections, in_menu, in_footer, position) VALUES (?, ?, ?, ?, 0, 0, ?)')
    .run(store.id, product.name.slice(0, 80), slug, JSON.stringify(list), pos);
  return db.prepare('SELECT * FROM pages WHERE id = ?').get(lastInsertRowid);
}

dash.post('/stores/:storeId/products/:productId/ad', ownStore, async (req, res, next) => {
  const store = req.store;
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(req.params.productId, store.id);
  const fail = (message) => res.status(400).render('message', { title: 'تعذّر إنشاء الإعلان', message });
  if (!product) return fail('المنتج غير موجود.');
  if (!product.active || product.stock <= 0) return fail('لا يمكن الإعلان عن منتج مخفي أو نفدت كميته.');
  const quota = aiQuota(store.id);
  if (quota.blocked) return fail(quota.blocked);
  if (AI_LIVE.has(store.id) || !limiter.hit(`ai-ad:${store.id}`, 3, MIN)) return fail('يتم إنشاء إعلان آخر الآن. انتظر قليلاً ثم أعد المحاولة.');
  AI_LIVE.add(store.id);
  try {
    let result;
    try {
      result = await aiAds.generateAd({ store, product, language: store.ad_language });
    } catch (err) {
      if (err.usage) db.prepare("INSERT INTO ai_usage (store_id, kind, input_tokens, output_tokens, cost_usd, ok) VALUES (?, 'ad', ?, ?, ?, 0)").run(store.id, err.usage.input, err.usage.output, err.usage.cost);
      return fail(err.message);
    }
    const { ad, usage, demo } = result;
    const page = upsertAdLanding(store, product, ad);
    const id = transaction(() => {
      db.prepare('INSERT INTO ai_usage (store_id, kind, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)')
        .run(store.id, demo ? 'ad-demo' : 'ad', usage.input, usage.output, usage.cost);
      return Number(db.prepare('INSERT INTO ads (store_id, product_id, page_id, product_name, language, data, daily_budget, days, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(store.id, product.id, page.id, product.name, store.ad_language, JSON.stringify(ad), store.ad_daily_budget, store.ad_days, demo ? 1 : 0).lastInsertRowid);
    });
    const q = aiQuota(store.id);
    const month = new Date().toISOString().slice(0, 7);
    if (!demo && q.cap > 0 && q.spent >= q.cap * 0.8 && getSettings().ai_warned_month !== month) {
      setSetting('ai_warned_month', month);
      notifier.notifyAdmins({ title: '✨ رصيد Claude يقترب من السقف', body: `صُرف $${q.spent.toFixed(2)} من $${q.cap} هذا الشهر.`, link: '/admin/settings' });
    }
    res.redirect(`/dashboard/stores/${store.id}/ads/${id}`);
  } catch (err) {
    next(err);
  } finally {
    AI_LIVE.delete(store.id);
  }
});

dash.get('/stores/:storeId/ads', ownStore, (req, res) => {
  const ads = db.prepare(
    `SELECT a.*, p.image_url, p.images FROM ads a LEFT JOIN products p ON p.id = a.product_id WHERE a.store_id = ? ORDER BY a.id DESC LIMIT 100`
  ).all(req.store.id);
  const products = db.prepare('SELECT id, name, image_url, price, stock FROM products WHERE store_id = ? AND active = 1 AND stock > 0 ORDER BY id DESC').all(req.store.id);
  res.render('dashboard/ads', { ads, products, quota: aiQuota(req.store.id) });
});

dash.get('/stores/:storeId/ads/:adId', ownStore, (req, res) => {
  const row = db.prepare('SELECT * FROM ads WHERE id = ? AND store_id = ?').get(req.params.adId, req.store.id);
  if (!row) return res.status(404).render('message', { title: 'غير موجود', message: 'الإعلان غير موجود.' });
  const ad = JSON.parse(row.data);
  const product = row.product_id ? db.prepare('SELECT * FROM products WHERE id = ?').get(row.product_id) : null;
  const page = row.page_id ? db.prepare('SELECT * FROM pages WHERE id = ?').get(row.page_id) : null;
  const imgs = product ? (JSON.parse(product.images || '[]').length ? JSON.parse(product.images) : product.image_url ? [product.image_url] : []) : [];
  const origin = req.store.domain_verified ? `https://${req.store.custom_domain}` : `${baseUrl(req)}/s/${req.store.slug}`;
  const landingUrl = page ? `${origin}/page/${page.slug}?utm_source=facebook&utm_medium=paid&utm_campaign=yasser-ad-${row.id}` : origin;
  const image = imgs[ad.image_index] || imgs[0] || '';
  res.render('dashboard/ad', { row, ad, product, page, image, imageAbs: image && !/^https?:/.test(image) ? baseUrl(req) + image : image, landingUrl, LANGUAGES: aiAds.LANGUAGES, CTAS: aiAds.CTAS, quota: aiQuota(req.store.id) });
});

// ----- Custom domain -----
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
function cleanDomain(v) {
  return String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
}
dash.get('/stores/:storeId/domain', ownStore, (req, res) => {
  res.render('dashboard/domain', { error: null, notice: req.query.ok ? '✓ تم التحقق! متجرك يعمل الآن على نطاقك.' : null, dnsTarget: DNS_TARGET, dnsIp: DNS_IP });
});
dash.post('/stores/:storeId/domain', ownStore, (req, res) => {
  const domain = cleanDomain(req.body.domain);
  const fail = (error) => res.status(400).render('dashboard/domain', { error, notice: null, dnsTarget: DNS_TARGET, dnsIp: DNS_IP });
  if (!billing.statusOf(req.store).limits.domain) return fail('النطاق الخاص متاح في الباقة الاحترافية وباقة الأعمال. رقِّ باقتك من صفحة «الاشتراك».');
  if (!DOMAIN_RE.test(domain)) return fail('النطاق غير صحيح. مثال: myshop.com أو shop.myshop.com');
  if (PLATFORM_HOSTS.has(domain) || [...PLATFORM_HOSTS].some((h) => domain.endsWith('.' + h))) return fail('لا يمكن استعمال نطاق المنصة.');
  if (db.prepare('SELECT 1 FROM stores WHERE custom_domain = ? AND id != ?').get(domain, req.store.id)) return fail('هذا النطاق مربوط بمتجر آخر.');
  const token = crypto.randomBytes(12).toString('hex');
  db.prepare('UPDATE stores SET custom_domain = ?, domain_token = ?, domain_verified = 0 WHERE id = ?').run(domain, token, req.store.id);
  res.redirect(`/dashboard/stores/${req.store.id}/domain`);
});
dash.post('/stores/:storeId/domain/verify', ownStore, async (req, res) => {
  const store = req.store;
  const fail = (error) => res.status(400).render('dashboard/domain', { error, notice: null, dnsTarget: DNS_TARGET, dnsIp: DNS_IP });
  if (!store.custom_domain) return res.redirect(`/dashboard/stores/${store.id}/domain`);
  if (!limiter.hit(`domain-verify:${store.id}`, 10, 10 * 60 * 1000)) return fail('محاولات كثيرة. انتظر بضع دقائق ثم أعد المحاولة.');
  let records = [];
  try {
    records = (await dns.resolveTxt(`_yasser.${store.custom_domain}`)).map((r) => r.join(''));
  } catch {
    return fail(`لم نجد سجل TXT باسم _yasser.${store.custom_domain}. قد يستغرق ظهور السجلات الجديدة من بضع دقائق إلى 24 ساعة.`);
  }
  if (!records.includes(`yasser-verify=${store.domain_token}`)) return fail('وجدنا سجل TXT لكن قيمته غير مطابقة. انسخ القيمة كما هي تماماً.');
  db.prepare('UPDATE stores SET domain_verified = 1 WHERE id = ?').run(store.id);
  res.redirect(`/dashboard/stores/${store.id}/domain?ok=1`);
});
dash.post('/stores/:storeId/domain/remove', ownStore, (req, res) => {
  db.prepare("UPDATE stores SET custom_domain = NULL, domain_token = '', domain_verified = 0 WHERE id = ?").run(req.store.id);
  res.redirect(`/dashboard/stores/${req.store.id}/domain`);
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
PAGE_TEMPLATES.privacy = { title: 'سياسة الخصوصية', sections: [
  { type: 'text', title: 'سياسة الخصوصية', text: 'نحترم خصوصيتك. توضّح هذه الصفحة كيف نستعمل معلوماتك عند الطلب من متجرنا.\n\nما نجمعه: اسمك، رقم هاتفك، وعنوانك عند الطلب، والرسائل التي ترسلها لنا عبر الدردشة.\n\nلماذا: لتأكيد طلبك وتوصيله والتواصل معك بشأنه فقط. لا نبيع بياناتك لأي جهة.\n\nمع من نشاركها: شركة التوصيل (الاسم والهاتف والعنوان فقط) لإيصال طلبك. وقد نستعمل أدوات قياس الإعلانات (مثل Facebook Pixel) لقياس فعالية إعلاناتنا.\n\nحقوقك: يمكنك طلب الاطلاع على بياناتك أو تصحيحها أو حذفها في أي وقت بالتواصل معنا.\n\n(نموذج: عدّله ليناسب متجرك.)' },
] };
PAGE_TEMPLATES.landing = { title: 'عرض خاص', sections: sections.PRESETS.landing.sections };
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
  res.render('dashboard/page-edit', { page: req.page, sectionsData: sections.sanitize(req.page.sections), error: null, saved: !!req.query.saved, productChoices: productChoices(req.store.id) });
});
dash.post('/stores/:storeId/pages/:pageId', ownStore, ownPage, (req, res) => {
  const title = str(req.body.title, 80);
  const slug = pageSlug(req.body.slug || title);
  const list = sections.sanitize(req.body.sections);
  const render = (error) => res.status(400).render('dashboard/page-edit', { page: { ...req.page, title, slug }, sectionsData: list, error, saved: false, productChoices: productChoices(req.store.id) });
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
    Promise.all(good.map(uploads.processImage)).then((names) => {
      const urls = names.filter(Boolean).map((n) => `/uploads/${n}`);
      if (!urls.length) return res.status(400).json({ error: 'الملفات يجب أن تكون صوراً (JPG, PNG, WEBP, GIF).' });
      res.json({ urls });
    }).catch((e) => res.status(500).json({ error: 'تعذّر معالجة الصور.' }));
  });
});

app.use('/dashboard', dash);

// ---------- Platform admin ----------
const admin = express.Router();
admin.use(auth.requireAdmin);
admin.use(shell);
admin.use((req, res, next) => {
  res.locals.pendingOrders = pendingFor(req.user.id);
  res.locals.unreadChats = unreadChatsFor(req.user.id);
  res.locals.notesUnread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n;
  res.locals.pendingSubs = billing.pendingCount();
  next();
});
const likeOf = (q) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;

// Last N days as YYYY-MM-DD (UTC), oldest first.
function lastDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  return out;
}
function series(sql, days) {
  const rows = Object.fromEntries(db.prepare(sql).all().map((r) => [r.day, r.v]));
  return days.map((d) => ({ day: d, v: rows[d] || 0 }));
}

function aiUsageMonth() {
  const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(output_tokens), 0) AS outp
                        FROM ai_usage WHERE kind = 'ad' AND created_at >= ${monthStart}`).get();
  return { ...r, configured: aiAds.isConfigured(), model: aiAds.MODEL, settings: getSettings() };
}

// ----- Overview -----
admin.get('/', (req, res) => {
  const period = [7, 30, 90].includes(Number(req.query.p)) ? Number(req.query.p) : 30;
  // Totals for the current period and the one before it (for ▲/▼ trends).
  const win = (from, to) => db.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', ?) AND created_at < datetime('now', ?)) AS users,
            (SELECT COUNT(*) FROM stores WHERE created_at >= datetime('now', ?) AND created_at < datetime('now', ?)) AS stores,
            (SELECT COUNT(*) FROM orders WHERE created_at >= datetime('now', ?) AND created_at < datetime('now', ?)) AS orders,
            (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status != 'cancelled' AND created_at >= datetime('now', ?) AND created_at < datetime('now', ?)) AS gmv`
  ).get(from, to, from, to, from, to, from, to);
  const cur = win(`-${period} days`, '+1 day');
  const prev = win(`-${period * 2} days`, `-${period} days`);
  const totals = db.prepare(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM stores) AS stores,
            (SELECT COUNT(*) FROM stores WHERE suspended = 1) AS suspended,
            (SELECT COUNT(*) FROM orders) AS orders,
            (SELECT COUNT(*) FROM orders WHERE status = 'cancelled') AS cancelled,
            (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status != 'cancelled') AS gmv,
            (SELECT COUNT(*) FROM stores WHERE custom_domain IS NOT NULL AND domain_verified = 0) AS domains_pending`
  ).get();
  // Activation funnel: accounts → created a store → added products → received an order.
  const funnel = db.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE role != 'admin') AS accounts,
            (SELECT COUNT(DISTINCT s.owner_id) FROM stores s JOIN users u ON u.id = s.owner_id WHERE u.role != 'admin') AS with_store,
            (SELECT COUNT(DISTINCT s.owner_id) FROM stores s JOIN users u ON u.id = s.owner_id
               WHERE u.role != 'admin' AND EXISTS (SELECT 1 FROM products p WHERE p.store_id = s.id AND p.active = 1)) AS with_products,
            (SELECT COUNT(DISTINCT s.owner_id) FROM stores s JOIN users u ON u.id = s.owner_id
               WHERE u.role != 'admin' AND EXISTS (SELECT 1 FROM orders o WHERE o.store_id = s.id)) AS with_orders`
  ).get();
  const days = lastDays(period);
  const since = `date('now', '-${period - 1} days')`;
  const charts = {
    orders: series(`SELECT date(created_at) AS day, COUNT(*) AS v FROM orders WHERE created_at >= ${since} GROUP BY day`, days),
    gmv: series(`SELECT date(created_at) AS day, SUM(total) AS v FROM orders WHERE status != 'cancelled' AND created_at >= ${since} GROUP BY day`, days),
    signups: series(`SELECT date(created_at) AS day, COUNT(*) AS v FROM users WHERE created_at >= ${since} GROUP BY day`, days),
  };
  const topStores = db.prepare(
    `SELECT s.id, s.name, s.slug, s.color, s.logo_url, s.currency, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS revenue
     FROM stores s JOIN orders o ON o.store_id = s.id AND o.status != 'cancelled' AND o.created_at >= datetime('now', ?)
     GROUP BY s.id ORDER BY revenue DESC LIMIT 5`
  ).all(`-${period} days`);
  const activity = db.prepare(
    `SELECT * FROM (
       SELECT 'signup' AS kind, u.created_at AS at, u.name AS title, u.email AS detail, u.id AS ref, NULL AS store_id FROM users u
       UNION ALL
       SELECT 'store', s.created_at, s.name, u.name, s.id, s.id FROM stores s JOIN users u ON u.id = s.owner_id
       UNION ALL
       SELECT 'order', o.created_at, s.name, o.customer_name || ' · ' || printf('%.2f', o.total) || ' ' || s.currency, o.id, s.id FROM orders o JOIN stores s ON s.id = o.store_id
     ) ORDER BY at DESC LIMIT 12`
  ).all();
  const attention = {
    empty: db.prepare(`SELECT s.id, s.name, s.created_at, u.name AS owner FROM stores s JOIN users u ON u.id = s.owner_id
                       WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.store_id = s.id) ORDER BY s.id DESC LIMIT 5`).all(),
  };
  res.render('admin/overview', { period, cur, prev, totals, funnel, charts, topStores, activity, attention, ai: aiUsageMonth() });
});

// ----- Stores -----
admin.get('/stores', (req, res) => {
  const q = str(req.query.q, 100);
  const filter = ['active', 'suspended', 'empty', 'domain'].includes(req.query.f) ? req.query.f : 'all';
  const like = likeOf(q);
  const stores = db.prepare(
    `SELECT s.*, u.name AS owner_name, u.email AS owner_email,
       (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS product_count,
       (SELECT COUNT(*) FROM orders o WHERE o.store_id = s.id) AS order_count,
       (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.store_id = s.id AND o.status != 'cancelled') AS revenue,
       (SELECT MAX(created_at) FROM orders o WHERE o.store_id = s.id) AS last_order
     FROM stores s JOIN users u ON u.id = s.owner_id
     WHERE (? = '' OR s.name LIKE ? ESCAPE '\\' OR s.slug LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR s.custom_domain LIKE ? ESCAPE '\\')
       AND (? = 'all' OR (? = 'active' AND s.suspended = 0) OR (? = 'suspended' AND s.suspended = 1)
            OR (? = 'empty' AND NOT EXISTS (SELECT 1 FROM products p WHERE p.store_id = s.id))
            OR (? = 'domain' AND s.custom_domain IS NOT NULL))
     ORDER BY s.id DESC LIMIT 300`
  ).all(q, like, like, like, like, like, filter, filter, filter, filter, filter);
  res.render('admin/index', { stores, q, filter });
});

function adminStore(req, res, next) {
  const store = db.prepare('SELECT s.*, u.name AS owner_name, u.email AS owner_email, u.id AS owner_uid FROM stores s JOIN users u ON u.id = s.owner_id WHERE s.id = ?').get(req.params.id);
  if (!store) return res.status(404).render('message', { title: 'غير موجود', message: 'المتجر غير موجود.' });
  req.target = store;
  next();
}
admin.get('/stores/:id', adminStore, (req, res) => {
  const s = req.target;
  const stats = db.prepare(
    `SELECT (SELECT COUNT(*) FROM products WHERE store_id = ?) AS products,
            (SELECT COUNT(*) FROM products WHERE store_id = ? AND active = 1) AS live_products,
            (SELECT COUNT(*) FROM orders WHERE store_id = ?) AS orders,
            (SELECT COUNT(*) FROM orders WHERE store_id = ? AND status = 'cancelled') AS cancelled,
            (SELECT COALESCE(SUM(total), 0) FROM orders WHERE store_id = ? AND status != 'cancelled') AS revenue,
            (SELECT COUNT(*) FROM conversations WHERE store_id = ?) AS chats,
            (SELECT COUNT(*) FROM pages WHERE store_id = ?) AS pages`
  ).get(s.id, s.id, s.id, s.id, s.id, s.id, s.id);
  const orders = db.prepare('SELECT * FROM orders WHERE store_id = ? ORDER BY id DESC LIMIT 10').all(s.id);
  const sales = series(`SELECT date(created_at) AS day, SUM(total) AS v FROM orders WHERE store_id = ${Number(s.id)} AND status != 'cancelled' AND created_at >= date('now', '-29 days') GROUP BY day`, lastDays(30));
  res.render('admin/store', { s, stats, orders, sales, error: null, sub: billing.statusOf(s), plans: billing.plans(), paidPlans: billing.paidPlans(), payments: billing.historyOf(s.id), pending: billing.pendingOf(s.id) });
});
admin.post('/stores/:id/suspend', adminStore, (req, res) => {
  const on = req.body.suspend === '1' ? 1 : 0;
  db.prepare('UPDATE stores SET suspended = ?, suspend_reason = ? WHERE id = ?').run(on, on ? str(req.body.reason, 200) : '', req.target.id);
  const back = req.get('referer') || '';
  res.redirect(back.includes('/admin') ? back : `/admin/stores/${req.target.id}`);
});
admin.post('/stores/:id/delete', adminStore, (req, res) => {
  // Requires typing the store's slug to confirm. Deletes products, orders, pages and chats with it.
  if (str(req.body.confirm, 60) !== req.target.slug) {
    return res.status(400).render('message', { title: 'لم يُحذف', message: 'للتأكيد يجب كتابة رابط المتجر كما هو تماماً.' });
  }
  db.prepare('DELETE FROM stores WHERE id = ?').run(req.target.id);
  res.redirect('/admin/stores');
});

// ----- Merchants -----
admin.get('/merchants', (req, res) => {
  const q = str(req.query.q, 100);
  const like = likeOf(q);
  const merchants = db.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.suspended, u.created_at,
       (SELECT COUNT(*) FROM stores s WHERE s.owner_id = u.id) AS store_count,
       (SELECT COUNT(*) FROM orders o JOIN stores s ON s.id = o.store_id WHERE s.owner_id = u.id) AS order_count,
       (SELECT MAX(COALESCE(last_seen, created_at)) FROM sessions se WHERE se.user_id = u.id) AS last_seen
     FROM users u WHERE (? = '' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')
     ORDER BY u.id DESC LIMIT 500`
  ).all(q, like, like);
  res.render('admin/merchants', { merchants, q });
});

function adminUser(req, res, next) {
  const u = db.prepare('SELECT id, name, email, role, suspended, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).render('message', { title: 'غير موجود', message: 'الحساب غير موجود.' });
  req.target = u;
  next();
}
admin.get('/merchants/:id', adminUser, (req, res) => {
  const u = req.target;
  const stores = db.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS product_count,
       (SELECT COUNT(*) FROM orders o WHERE o.store_id = s.id) AS order_count,
       (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.store_id = s.id AND o.status != 'cancelled') AS revenue
     FROM stores s WHERE s.owner_id = ? ORDER BY s.id`
  ).all(u.id);
  const lastSeen = db.prepare('SELECT MAX(COALESCE(last_seen, created_at)) AS t FROM sessions WHERE user_id = ?').get(u.id).t;
  res.render('admin/merchant', { u, stores, lastSeen });
});
admin.post('/merchants/:id/suspend', adminUser, (req, res) => {
  const t = req.target;
  if (t.role === 'admin') return res.status(400).render('message', { title: 'خطأ', message: 'لا يمكن إيقاف حساب مسؤول.' });
  const on = req.body.suspend === '1' ? 1 : 0;
  transaction(() => {
    db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(on, t.id);
    if (on) auth.logoutEverywhere(t.id);
  });
  const back = req.get('referer') || '';
  res.redirect(back.includes('/admin/merchants/') ? back : '/admin/merchants');
});
admin.post('/merchants/:id/role', adminUser, (req, res) => {
  const t = req.target;
  if (t.id === req.user.id) return res.status(400).render('message', { title: 'خطأ', message: 'لا يمكنك تغيير صلاحيتك بنفسك.' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role === 'admin' ? 'admin' : 'merchant', t.id);
  res.redirect(`/admin/merchants/${t.id}`);
});
// Generate a one-hour password reset link for a merchant (to send them over WhatsApp, for example).
admin.post('/merchants/:id/reset-link', adminUser, (req, res) => {
  const t = req.target;
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(t.id, Date.now());
  db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), t.id, Date.now() + 60 * MIN);
  const link = `${baseUrl(req)}/reset/${token}`;
  res.render('admin/merchant-reset', { u: t, link });
});

// ----- Orders (platform-wide) -----
admin.get('/orders', (req, res) => {
  const q = str(req.query.q, 100);
  const status = STATUSES[req.query.status] ? req.query.status : '';
  const like = likeOf(q);
  const orders = db.prepare(
    `SELECT o.*, s.name AS store_name, s.currency, s.id AS sid FROM orders o JOIN stores s ON s.id = o.store_id
     WHERE (? = '' OR o.customer_name LIKE ? ESCAPE '\\' OR o.customer_phone LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')
       AND (? = '' OR o.status = ?)
     ORDER BY o.id DESC LIMIT 300`
  ).all(q, like, like, like, status, status);
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().map((r) => [r.status, r.n]));
  res.render('admin/orders', { orders, q, status, counts });
});

// ----- Platform settings -----
admin.get('/settings', (req, res) => res.render('admin/settings', { saved: !!req.query.saved, ai: aiUsageMonth() }));
admin.post('/settings', (req, res) => {
  setSetting('signups_open', req.body.signups_open ? '1' : '0');
  setSetting('ai_enabled', req.body.ai_enabled ? '1' : '0');
  setSetting('legal_name', str(req.body.legal_name, 120));
  setSetting('legal_address', str(req.body.legal_address, 300));
  if (req.body.legal_bump) setSetting('legal_updated', new Date().toISOString().slice(0, 10));
  setSetting('ai_cap_usd_month', String(Math.min(Math.max(0, Number(req.body.ai_cap_usd_month) || 0), 100000)));
  setSetting('notice', str(req.body.notice, 400));
  setSetting('notice_level', ['info', 'warning', 'success'].includes(req.body.notice_level) ? req.body.notice_level : 'info');
  setSetting('support_whatsapp', str(req.body.support_whatsapp, 20).replace(/\D/g, ''));
  setSetting('support_email', str(req.body.support_email, 200));
  res.redirect('/admin/settings?saved=1');
});

// ----- Subscriptions (admin side) -----
function tellMerchant(storeId, title, body) {
  const s = db.prepare('SELECT id, owner_id FROM stores WHERE id = ?').get(storeId);
  if (s) notifier.notify(s.owner_id, { kind: 'billing', storeId: s.id, link: `/dashboard/stores/${s.id}/billing`, title, body });
}
admin.get('/billing', (req, res) => {
  const pending = db.prepare(`SELECT b.*, s.name AS store_name, s.slug, s.plan AS cur_plan, s.plan_until, u.name AS owner_name, u.email AS owner_email
                              FROM subscriptions b JOIN stores s ON s.id = b.store_id LEFT JOIN users u ON u.id = s.owner_id
                              WHERE b.status = 'pending' ORDER BY b.id`).all();
  const recent = db.prepare(`SELECT b.*, s.name AS store_name FROM subscriptions b JOIN stores s ON s.id = b.store_id
                             WHERE b.status != 'pending' ORDER BY b.id DESC LIMIT 30`).all();
  const stores = db.prepare('SELECT s.*, u.name AS owner_name FROM stores s LEFT JOIN users u ON u.id = s.owner_id ORDER BY s.plan_until').all()
    .map((s) => ({ ...s, sub: billing.statusOf(s) }));
  const monthIncome = db.prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM subscriptions WHERE status = 'approved' AND decided_at >= date('now', 'start of month')").get().v;
  res.render('admin/billing', { pending, recent, stores, monthIncome, plans: billing.plans(), paidPlans: billing.paidPlans(), cfg: billing.settings(), saved: !!req.query.saved, ref: billing.reference });
});
admin.post('/billing/:subId/approve', (req, res) => {
  const sub = db.prepare("SELECT * FROM subscriptions WHERE id = ? AND status = 'pending'").get(req.params.subId);
  if (!sub) return res.redirect('/admin/billing');
  const r = billing.activate({ storeId: sub.store_id, planKey: str(req.body.plan, 20) || sub.plan, months: parseInt(req.body.months, 10) || sub.months, adminId: req.user.id,
    method: str(req.body.method, 20) || sub.method, amount: req.body.amount ?? null, reference: str(req.body.reference, 80), requestId: sub.id });
  tellMerchant(sub.store_id, `✅ تم تفعيل باقة ${r.plan.name}`, `اشتراكك فعّال حتى ${r.until.slice(0, 10)}. شكراً لثقتك!`);
  res.redirect(`/admin/billing?ok=${sub.store_id}`);
});
admin.post('/billing/:subId/reject', (req, res) => {
  const sub = db.prepare("SELECT * FROM subscriptions WHERE id = ? AND status = 'pending'").get(req.params.subId);
  if (sub) {
    db.prepare("UPDATE subscriptions SET status = 'rejected', note = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?").run(str(req.body.reason, 300) || sub.note, req.user.id, sub.id);
    tellMerchant(sub.store_id, '❌ لم يُقبل طلب الاشتراك', str(req.body.reason, 300) || 'تواصل مع فريق YASSER لمعرفة التفاصيل.');
  }
  res.redirect('/admin/billing');
});
// Activate a plan directly (the merchant paid in person, by phone…).
admin.post('/stores/:id/plan', adminStore, (req, res) => {
  const months = parseInt(req.body.months, 10);
  const pl = billing.planByKey(req.body.plan);
  if (!pl || pl.free || !billing.PERIODS[months]) return res.status(400).render('message', { title: 'خطأ', message: 'اختر باقة ومدة صحيحتين.' });
  db.prepare("DELETE FROM subscriptions WHERE store_id = ? AND status = 'pending'").run(req.target.id);
  const r = billing.activate({ storeId: req.target.id, planKey: req.body.plan, months, adminId: req.user.id, method: str(req.body.method, 20), amount: req.body.amount === '' ? null : req.body.amount, reference: str(req.body.reference, 80) });
  tellMerchant(req.target.id, `✅ تم تفعيل باقة ${r.plan.name}`, `اشتراكك فعّال حتى ${r.until.slice(0, 10)}. شكراً لثقتك!`);
  const back = req.get('referer') || '';
  res.redirect(back.includes('/admin') ? back : `/admin/stores/${req.target.id}`);
});
// End a subscription now (e.g. a payment that bounced). The grace days still apply.
admin.post('/stores/:id/plan/end', adminStore, (req, res) => {
  db.prepare('UPDATE stores SET plan_until = ? WHERE id = ?').run(billing.iso(Date.now() - 1000), req.target.id);
  res.redirect(`/admin/stores/${req.target.id}`);
});
admin.post('/billing/settings', (req, res) => {
  billing.savePlans(req.body);
  res.redirect('/admin/billing?saved=1#settings');
});

app.use('/admin', admin);

// ---------- Storefront ----------
// Theme + navigation values every storefront page needs (also used by the editor preview).
function storefrontLocals(store, customDomain = false) {
  const base = customDomain ? '' : `/s/${store.slug}`;
  return {
    base,
    menuPages: db.prepare('SELECT title, slug, in_menu, in_footer FROM pages WHERE store_id = ? ORDER BY position, id').all(store.id),
    // Service businesses (clinics, restaurants…) may sell nothing online: then no cart or product links.
    hasProducts: !!db.prepare('SELECT 1 FROM products WHERE store_id = ? AND active = 1 LIMIT 1').get(store.id),
    font: FONTS[store.font] || FONTS.tajawal,
    radius: (RADII[store.radius] || RADII.soft).v,
    theme: themeLib.sanitize(store.theme),
    themeClass: themeLib.classes(themeLib.sanitize(store.theme)),
    hfont: FONTS[themeLib.sanitize(store.theme).hfont] || null,
    // Store-relative links: "/products" -> "/s/<slug>/products".
    href: (link) => (link && link.startsWith('/') ? (link === '/' ? base || '/' : base + link) : link),
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
  res.locals.payMethods = payments.available(store);
  // On the merchant's own domain, only their store is reachable.
  if (req.customDomain && ![store.custom_domain, `www.${store.custom_domain}`].includes(req.customDomain)) {
    return res.status(404).render('message', { title: 'غير موجود', message: 'الصفحة غير موجودة.' });
  }
  Object.assign(res.locals, storefrontLocals(store, !!req.customDomain));
  req.base = res.locals.base;
  res.locals.orderError = str(req.query.order_error, 300);
  res.locals.contactSent = req.query.contact === 'sent';
  res.locals.contactError = str(req.query.contact_error, 200);
  res.locals.pagePath = `${req.base}${req.path === '/' ? '' : req.path}`;
  // Ad pixels: not for the owner browsing their own store (keeps ad data clean).
  res.locals.pixels = !res.locals.isOwner && (store.fb_pixel_id || store.tiktok_pixel_id)
    ? { fb: store.fb_pixel_id, tt: store.tiktok_pixel_id } : null;
  if (res.locals.pixels) res.set('Content-Security-Policy', PIXEL_CSP);
  // Absolute URLs for link previews (og:image must be absolute).
  const origin = req.customDomain ? `https://${req.customDomain}` : baseUrl(req);
  res.locals.abs = (u) => (!u ? '' : /^https?:\/\//.test(u) ? u : origin + u);
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
    if (sec.type === 'product_hero' || sec.type === 'order_form') {
      // A chosen product, or the newest one in stock as a sensible default.
      out.product = (sec.product && db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ? AND active = 1').get(sec.product, store.id))
        || db.prepare('SELECT * FROM products WHERE store_id = ? AND active = 1 ORDER BY stock = 0, id DESC LIMIT 1').get(store.id) || null;
    }
    if (sec.type === 'countdown') {
      const end = Date.parse(sec.ends_at ? sec.ends_at + ':00' : '');
      out.endsAt = Number.isFinite(end) && end > Date.now() ? end : null;
    }
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
        return res.redirect(`${req.base}/p/${product.id}?choose=1`);
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
  res.redirect(`${req.base}/cart`);
});

shop.get('/cart', (req, res) => res.render('store/cart', cartLines(req)));

shop.get('/checkout', (req, res) => {
  const cart = cartLines(req);
  if (!cart.lines.length) return res.redirect(`${req.base}/cart`);
  res.render('store/checkout', { ...cart, error: null, values: {} });
});

const orderValues = (body) => ({
  customer_name: str(body.customer_name, 100),
  customer_phone: cleanPhone(body.customer_phone),
  customer_address: str(body.customer_address, 500),
  note: str(body.note, 1000),
  customer_email: str(body.customer_email, 120).toLowerCase(),
  payment_method: str(body.payment_method, 20) || 'cod',
});
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

// Validate and create an order from cart lines. Shared by the cart checkout and landing-page orders.
// Returns { orderId } or { error, status }.
function placeOrder(req, cart, values) {
  const fail = (error, status = 400) => ({ error, status });
  if (!cart.lines.length) return fail('لا توجد منتجات في الطلب.');
  // Bots: a hidden field humans never fill, and a form submitted impossibly fast.
  const startedAt = Number(req.body._t) || 0;
  if (req.body.website || (startedAt && Date.now() - startedAt < 3000)) return fail('تعذّر إرسال الطلب، أعد المحاولة.');
  if (values.customer_name.length < 3) return fail('الرجاء إدخال الاسم الكامل.');
  if (!validPhone(values.customer_phone)) return fail('رقم الهاتف غير صحيح. مثال: 0612345678');
  if (values.customer_address.length < 8) return fail('الرجاء إدخال العنوان الكامل (المدينة، الحي، الشارع).');
  const methods = payments.available(req.store);
  const method = methods.includes(values.payment_method) ? values.payment_method : methods.length === 1 ? methods[0] : null;
  if (!method) return fail('الرجاء اختيار طريقة الدفع.');
  if (values.customer_email && !validEmail(values.customer_email)) return fail('البريد الإلكتروني غير صحيح.');
  if (method === 'cmi' && !values.customer_email) return fail('الرجاء إدخال بريدك الإلكتروني لاستلام وصل الدفع بالبطاقة.');
  const online = payments.isOnline(method);

  // Abuse limits: per IP and per phone number.
  if (!limiter.hit(`order-ip:${req.ip}`, 5, 60 * MIN)) return fail('طلبات كثيرة من نفس الجهاز. حاول لاحقاً أو تواصل مع المتجر.', 429);
  // An earlier attempt by the same customer that was never paid online is replaced by this one.
  for (const o of db.prepare("SELECT id FROM orders WHERE store_id = ? AND customer_phone = ? AND status = 'new' AND payment_status IN ('pending', 'failed')").all(req.store.id, values.customer_phone)) {
    cancelUnpaid(o.id, 'failed');
  }
  const recent = db
    .prepare(
      `SELECT id FROM orders WHERE store_id = ? AND customer_phone = ? AND status = 'new'
         AND payment_status NOT IN ('pending', 'failed', 'expired') AND created_at >= datetime('now', '-30 minutes') ORDER BY id DESC LIMIT 1`
    )
    .get(req.store.id, values.customer_phone);
  if (recent) return fail(`لديك طلب قيد المراجعة (رقم #${recent.id}). سيتصل بك المتجر قريباً لتأكيده. لتعديل طلبك تواصل مع المتجر.`, 409);
  const today = db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND customer_phone = ? AND payment_status NOT IN ('pending', 'failed', 'expired') AND created_at >= datetime('now', '-1 day')`)
    .get(req.store.id, values.customer_phone).n;
  if (today >= 3) return fail('تجاوزت عدد الطلبات المسموح به اليوم لهذا الرقم. تواصل مع المتجر مباشرة.', 429);
  try {
    const orderId = transaction(() => {
      const { lastInsertRowid } = db
        .prepare(`INSERT INTO orders (store_id, customer_name, customer_phone, customer_address, note, shipping, total, ip,
                   customer_email, payment_method, payment_status, pay_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.store.id, values.customer_name, values.customer_phone, values.customer_address, values.note, cart.shipping, cart.total, req.ip || '',
          values.customer_email, method, online ? 'pending' : payments.isManual(method) ? 'awaiting' : 'unpaid', crypto.randomBytes(16).toString('hex'));
      const take = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
      const addItem = db.prepare('INSERT INTO order_items (order_id, product_id, name, price, quantity) VALUES (?, ?, ?, ?, ?)');
      for (const l of cart.lines) {
        if (take.run(l.quantity, l.product.id, l.quantity).changes !== 1) throw new Error('OUT_OF_STOCK');
        addItem.run(lastInsertRowid, l.product.id, l.variant ? `${l.product.name} (${l.variant})` : l.product.name, l.product.price, l.quantity);
      }
      return Number(lastInsertRowid);
    });
    // Online payments: the merchant hears about the order once it is paid.
    if (!online) notifyNewOrder(req, orderId); // fire and forget
    return { orderId, next: nextStep(req, orderId) };
  } catch (err) {
    if (err.message !== 'OUT_OF_STOCK') throw err;
    return fail('نفدت الكمية المطلوبة من المنتج.', 409);
  }
}

shop.post('/checkout', (req, res) => {
  const values = orderValues(req.body);
  const cart = cartLines(req);
  if (!cart.lines.length) return res.redirect(`${req.base}/cart`);
  const r = placeOrder(req, cart, values);
  if (r.error) return res.status(r.status).render('store/checkout', { ...cartLines(req), error: r.error, values });
  delete req.cart[req.store.id];
  auth.saveCart(req);
  res.redirect(r.next);
});

// Landing pages: order one product directly (no cart). Answers JSON to fetch(), redirects otherwise.
shop.post('/quick-order', (req, res) => {
  const wantsJson = (req.get('accept') || '').includes('application/json');
  const back = str(req.body.back, 300).startsWith(req.base || '/') ? str(req.body.back, 300) : req.base || '/';
  const reply = (r) => {
    if (wantsJson) return res.status(r.error ? r.status : 200).json(r.error ? { error: r.error } : { redirect: r.next });
    if (r.error) return res.redirect(`${back}${back.includes('?') ? '&' : '?'}order_error=${encodeURIComponent(r.error)}#order`);
    res.redirect(r.next);
  };
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ? AND active = 1').get(req.body.product_id, req.store.id);
  if (!product) return reply({ error: 'المنتج غير متوفر.', status: 404 });
  const options = JSON.parse(product.options || '[]');
  const chosen = options.map((o, i) => str(req.body[`opt${i}`], 30));
  if (options.some((o, i) => !o.values.includes(chosen[i]))) return reply({ error: `الرجاء اختيار ${options.map((o) => o.name).join(' و')}.`, status: 400 });
  const quantity = Math.min(Math.max(1, parseInt(req.body.quantity, 10) || 1), 20);
  if (product.stock < quantity) return reply({ error: product.stock ? `المتوفر ${product.stock} فقط.` : 'نفدت الكمية.', status: 409 });
  const lines = [{ product, quantity, variant: chosen.join(' / '), subtotal: quantity * product.price }];
  const subtotal = lines[0].subtotal;
  const { shipping_fee: fee, free_shipping_over: freeOver } = req.store;
  const shipping = freeOver > 0 && subtotal >= freeOver ? 0 : fee;
  reply(placeOrder(req, { lines, subtotal, shipping, total: subtotal + shipping }, orderValues(req.body)));
});

shop.get('/thanks/:orderId', (req, res) => {
  const order = db.prepare('SELECT id, total, payment_method, payment_status, pay_token FROM orders WHERE id = ? AND store_id = ?').get(req.params.orderId, req.store.id);
  if (!order) return res.redirect(req.base || '/');
  // An online order that is not paid yet goes back to its payment step.
  // (No payment link here: order numbers are guessable, the link is only in the customer's own redirect.)
  if (payments.isOnline(order.payment_method) && order.payment_status !== 'paid') {
    return res.render('message', { title: 'بانتظار الدفع', message: `الطلب #${order.id} لم يُدفع بعد. إن أغلقت صفحة الدفع، أعد الطلب من المتجر.` });
  }
  res.locals.payDetails = payments.isManual(order.payment_method) ? payments.publicDetails(req.store, order.payment_method) : [];
  delete order.pay_token;
  const items = db.prepare('SELECT product_id, quantity, price FROM order_items WHERE order_id = ?').all(order.id);
  res.render('store/thanks', { order, items });
});

// ----- Payments -----
// Where to send the customer right after the order is created.
function nextStep(req, orderId) {
  const o = db.prepare('SELECT payment_method, pay_token FROM orders WHERE id = ?').get(orderId);
  return payments.isOnline(o.payment_method) ? `${req.base}/pay/${orderId}?t=${o.pay_token}` : `${req.base}/thanks/${orderId}`;
}
const here = (req) => `${req.protocol}://${req.get('host')}${req.base}`;
function payUrls(req, order) {
  const b = `${here(req)}/pay/${order.id}`;
  const t = `t=${order.pay_token}`;
  return {
    return: `${b}/return?${t}`, cancel: `${b}/cancel?${t}`, shop: here(req) || '/',
    cmiOk: `${b}/cmi/ok`, cmiFail: `${b}/cmi/fail`, cmiCallback: `${b}/cmi/callback`,
  };
}
// The order a payment URL is about; the random token in the link proves it belongs to this customer.
function payOrder(req) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(req.params.orderId, req.store.id);
  if (!order || !order.pay_token) return null;
  const a = Buffer.from(String(req.query.t || req.body?.t || ''));
  const b = Buffer.from(order.pay_token);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? order : null;
}
function cancelUnpaid(orderId, payStatus) {
  transaction(() => {
    const changed = db.prepare("UPDATE orders SET status = 'cancelled', payment_status = ? WHERE id = ? AND status = 'new' AND payment_status IN ('pending', 'failed')").run(payStatus, orderId).changes;
    if (changed) adjustStock(orderId, +1);
  });
}
// Online orders left unpaid for 2 hours give their stock back.
function expireUnpaid() {
  const stale = db.prepare("SELECT id FROM orders WHERE status = 'new' AND payment_status IN ('pending', 'failed') AND created_at < datetime('now', '-2 hours')").all();
  for (const o of stale) cancelUnpaid(o.id, 'expired');
  return stale.length;
}
// Marks an order paid exactly once, then tells the merchant.
function markPaid(req, order, ref) {
  const changed = db.prepare("UPDATE orders SET payment_status = 'paid', payment_note = ?, paid_at = datetime('now') WHERE id = ? AND payment_status != 'paid'")
    .run(String(ref || '').slice(0, 120), order.id).changes;
  if (changed && payments.isOnline(order.payment_method)) notifyNewOrder(req, order.id);
  return changed;
}
const payFailed = (req, res, order, reason, status = 200) =>
  res.status(status).render('store/pay-failed', { order, reason, codOk: payments.available(req.store).includes('cod'), retry: `${req.base}/pay/${order.id}?t=${order.pay_token}` });

shop.get('/pay/:orderId', async (req, res, next) => {
  const order = payOrder(req);
  if (!order) return res.redirect(req.base || '/');
  if (order.payment_status === 'paid' || !payments.isOnline(order.payment_method)) return res.redirect(`${req.base}/thanks/${order.id}`);
  if (order.status === 'cancelled') return payFailed(req, res, order, 'انتهت صلاحية هذا الطلب. أعد الطلب من المتجر.');
  if (!payments.available(req.store).includes(order.payment_method)) return payFailed(req, res, order, 'طريقة الدفع هذه لم تعد متاحة في المتجر.');
  try {
    const step = await payments.PROVIDERS[order.payment_method].start({ store: req.store, order, urls: payUrls(req, order) });
    db.prepare("UPDATE orders SET payment_ref = ?, payment_amount = ?, payment_status = 'pending' WHERE id = ?").run(step.ref, step.amount, order.id);
    if (step.redirect) return res.redirect(303, step.redirect);
    res.render('store/pay-redirect', { form: step.form, order });
  } catch (err) {
    console.error(`Payment start failed (store ${req.store.id}, order ${order.id}):`, err.message);
    payFailed(req, res, order, 'تعذّر الاتصال ببوابة الدفع. حاول مرة أخرى بعد قليل.', 502);
  }
});
shop.get('/pay/:orderId/return', async (req, res) => {
  const order = payOrder(req);
  if (!order) return res.redirect(req.base || '/');
  if (order.payment_status === 'paid') return res.redirect(`${req.base}/thanks/${order.id}`);
  try {
    const r = await payments.PROVIDERS[order.payment_method]?.verify({ store: req.store, order, query: req.query });
    if (r?.paid) {
      markPaid(req, order, r.ref);
      return res.redirect(`${req.base}/thanks/${order.id}`);
    }
  } catch (err) {
    console.error(`Payment check failed (store ${req.store.id}, order ${order.id}):`, err.message);
  }
  db.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = ? AND payment_status = 'pending'").run(order.id);
  payFailed(req, res, order, 'لم يتم تأكيد الدفع. لم يُقتطع أي مبلغ، أو سيُعاد تلقائياً إن اقتُطع.');
});
shop.get('/pay/:orderId/cancel', (req, res) => {
  const order = payOrder(req);
  if (!order) return res.redirect(req.base || '/');
  if (order.payment_status === 'paid') return res.redirect(`${req.base}/thanks/${order.id}`);
  const reasons = {
    declined: 'رُفضت العملية من البنك. تأكّد من معلومات البطاقة أو جرّب بطاقة أخرى.',
    unconfirmed: 'لم يتم تأكيد الدفع بالبطاقة.',
  };
  payFailed(req, res, order, reasons[req.query.r] || 'ألغيت عملية الدفع. طلبك محفوظ، يمكنك المحاولة من جديد.');
});
// Give up on paying online: switch the order to cash on delivery (if the store accepts it).
shop.post('/pay/:orderId/cod', (req, res) => {
  const order = payOrder(req);
  if (!order) return res.redirect(req.base || '/');
  if (order.payment_status !== 'paid' && order.status === 'new' && payments.available(req.store).includes('cod')) {
    const changed = db.prepare("UPDATE orders SET payment_method = 'cod', payment_status = 'unpaid' WHERE id = ? AND payment_status != 'paid'").run(order.id).changes;
    if (changed) notifyNewOrder(req, order.id);
  }
  res.redirect(`${req.base}/thanks/${order.id}`);
});
// CMI: server-to-server confirmation, and the customer's browser coming back (both signed).
function cmiOrder(req) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND store_id = ? AND payment_method = 'cmi'").get(req.params.orderId, req.store.id);
  return order && { order, result: payments.PROVIDERS.cmi.check(req.store, order, req.body || {}) };
}
shop.post('/pay/:orderId/cmi/callback', (req, res) => {
  const c = cmiOrder(req);
  res.type('text');
  if (!c || !c.result.signed) return res.send('FAILURE');
  if (!c.result.paid) return res.send('APPROVED');
  markPaid(req, c.order, c.result.ref);
  res.send('ACTION=POSTAUTH');
});
// The browser comes back with a POST; answer with a redirect so the next page is a normal GET
// (with the customer's own cookies). Unsigned posts learn nothing.
shop.post('/pay/:orderId/cmi/ok', (req, res) => {
  const c = cmiOrder(req);
  if (!c || !c.result.signed) return res.redirect(303, req.base || '/');
  if (c.result.paid) {
    markPaid(req, c.order, c.result.ref);
    return res.redirect(303, `${req.base}/thanks/${c.order.id}`);
  }
  res.redirect(303, `${req.base}/pay/${c.order.id}/cancel?t=${c.order.pay_token}&r=unconfirmed`);
});
shop.post('/pay/:orderId/cmi/fail', (req, res) => {
  const c = cmiOrder(req);
  if (!c || !c.result.signed) return res.redirect(303, req.base || '/');
  if (c.order.payment_status !== 'paid') db.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = ? AND payment_status = 'pending'").run(c.order.id);
  res.redirect(303, `${req.base}/pay/${c.order.id}/cancel?t=${c.order.pay_token}&r=declined`);
});

// ----- Storefront live chat -----
// A visitor is identified per store by a hash of their session token (never the token itself).
const visitorKey = (req) => sha256(`${req.store.id}:${req.session.token}`);
const msgFields = 'id, sender, body, created_at';
function visitorConversation(req) {
  return db.prepare("SELECT * FROM conversations WHERE store_id = ? AND visitor_key = ? ORDER BY id DESC LIMIT 1").get(req.store.id, visitorKey(req));
}
shop.get('/chat', (req, res) => {
  const conv = visitorConversation(req);
  if (!conv) return res.json({ messages: [], unread: 0 });
  const after = Number(req.query.after) || 0;
  const messages = db.prepare(`SELECT ${msgFields} FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT 200`).all(conv.id, after);
  if (req.query.read && conv.unread_visitor) db.prepare('UPDATE conversations SET unread_visitor = 0 WHERE id = ?').run(conv.id);
  res.json({ messages, unread: req.query.read ? 0 : conv.unread_visitor, name: conv.name });
});
shop.post('/chat', (req, res) => {
  if (!req.store.chat_enabled) return res.status(403).json({ error: 'الدردشة غير مفعّلة.' });
  const body = str(req.body.body, 1000);
  if (!body) return res.status(400).json({ error: 'اكتب رسالتك.' });
  if (!limiter.hit(`chat:${req.ip}`, 15, MIN) || !limiter.hit(`chat-day:${req.ip}`, 300, 24 * 60 * MIN)) {
    return res.status(429).json({ error: 'رسائل كثيرة. انتظر قليلاً.' });
  }
  const name = str(req.body.name, 60);
  const phone = cleanPhone(req.body.phone);
  let conv = visitorConversation(req);
  let isNew = false;
  if (!conv) {
    const { lastInsertRowid } = db.prepare('INSERT INTO conversations (store_id, visitor_key, name, phone) VALUES (?, ?, ?, ?)')
      .run(req.store.id, visitorKey(req), name, validPhone(phone) ? phone : '');
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(lastInsertRowid);
    isNew = true;
  } else if ((name && !conv.name) || (validPhone(phone) && !conv.phone)) {
    db.prepare('UPDATE conversations SET name = COALESCE(NULLIF(name, \'\'), ?), phone = COALESCE(NULLIF(phone, \'\'), ?) WHERE id = ?')
      .run(name, validPhone(phone) ? phone : '', conv.id);
  }
  const { lastInsertRowid: mid } = db.prepare("INSERT INTO messages (conversation_id, sender, body) VALUES (?, 'visitor', ?)").run(conv.id, body);
  db.prepare("UPDATE conversations SET status = 'open', unread_merchant = unread_merchant + 1, last_message = ?, last_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
    .run(body.slice(0, 140), conv.id);
  notifyChat(req, conv, body, isNew);
  res.json({ message: db.prepare(`SELECT ${msgFields} FROM messages WHERE id = ?`).get(mid) });
});

// "Contact form" section: the message lands in the merchant's inbox like a chat.
shop.post('/contact', (req, res) => {
  const back = str(req.body.back, 300).startsWith(req.base || '/') ? str(req.body.back, 300) : req.base || '/';
  const go = (q) => res.redirect(`${back}${back.includes('?') ? '&' : '?'}${q}#contact-form`);
  const startedAt = Number(req.body._t) || 0;
  if (req.body.website || (startedAt && Date.now() - startedAt < 2000)) return go('contact=sent'); // bots: pretend it worked
  const name = str(req.body.name, 80);
  const phone = cleanPhone(req.body.phone);
  const message = str(req.body.message, 1500);
  if (name.length < 2) return go(`contact_error=${encodeURIComponent('الرجاء كتابة اسمك.')}`);
  if (!validPhone(phone)) return go(`contact_error=${encodeURIComponent('رقم الهاتف غير صحيح. مثال: 0612345678')}`);
  if (message.length < 5) return go(`contact_error=${encodeURIComponent('اكتب رسالتك.')}`);
  if (!limiter.hit(`contact:${req.ip}`, 5, 60 * MIN)) return go(`contact_error=${encodeURIComponent('رسائل كثيرة. حاول لاحقاً.')}`);
  const { lastInsertRowid } = db.prepare('INSERT INTO conversations (store_id, visitor_key, name, phone) VALUES (?, ?, ?, ?)')
    .run(req.store.id, visitorKey(req), name, phone);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(lastInsertRowid);
  const body = `✉️ رسالة من نموذج التواصل\n${message}`;
  db.prepare("INSERT INTO messages (conversation_id, sender, body) VALUES (?, 'visitor', ?)").run(conv.id, body);
  db.prepare("UPDATE conversations SET status = 'open', unread_merchant = 1, last_message = ?, last_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
    .run(body.slice(0, 140), conv.id);
  notifyChat(req, conv, message, true);
  go('contact=sent');
});

function notifyChat(req, conv, body, isNew) {
  const path = `/dashboard/stores/${req.store.id}/inbox/${conv.id}`;
  const link = `${baseUrl(req)}${path}`;
  const who = conv.name || 'زائر';
  notifier.notify(req.store.owner_id, {
    kind: 'chat', storeId: req.store.id, link: path, tag: `chat-${conv.id}`, collapse: true,
    title: `💬 ${who}`, body: body.slice(0, 160),
    // Email only when a conversation starts, not for every message.
    email: isNew ? {
      subject: `💬 رسالة جديدة من ${who} · ${req.store.name}`,
      text: `${who} كتب في متجر ${req.store.name}:\n\n${body}\n\nردّ عليه: ${link}`,
      html: mailer.layout('رسالة جديدة في متجرك', `<p><strong>${mailer.esc(who)}</strong> كتب:</p>
        <blockquote style="margin:0;padding:12px 16px;background:#f6f7f9;border-radius:8px">${mailer.esc(body)}</blockquote>
        <p><a href="${mailer.esc(link)}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">الرد على الرسالة</a></p>`),
    } : null,
  });
}

// Tell the merchant about a new order: bell + phone push + email (per their preferences).
function notifyNewOrder(req, orderId) {
  const store = req.store;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  const money = app.locals.money;
  const path = `/dashboard/stores/${store.id}/orders/${orderId}`;
  const link = `${baseUrl(req)}${path}`;
  const e = mailer.esc;
  // A returning customer who received earlier orders is worth knowing about.
  const delivered = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND customer_phone = ? AND status = 'delivered' AND id != ?")
    .get(store.id, order.customer_phone, orderId).n;
  const paidNow = order.payment_status === 'paid';
  const payLabel = `${payments.METHODS[order.payment_method]?.label || ''}${paidNow ? ' · ✅ مدفوع' : ''}`;
  const title = `${paidNow ? '💳 ' : delivered ? '⭐ عميل موثوق · ' : '🛒 '}طلب جديد #${orderId} · ${money(order.total, store.currency)}${paidNow ? ' · مدفوع' : ''}`;
  const lines = items.map((i) => `• ${i.name} × ${i.quantity} — ${money(i.price * i.quantity, store.currency)}`).join('\n');
  notifier.notify(store.owner_id, {
    kind: 'order', storeId: store.id, link: path, tag: `order-${orderId}`,
    title, body: `${order.customer_name} · ${items.map((i) => i.name).join('، ').slice(0, 120)}`,
    email: {
      subject: `${title} · ${store.name}`,
      text: `طلب جديد في متجر ${store.name}\n\nالعميل: ${order.customer_name}\nالهاتف: ${order.customer_phone}\nالعنوان: ${order.customer_address}\n\n${lines}\n\nالإجمالي: ${money(order.total, store.currency)}\nالدفع: ${payLabel}\n\nعرض الطلب: ${link}`,
      html: mailer.layout(`طلب جديد #${orderId}`, `
        <p>وصلك طلب جديد في متجر <strong>${e(store.name)}</strong> 🎉${delivered ? ' — <strong>عميل موثوق</strong> استلم طلبات سابقة.' : ''}</p>
        <table style="width:100%;border-collapse:collapse;margin:12px 0">
          ${items.map((i) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${e(i.name)} × ${i.quantity}</td><td style="text-align:left;border-bottom:1px solid #eee">${e(money(i.price * i.quantity, store.currency))}</td></tr>`).join('')}
          ${order.shipping ? `<tr><td style="padding:6px 0">التوصيل</td><td style="text-align:left">${e(money(order.shipping, store.currency))}</td></tr>` : ''}
          <tr><td style="padding:8px 0"><strong>الإجمالي</strong></td><td style="text-align:left"><strong>${e(money(order.total, store.currency))}</strong></td></tr>
          <tr><td style="padding:6px 0">الدفع</td><td style="text-align:left">${e(payLabel)}</td></tr>
        </table>
        <p><strong>العميل:</strong> ${e(order.customer_name)}<br><strong>الهاتف:</strong> <span dir="ltr">${e(order.customer_phone)}</span><br><strong>العنوان:</strong> ${e(order.customer_address)}</p>
        <p><a href="${e(link)}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">عرض الطلب وتأكيده</a></p>`),
    },
  });
  // Products that just dropped to 3 or fewer.
  for (const i of items) {
    const p = i.product_id && db.prepare('SELECT id, name, stock FROM products WHERE id = ?').get(i.product_id);
    if (p && p.stock <= 3 && p.stock + i.quantity > 3) {
      notifier.notify(store.owner_id, {
        kind: 'stock', storeId: store.id, link: `/dashboard/stores/${store.id}/products/${p.id}`, tag: `stock-${p.id}`,
        title: p.stock ? `⚠️ بقي ${p.stock} فقط من «${p.name}»` : `⛔ نفدت كمية «${p.name}»`,
        body: 'زِد المخزون حتى لا تفوتك الطلبات.',
      });
    }
  }
}

app.use('/s/:slug', shop);

app.use((req, res) => res.status(404).render('message', { title: 'غير موجود', message: 'الصفحة غير موجودة.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('message', { title: 'خطأ', message: 'حدث خطأ غير متوقع.' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`YASSER running on http://localhost:${PORT}`));
  maintenance.scheduleMaintenance();
  setInterval(() => { try { expireUnpaid(); } catch (err) { console.error('expireUnpaid:', err.message); } }, 15 * MIN).unref();
  // Stop cleanly (finish in-flight requests, close the database) when the host restarts the app.
  const stop = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 10000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
module.exports = app;
app.expireUnpaid = () => expireUnpaid();
