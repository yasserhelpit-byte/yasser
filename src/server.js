const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { db, transaction } = require('./db');
const auth = require('./auth');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(auth.sessionMiddleware);

// CSRF: a per-session token derived from the session token, checked on every POST.
const CSRF_SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
app.use((req, res, next) => {
  const csrf = crypto.createHmac('sha256', CSRF_SECRET).update(req.session.token).digest('hex');
  res.locals.csrf = csrf;
  res.locals.flash = null;
  if (req.method === 'POST' && req.body._csrf !== csrf) {
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
app.locals.money = (n, cur) => `${Number(n).toFixed(2)} ${cur || ''}`.trim();

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const slugify = (s) =>
  str(s, 60).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

// ---------- Public pages ----------
app.get('/', (req, res) => {
  const stores = db.prepare('SELECT name, slug, description, color FROM stores ORDER BY id DESC LIMIT 6').all();
  res.render('home', { stores });
});

app.get('/signup', (req, res) => res.render('signup', { error: null, values: {} }));
app.post('/signup', (req, res) => {
  const name = str(req.body.name, 100);
  const email = str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  let error = null;
  if (!name || !email || !email.includes('@')) error = 'الرجاء إدخال الاسم والبريد الإلكتروني بشكل صحيح.';
  else if (password.length < 8) error = 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.';
  else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) error = 'هذا البريد مسجل مسبقاً.';
  if (error) return res.status(400).render('signup', { error, values: { name, email } });
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email, auth.hashPassword(password));
  auth.login(req, Number(lastInsertRowid));
  res.redirect('/dashboard');
});

app.get('/login', (req, res) => res.render('login', { error: null, values: {} }));
app.post('/login', (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !auth.verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(400).render('login', { error: 'البريد أو كلمة المرور غير صحيحة.', values: { email } });
  }
  auth.login(req, user.id);
  res.redirect('/dashboard');
});

app.post('/logout', (req, res) => {
  auth.logout(req);
  res.redirect('/');
});

// ---------- Merchant dashboard ----------
const dash = express.Router();
dash.use(auth.requireLogin);

function ownStore(req, res, next) {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND owner_id = ?').get(req.params.storeId, req.user.id);
  if (!store) return res.status(404).render('message', { title: 'غير موجود', message: 'المتجر غير موجود.' });
  req.store = store;
  res.locals.store = store;
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
    .prepare('INSERT INTO stores (owner_id, name, slug, description, color, currency) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, values.name, values.slug, values.description, values.color, values.currency);
  res.redirect(`/dashboard/stores/${lastInsertRowid}`);
});

function readStoreForm(body) {
  return {
    name: str(body.name, 100),
    slug: slugify(body.slug || body.name),
    description: str(body.description, 1000),
    color: /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#0f766e',
    currency: str(body.currency, 5).toUpperCase() || 'MAD',
  };
}

function validateStore(values, excludeId = 0) {
  if (!values.name) return 'اسم المتجر مطلوب.';
  if (!values.slug || values.slug.length < 3) return 'رابط المتجر يجب أن يكون 3 أحرف إنجليزية على الأقل (a-z, 0-9, -).';
  if (db.prepare('SELECT 1 FROM stores WHERE slug = ? AND id != ?').get(values.slug, excludeId)) return 'هذا الرابط مستخدم، اختر رابطاً آخر.';
  return null;
}

dash.get('/stores/:storeId', ownStore, (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE store_id = ? ORDER BY id DESC').all(req.store.id);
  const orders = db.prepare('SELECT * FROM orders WHERE store_id = ? ORDER BY id DESC LIMIT 10').all(req.store.id);
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total END), 0) AS revenue,
              SUM(status = 'new') AS pending FROM orders WHERE store_id = ?`
    )
    .get(req.store.id);
  res.render('dashboard/store', { products, orders, stats });
});

dash.get('/stores/:storeId/settings', ownStore, (req, res) =>
  res.render('dashboard/store-form', { error: null, values: req.store, action: `/dashboard/stores/${req.store.id}/settings` })
);
dash.post('/stores/:storeId/settings', ownStore, (req, res) => {
  const values = readStoreForm(req.body);
  const error = validateStore(values, req.store.id);
  const action = `/dashboard/stores/${req.store.id}/settings`;
  if (error) return res.status(400).render('dashboard/store-form', { error, values, action });
  db.prepare('UPDATE stores SET name = ?, slug = ?, description = ?, color = ?, currency = ? WHERE id = ?').run(
    values.name, values.slug, values.description, values.color, values.currency, req.store.id
  );
  res.redirect(`/dashboard/stores/${req.store.id}`);
});

function readProductForm(body) {
  return {
    name: str(body.name, 200),
    description: str(body.description, 3000),
    price: Number(body.price),
    stock: Math.max(0, parseInt(body.stock, 10) || 0),
    image_url: /^https?:\/\//.test(str(body.image_url)) ? str(body.image_url, 1000) : '',
    active: body.active ? 1 : 0,
  };
}
function validateProduct(p) {
  if (!p.name) return 'اسم المنتج مطلوب.';
  if (!Number.isFinite(p.price) || p.price < 0) return 'السعر غير صحيح.';
  return null;
}

dash.get('/stores/:storeId/products/new', ownStore, (req, res) =>
  res.render('dashboard/product-form', { error: null, values: { active: 1 }, action: `/dashboard/stores/${req.store.id}/products` })
);
dash.post('/stores/:storeId/products', ownStore, (req, res) => {
  const p = readProductForm(req.body);
  const error = validateProduct(p);
  if (error) return res.status(400).render('dashboard/product-form', { error, values: p, action: req.originalUrl });
  db.prepare('INSERT INTO products (store_id, name, description, price, stock, image_url, active) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    req.store.id, p.name, p.description, p.price, p.stock, p.image_url, p.active
  );
  res.redirect(`/dashboard/stores/${req.store.id}`);
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
  db.prepare('UPDATE products SET name = ?, description = ?, price = ?, stock = ?, image_url = ?, active = ? WHERE id = ?').run(
    p.name, p.description, p.price, p.stock, p.image_url, p.active, req.product.id
  );
  res.redirect(`/dashboard/stores/${req.store.id}`);
});
dash.post('/stores/:storeId/products/:productId/delete', ownStore, ownProduct, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.product.id);
  res.redirect(`/dashboard/stores/${req.store.id}`);
});

dash.get('/stores/:storeId/orders', ownStore, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE store_id = ? ORDER BY id DESC').all(req.store.id);
  res.render('dashboard/orders', { orders });
});
dash.get('/stores/:storeId/orders/:orderId', ownStore, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(req.params.orderId, req.store.id);
  if (!order) return res.status(404).render('message', { title: 'غير موجود', message: 'الطلب غير موجود.' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  res.render('dashboard/order', { order, items });
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

app.use('/dashboard', dash);

// ---------- Storefront ----------
const shop = express.Router({ mergeParams: true });
shop.use((req, res, next) => {
  const store = db.prepare('SELECT * FROM stores WHERE slug = ?').get(req.params.slug);
  if (!store) return res.status(404).render('message', { title: 'غير موجود', message: 'المتجر غير موجود.' });
  req.store = store;
  res.locals.store = store;
  res.locals.cartCount = Object.values(req.cart[store.id] || {}).reduce((a, b) => a + b, 0);
  next();
});

function cartLines(req) {
  const items = req.cart[req.store.id] || {};
  const ids = Object.keys(items);
  if (!ids.length) return { lines: [], total: 0 };
  const products = db
    .prepare(`SELECT * FROM products WHERE store_id = ? AND active = 1 AND id IN (${ids.map(() => '?').join(',')})`)
    .all(req.store.id, ...ids);
  const lines = products.map((p) => {
    const quantity = Math.min(items[p.id], p.stock);
    return { product: p, quantity, subtotal: quantity * p.price };
  }).filter((l) => l.quantity > 0);
  return { lines, total: lines.reduce((a, l) => a + l.subtotal, 0) };
}

const SORTS = {
  new: 'id DESC',
  price_asc: 'price ASC, id DESC',
  price_desc: 'price DESC, id DESC',
};
shop.get('/', (req, res) => {
  const q = str(req.query.q, 100);
  const sort = SORTS[req.query.sort] ? req.query.sort : 'new';
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  // In-stock products first, then the chosen order.
  const products = db
    .prepare(
      `SELECT * FROM products WHERE store_id = ? AND active = 1
         AND (? = '' OR name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
       ORDER BY (stock = 0), ${SORTS[sort]}`
    )
    .all(req.store.id, q, like, like);
  const total = db.prepare('SELECT COUNT(*) AS n FROM products WHERE store_id = ? AND active = 1').get(req.store.id).n;
  const newest = db.prepare('SELECT MAX(id) AS id FROM products WHERE store_id = ? AND active = 1').get(req.store.id).id;
  res.render('store/index', { products, q, sort, total, newest });
});

shop.get('/p/:productId', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ? AND active = 1').get(req.params.productId, req.store.id);
  if (!product) return res.status(404).render('message', { title: 'غير موجود', message: 'المنتج غير موجود.' });
  res.render('store/product', { product });
});

shop.post('/cart', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ? AND active = 1').get(req.body.product_id, req.store.id);
  if (product) {
    const cart = (req.cart[req.store.id] ||= {});
    const qty = Math.max(0, parseInt(req.body.quantity, 10) || 0);
    const next = req.body.mode === 'set' ? qty : (cart[product.id] || 0) + qty;
    if (next <= 0) delete cart[product.id];
    else cart[product.id] = Math.min(next, product.stock);
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
    customer_phone: str(req.body.customer_phone, 30),
    customer_address: str(req.body.customer_address, 500),
    note: str(req.body.note, 1000),
  };
  const cart = cartLines(req);
  if (!cart.lines.length) return res.redirect(`/s/${req.store.slug}/cart`);
  if (!values.customer_name || !values.customer_phone || !values.customer_address) {
    return res.status(400).render('store/checkout', { ...cart, error: 'الرجاء ملء الاسم والهاتف والعنوان.', values });
  }
  let orderId;
  try {
    orderId = transaction(() => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO orders (store_id, customer_name, customer_phone, customer_address, note, total) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.store.id, values.customer_name, values.customer_phone, values.customer_address, values.note, cart.total);
      const take = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
      const addItem = db.prepare('INSERT INTO order_items (order_id, product_id, name, price, quantity) VALUES (?, ?, ?, ?, ?)');
      for (const l of cart.lines) {
        if (take.run(l.quantity, l.product.id, l.quantity).changes !== 1) throw new Error('OUT_OF_STOCK');
        addItem.run(lastInsertRowid, l.product.id, l.product.name, l.product.price, l.quantity);
      }
      return Number(lastInsertRowid);
    });
  } catch (err) {
    if (err.message !== 'OUT_OF_STOCK') throw err;
    return res.status(409).render('store/checkout', { ...cartLines(req), error: 'نفدت كمية أحد المنتجات، راجع السلة.', values });
  }
  delete req.cart[req.store.id];
  auth.saveCart(req);
  res.redirect(`/s/${req.store.slug}/thanks/${orderId}`);
});

shop.get('/thanks/:orderId', (req, res) => {
  const order = db.prepare('SELECT id, total FROM orders WHERE id = ? AND store_id = ?').get(req.params.orderId, req.store.id);
  if (!order) return res.redirect(`/s/${req.store.slug}`);
  res.render('store/thanks', { order });
});

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
