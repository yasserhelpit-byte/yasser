const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yasser-test-'));
const mailer = require('../src/mailer');
const sent = [];
mailer.send = async (m) => { sent.push(m); return true; }; // capture emails instead of sending
const app = require('../src/server');

// Minimal cookie-keeping client.
function client(base) {
  let cookie = '';
  const req = async function req(method, url, form) {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: form ? new URLSearchParams(form) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  req.cookie = () => cookie;
  return req;
}
const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || html.match(/csrf = "([a-f0-9]{64})"/))[1];

test('merchant creates a store, customer orders, stock decreases', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const merchant = client(base);
  let page = await merchant('GET', '/signup');
  let csrf = csrfOf(page.text);
  let r = await merchant('POST', '/signup', { _csrf: csrf, name: 'Yasser', email: 'm@example.com', password: 'password123' , accept_terms: '1' });
  assert.strictEqual(r.location, '/dashboard');
  csrf = csrfOf((await merchant('GET', '/dashboard/stores/new')).text); // session rotates on login

  r = await merchant('POST', '/dashboard/stores', { _csrf: csrf, name: 'Test Shop', slug: 'test-shop', currency: 'MAD', color: '#123456' });
  assert.strictEqual(r.status, 302);
  const storeUrl = r.location;
  r = await merchant('POST', `${storeUrl}/products`, { _csrf: csrf, name: 'Mug', price: '50', stock: '3', active: '1' });
  assert.strictEqual(r.location, `${storeUrl}/products`);

  // Missing CSRF is rejected.
  r = await merchant('POST', `${storeUrl}/products`, { name: 'X', price: '1' });
  assert.strictEqual(r.status, 403);

  const customer = client(base);
  page = await customer('GET', '/s/test-shop');
  assert.match(page.text, /Mug/);
  const productId = page.text.match(/\/s\/test-shop\/p\/(\d+)/)[1];
  const ccsrf = csrfOf((await customer('GET', `/s/test-shop/p/${productId}`)).text);
  await customer('POST', '/s/test-shop/cart', { _csrf: ccsrf, product_id: productId, quantity: '2' });
  page = await customer('GET', '/s/test-shop/cart');
  assert.match(page.text, /100\.00 MAD/);

  r = await customer('POST', '/s/test-shop/checkout', {
    _csrf: ccsrf, customer_name: 'Ali', customer_phone: '0600000000', customer_address: 'Casablanca',
  });
  assert.match(r.location, /\/s\/test-shop\/thanks\/\d+/);

  page = await merchant('GET', storeUrl);
  assert.match(page.text, /Ali/); // recent orders on the overview
  page = await merchant('GET', `${storeUrl}/products`);
  assert.match(page.text, /s-confirmed">1</); // stock 3 - 2 = 1 (low-stock badge)

  // Image upload: a real PNG is accepted, a fake one is rejected.
  // A real 2400x1600 PNG: it must come back resized and converted to WebP.
  const png = await require('sharp')({ create: { width: 2400, height: 1600, channels: 3, background: '#3b82f6' } }).png().toBuffer();
  const upload = async (buf, type) => {
    const fd = new FormData();
    fd.append('files', new Blob([buf], { type }), 'x.png');
    return fetch(`${base}${storeUrl}/uploads`, { method: 'POST', body: fd, headers: { cookie: merchant.cookie(), 'x-csrf-token': csrf } });
  };
  let up = await upload(png, 'image/png');
  assert.strictEqual(up.status, 200);
  const { urls } = await up.json();
  assert.match(urls[0], /^\/uploads\/[a-f0-9]{32}\.webp$/);
  const stored = Buffer.from(await (await fetch(base + urls[0])).arrayBuffer());
  const meta = await require('sharp')(stored).metadata();
  assert.strictEqual(meta.format, 'webp');
  assert.strictEqual(meta.width, 1920);
  assert.ok(stored.length < png.length);
  // A file with a valid PNG header but corrupt data is rejected too.
  up = await upload(Buffer.concat([png.subarray(0, 40), Buffer.alloc(200)]), 'image/png');
  assert.strictEqual(up.status, 400);
  up = await upload(Buffer.from('<script>alert(1)</script>'), 'image/png');
  assert.strictEqual(up.status, 400);

  // Product with options: must choose a size; the variant ends up in the order.
  r = await merchant('POST', `${storeUrl}/products`, {
    _csrf: csrf, name: 'Shirt', price: '80', stock: '5', active: '1',
    images: JSON.stringify([urls[0], 'javascript:alert(1)']), opt1_name: 'Size', opt1_values: 'S, M, L',
  });
  assert.strictEqual(r.location, `${storeUrl}/products`);
  const shop2 = client(base);
  const sp = await shop2('GET', '/s/test-shop');
  const shirtId = sp.text.match(/\/p\/(\d+)" class="pcard-name">Shirt</)[1];
  assert.match(sp.text, /<img src="\/uploads\/[a-f0-9]{32}\.webp"/); // uploaded image shown
  assert.doesNotMatch(sp.text, /javascript:/); // unsafe image URL dropped
  const scsrf = csrfOf((await shop2('GET', `/s/test-shop/p/${shirtId}`)).text);
  r = await shop2('POST', '/s/test-shop/cart', { _csrf: scsrf, product_id: shirtId, quantity: '1' });
  assert.match(r.location, /choose=1/);
  r = await shop2('POST', '/s/test-shop/cart', { _csrf: scsrf, product_id: shirtId, quantity: '1', opt0: 'XXL' });
  assert.match(r.location, /choose=1/);
  await shop2('POST', '/s/test-shop/cart', { _csrf: scsrf, product_id: shirtId, quantity: '2', opt0: 'M' });
  assert.match((await shop2('GET', '/s/test-shop/cart')).text, /class="variant">M</);
  r = await shop2('POST', '/s/test-shop/checkout', { _csrf: scsrf, customer_name: 'Bob', customer_phone: '0677777777', customer_address: 'Rabat, Agdal' });
  const orderId = r.location.match(/thanks\/(\d+)/)[1];
  assert.match((await merchant('GET', `${storeUrl}/orders/${orderId}`)).text, /Shirt \(M\)/);

  // Merchant got an email for the new order.
  assert.ok(sent.some((m) => m.to.includes('m@example.com') && m.subject.includes(`#${orderId}`)));

  // Fake-order protection.
  await merchant('POST', `${storeUrl}/products`, { _csrf: csrf, name: 'Pen', price: '5', stock: '50', active: '1' });
  const penId = (await merchant('GET', '/s/test-shop')).text.match(/\/p\/(\d+)" class="pcard-name">Pen</)[1];
  const bot = client(base);
  const bcsrf = csrfOf((await bot('GET', '/s/test-shop/p/' + penId)).text);
  await bot('POST', '/s/test-shop/cart', { _csrf: bcsrf, product_id: penId, quantity: '1' });
  const order = (extra) => bot('POST', '/s/test-shop/checkout', { _csrf: bcsrf, customer_name: 'Sami', customer_phone: '0655555555', customer_address: 'Fes, Rue 12', ...extra });
  assert.strictEqual((await order({ website: 'spam' })).status, 400); // honeypot
  assert.strictEqual((await order({ _t: String(Date.now()) })).status, 400); // too fast
  assert.match((await order({ customer_phone: '123' })).text, /رقم الهاتف غير صحيح/);
  assert.strictEqual((await order({})).status, 302); // valid order goes through
  await bot('POST', '/s/test-shop/cart', { _csrf: bcsrf, product_id: penId, quantity: '1' });
  r = await order({});
  assert.strictEqual(r.status, 409); // same phone, order still pending
  assert.match(r.text, /لديك طلب قيد المراجعة/);

  // Order page shows WhatsApp confirmation and customer history.
  page = await merchant('GET', `${storeUrl}/orders/${orderId}`);
  assert.match(page.text, /wa\.me\/212677777777\?text=/);
  assert.match(page.text, /أول طلب من هذا الرقم/);
  const notif = JSON.parse((await merchant('GET', '/dashboard/notifications')).text);
  assert.ok(notif.pending >= 1 && notif.latest.id >= Number(orderId));

  // Homepage designer: sections are sanitized (bad links/images/types dropped) and rendered.
  const design = [
    { type: 'banner', title: 'Big Sale', image: 'javascript:alert(1)', link: 'javascript:alert(1)', button: 'Go', height: 'zzz' },
    { type: 'evil', html: '<script>' },
    { type: 'gallery', title: 'Our Photos', items: [{ image: urls[0], caption: '<b>hi</b>' }] },
    { type: 'products', title: 'Picks', source: 'newest', limit: '4' },
    { type: 'text', title: 'Hidden one', hidden: true },
  ];
  r = await merchant('POST', `${storeUrl}/design`, { _csrf: csrf, sections: JSON.stringify(design), font: 'cairo', radius: 'round', header_style: 'centered', color: '#112233' });
  assert.match(r.location, /design\?saved=1/);
  page = await shop2('GET', '/s/test-shop');
  assert.match(page.text, /Big Sale/);
  assert.match(page.text, /Our Photos/);
  assert.match(page.text, /&lt;b&gt;hi&lt;\/b&gt;/); // captions are escaped
  assert.doesNotMatch(page.text, /javascript:|Hidden one|<script>alert/);
  assert.match(page.text, /family=Cairo/);
  assert.match(page.text, /sf-head centered/);

  // Live preview renders unsaved changes without saving them.
  r = await merchant('POST', `${storeUrl}/design/preview`, { _csrf: csrf, sections: JSON.stringify([{ type: 'text', title: 'Draft only' }]), color: '#abcdef', font: 'amiri' });
  assert.match(r.text, /Draft only/);
  assert.match(r.text, /--brand:#abcdef/);
  assert.match(r.text, /data-idx="0"/);
  assert.doesNotMatch((await shop2('GET', '/s/test-shop')).text, /Draft only/);

  // Custom pages: created from a template, shown in the menu, editable, reserved slugs refused.
  r = await merchant('POST', `${storeUrl}/pages`, { _csrf: csrf, template: 'about' });
  const pageUrl = r.location;
  assert.match(pageUrl, /\/pages\/\d+$/);
  r = await merchant('POST', pageUrl, { _csrf: csrf, title: 'About us', slug: 'about-us', in_menu: '1', sections: JSON.stringify([{ type: 'text', title: 'Hello from about', text: 'Story' }]) });
  assert.match(r.location, /saved=1/);
  page = await shop2('GET', '/s/test-shop/page/about-us');
  assert.match(page.text, /Hello from about/);
  assert.match((await shop2('GET', '/s/test-shop')).text, /\/s\/test-shop\/page\/about-us">About us</);
  r = await merchant('POST', pageUrl, { _csrf: csrf, title: 'X', slug: 'products', sections: '[]' });
  assert.match(r.text, /رابط الصفحة غير صالح/);
  assert.strictEqual((await shop2('GET', '/s/test-shop/products')).status, 200);

  // Another merchant cannot see the store.
  const other = client(base);
  const ocsrf = csrfOf((await other('GET', '/signup')).text);
  await other('POST', '/signup', { _csrf: ocsrf, name: 'O', email: 'o@example.com', password: 'password123' , accept_terms: '1' });
  r = await other('GET', storeUrl);
  assert.strictEqual(r.status, 404);
});

test('login lockout and password reset', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const u = client(base);
  let csrf = csrfOf((await u('GET', '/signup')).text);
  await u('POST', '/signup', { _csrf: csrf, name: 'Reset Me', email: 'r@example.com', password: 'oldpassword' , accept_terms: '1' });
  await u('POST', '/logout', { _csrf: csrfOf((await u('GET', '/dashboard')).text) });

  const a = client(base);
  csrf = csrfOf((await a('GET', '/login')).text);
  for (let i = 0; i < 5; i++) assert.strictEqual((await a('POST', '/login', { _csrf: csrf, email: 'r@example.com', password: 'wrong' })).status, 400);
  // Locked now, even with the right password.
  assert.strictEqual((await a('POST', '/login', { _csrf: csrf, email: 'r@example.com', password: 'oldpassword' })).status, 429);

  // Forgot password: same response for unknown emails; email sent for known ones.
  let r = await a('POST', '/forgot', { _csrf: csrf, email: 'nobody@example.com' });
  assert.match(r.text, /إذا كان البريد/);
  const before = sent.length;
  await a('POST', '/forgot', { _csrf: csrf, email: 'r@example.com' });
  assert.strictEqual(sent.length, before + 1);
  const link = sent.at(-1).text.match(/\/reset\/([a-f0-9]{64})/)[1];

  assert.strictEqual((await a('GET', '/reset/' + 'f'.repeat(64))).status, 400);
  r = await a('POST', `/reset/${link}`, { _csrf: csrf, password: 'newpassword', password2: 'different' });
  assert.match(r.text, /غير متطابقتين/);
  r = await a('POST', `/reset/${link}`, { _csrf: csrf, password: 'newpassword', password2: 'newpassword' });
  assert.strictEqual(r.location, '/login?reset=1');
  // Token is single-use; lockout cleared; new password works.
  assert.strictEqual((await a('GET', `/reset/${link}`)).status, 400);
  csrf = csrfOf((await a('GET', '/login')).text);
  r = await a('POST', '/login', { _csrf: csrf, email: 'r@example.com', password: 'newpassword' });
  assert.strictEqual(r.location, '/dashboard');
});

test('admin sees all stores; merchants only their own', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { db } = require('../src/db');
  require('../src/limiter').clear(); // earlier tests used up the signup limit for 127.0.0.1

  const signup = async (name, email) => {
    const c = client(base);
    await c('POST', '/signup', { _csrf: csrfOf((await c('GET', '/signup')).text), name, email, password: 'password123' , accept_terms: '1' });
    c.csrf = csrfOf((await c('GET', '/dashboard/stores/new')).text);
    return c;
  };
  const m1 = await signup('Merchant One', 'm1@example.com');
  const m2 = await signup('Merchant Two', 'm2@example.com');
  await m1('POST', '/dashboard/stores', { _csrf: m1.csrf, name: 'Shop One', slug: 'shop-one' });
  const r2 = await m2('POST', '/dashboard/stores', { _csrf: m2.csrf, name: 'Shop Two', slug: 'shop-two' });
  const shop2Id = r2.location.match(/\d+$/)[0];

  // Merchants: own stores only, no admin panel.
  const d1 = (await m1('GET', '/dashboard')).text;
  assert.match(d1, /Shop One/);
  assert.doesNotMatch(d1, /Shop Two/);
  assert.strictEqual((await m1('GET', '/admin')).status, 404);
  assert.strictEqual((await m1('GET', `/dashboard/stores/${shop2Id}`)).status, 404);

  // Promote an admin (what `npm run make-admin` does).
  const adm = await signup('Boss', 'boss@example.com');
  db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run('boss@example.com');
  const panel = (await adm('GET', '/admin')).text;
  assert.match(panel, /Shop One/);
  assert.match(panel, /Shop Two/);
  assert.match((await adm('GET', '/admin/merchants')).text, /m2@example\.com/);
  // Admin can open any store's dashboard, with a clear banner.
  assert.match((await adm('GET', `/dashboard/stores/${shop2Id}`)).text, /بصفتك مسؤولاً/);

  // Suspending a store hides it from customers but not from its owner.
  const acsrf = csrfOf(panel);
  await adm('POST', `/admin/stores/${shop2Id}/suspend`, { _csrf: acsrf, suspend: '1', reason: 'test' });
  assert.strictEqual((await client(base)('GET', '/s/shop-two')).status, 503);
  assert.strictEqual((await m2('GET', '/s/shop-two')).status, 200);
  await adm('POST', `/admin/stores/${shop2Id}/suspend`, { _csrf: acsrf, suspend: '0' });
  assert.strictEqual((await client(base)('GET', '/s/shop-two')).status, 200);

  // Suspending a merchant signs them out and blocks login.
  const m2id = db.prepare('SELECT id FROM users WHERE email = ?').get('m2@example.com').id;
  await adm('POST', `/admin/merchants/${m2id}/suspend`, { _csrf: acsrf, suspend: '1' });
  assert.strictEqual((await m2('GET', '/dashboard')).location, '/login');
  const again = client(base);
  const lc = csrfOf((await again('GET', '/login')).text);
  assert.strictEqual((await again('POST', '/login', { _csrf: lc, email: 'm2@example.com', password: 'password123' })).status, 403);
  // Admins can't be suspended.
  const admId = db.prepare('SELECT id FROM users WHERE email = ?').get('boss@example.com').id;
  assert.strictEqual((await adm('POST', `/admin/merchants/${admId}/suspend`, { _csrf: acsrf, suspend: '1' })).status, 400);
});

test('custom domains serve the store at the root', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { db } = require('../src/db');
  require('../src/limiter').clear();

  const m = client(base);
  await m('POST', '/signup', { _csrf: csrfOf((await m('GET', '/signup')).text), name: 'Dom', email: 'dom@example.com', password: 'password123' , accept_terms: '1' });
  let csrf = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  const r = await m('POST', '/dashboard/stores', { _csrf: csrf, name: 'Dom Shop', slug: 'dom-shop' });
  const sid = r.location.match(/\d+$/)[0];
  await m('POST', `/dashboard/stores/${sid}/products`, { _csrf: csrf, name: 'Lamp', price: '20', stock: '5', active: '1' });

  // Invalid and platform domains are refused; a real one is saved unverified with a token.
  assert.match((await m('POST', `/dashboard/stores/${sid}/domain`, { _csrf: csrf, domain: 'not a domain' })).text, /النطاق غير صحيح/);
  assert.match((await m('POST', `/dashboard/stores/${sid}/domain`, { _csrf: csrf, domain: 'localhost' })).text, /النطاق غير صحيح|نطاق المنصة/);
  await m('POST', `/dashboard/stores/${sid}/domain`, { _csrf: csrf, domain: 'https://www.Lamps-Shop.com/' });
  const row = db.prepare('SELECT custom_domain, domain_token, domain_verified FROM stores WHERE id = ?').get(sid);
  assert.strictEqual(row.custom_domain, 'lamps-shop.com');
  assert.strictEqual(row.domain_verified, 0);
  assert.match((await m('GET', `/dashboard/stores/${sid}/domain`)).text, new RegExp(`yasser-verify=${row.domain_token}`));

  const onDomain = (path, host = 'lamps-shop.com') => fetch(base + path, { headers: { 'x-forwarded-host': host }, redirect: 'manual' });
  // Not verified yet: the domain doesn't serve the store.
  assert.doesNotMatch(await (await onDomain('/')).text(), /Dom Shop/);
  assert.strictEqual((await onDomain('/_domain-check?domain=lamps-shop.com')).status, 404);

  // Once verified (normally via the DNS TXT check), the store is served at the root with clean links.
  db.prepare('UPDATE stores SET domain_verified = 1 WHERE id = ?').run(sid);
  const home = await (await onDomain('/')).text();
  assert.match(home, /Dom Shop/);
  assert.match(home, /href="\/products"/);
  assert.doesNotMatch(home, /\/s\/dom-shop/);
  assert.match(await (await onDomain('/products', 'www.lamps-shop.com')).text(), /Lamp/);
  assert.strictEqual((await onDomain('/_domain-check?domain=lamps-shop.com')).status, 200);
  // The dashboard and other stores are not reachable through a merchant's domain.
  assert.strictEqual((await onDomain('/dashboard')).status, 404);
  assert.strictEqual((await onDomain('/s/shop-one')).status, 404);
  // The platform URL keeps working.
  assert.match(await (await fetch(base + '/s/dom-shop')).text(), /Dom Shop/);
  // Another store can't claim the same domain.
  const m2 = client(base);
  await m2('POST', '/signup', { _csrf: csrfOf((await m2('GET', '/signup')).text), name: 'Other', email: 'other2@example.com', password: 'password123' , accept_terms: '1' });
  const c2 = csrfOf((await m2('GET', '/dashboard/stores/new')).text);
  const r2 = await m2('POST', '/dashboard/stores', { _csrf: c2, name: 'Other Shop', slug: 'other-shop' });
  const sid2 = r2.location.match(/\d+$/)[0];
  assert.match((await m2('POST', `/dashboard/stores/${sid2}/domain`, { _csrf: c2, domain: 'lamps-shop.com' })).text, /مربوط بمتجر آخر/);
});

test('storefront chat: visitor writes, merchant replies in the inbox', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  require('../src/limiter').clear();

  const m = client(base);
  await m('POST', '/signup', { _csrf: csrfOf((await m('GET', '/signup')).text), name: 'Chat Owner', email: 'chat@example.com', password: 'password123' , accept_terms: '1' });
  const mc = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  const sid = (await m('POST', '/dashboard/stores', { _csrf: mc, name: 'Chat Shop', slug: 'chat-shop' })).location.match(/\d+$/)[0];

  // Visitor opens the store: widget present; writes a message.
  const v = client(base);
  const page = await v('GET', '/s/chat-shop');
  assert.match(page.text, /id="chat-fab"/);
  const vc = csrfOf(page.text);
  const post = (c, url, body, csrf) => fetch(base + url, { method: 'POST', body: new URLSearchParams(body), headers: { cookie: c.cookie(), 'x-csrf-token': csrf } });
  let r = await post(v, '/s/chat-shop/chat', { body: 'هل التوصيل متوفر؟', name: 'Salma', phone: '0611223344' }, vc);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await post(v, '/s/chat-shop/chat', { body: '   ' }, vc)).status, 400);
  // The merchant got one email for the new conversation.
  assert.strictEqual(sent.filter((mail) => mail.to === 'chat@example.com' && /Salma/.test(mail.subject)).length, 1);

  // Merchant sees it (unread badge), opens it, replies.
  let inbox = (await m('GET', `/dashboard/stores/${sid}/inbox`)).text;
  assert.match(inbox, /Salma/);
  assert.match(inbox, /id="chat-unread" >1</);
  const cid = inbox.match(/inbox\/(\d+)\?f=all/)[1];
  const thread = (await m('GET', `/dashboard/stores/${sid}/inbox/${cid}`)).text;
  assert.match(thread, /هل التوصيل متوفر؟/);
  assert.match(thread, /wa\.me\/212611223344/);
  r = await post(m, `/dashboard/stores/${sid}/inbox/${cid}/reply`, { body: 'نعم، لكل المدن <b>' }, csrfOf(thread));
  assert.strictEqual(r.status, 200);

  // Visitor gets the reply (as JSON text, never HTML).
  const got = await (await fetch(base + '/s/chat-shop/chat?after=0', { headers: { cookie: v.cookie() } })).json();
  assert.deepStrictEqual(got.messages.map((x) => x.sender), ['visitor', 'merchant']);
  assert.strictEqual(got.messages[1].body, 'نعم، لكل المدن <b>');
  assert.strictEqual(got.unread, 1);

  // Another visitor can't see this conversation; other merchants can't open it.
  const stranger = await (await fetch(base + '/s/chat-shop/chat')).json();
  assert.strictEqual(stranger.messages.length, 0);
  const o = client(base);
  await o('POST', '/signup', { _csrf: csrfOf((await o('GET', '/signup')).text), name: 'Nosy', email: 'nosy@example.com', password: 'password123' , accept_terms: '1' });
  assert.strictEqual((await o('GET', `/dashboard/stores/${sid}/inbox/${cid}`)).status, 404);

  // Disabling chat hides the widget and refuses messages.
  await m('POST', `/dashboard/stores/${sid}/chat-settings`, { _csrf: csrfOf(thread), chat_greeting: 'hi' });
  assert.doesNotMatch((await v('GET', '/s/chat-shop')).text, /id="chat-fab"/);
  assert.strictEqual((await post(v, '/s/chat-shop/chat', { body: 'hello?' }, vc)).status, 403);
});

test('admin v2: overview, store/merchant pages, reset link, settings, delete', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { db } = require('../src/db');
  require('../src/limiter').clear();

  const signup = async (name, email) => {
    const c = client(base);
    await c('POST', '/signup', { _csrf: csrfOf((await c('GET', '/signup')).text), name, email, password: 'password123' , accept_terms: '1' });
    c.csrf = csrfOf((await c('GET', '/dashboard/stores/new')).text);
    return c;
  };
  const boss = await signup('Owner', 'owner2@example.com');
  db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run('owner2@example.com');
  const shop = await signup('Seller', 'seller@example.com');
  const sid = (await shop('POST', '/dashboard/stores', { _csrf: shop.csrf, name: 'Seller Shop', slug: 'seller-shop' })).location.match(/\d+$/)[0];
  const sellerId = db.prepare('SELECT id FROM users WHERE email = ?').get('seller@example.com').id;

  // Overview, lists and detail pages render; merchants can't reach any of them.
  assert.match((await boss('GET', '/admin')).text, /قمع التفعيل/);
  assert.strictEqual((await boss('GET', '/admin?p=90')).status, 200);
  assert.match((await boss('GET', '/admin/stores?q=seller')).text, /Seller Shop/);
  assert.match((await boss('GET', `/admin/stores/${sid}`)).text, /seller@example\.com/);
  assert.match((await boss('GET', `/admin/merchants/${sellerId}`)).text, /Seller Shop/);
  assert.strictEqual((await boss('GET', '/admin/orders?q=nobody')).status, 200);
  for (const path of ['/admin', '/admin/stores', `/admin/stores/${sid}`, '/admin/orders', '/admin/settings']) {
    assert.strictEqual((await shop('GET', path)).status, 404, path);
  }

  // Reset link generated by the admin lets the merchant set a new password.
  const resetPage = (await boss('POST', `/admin/merchants/${sellerId}/reset-link`, { _csrf: boss.csrf })).text;
  const token = resetPage.match(/\/reset\/([a-f0-9]{64})/)[1];
  const anon = client(base);
  const ac = csrfOf((await anon('GET', `/reset/${token}`)).text);
  assert.strictEqual((await anon('POST', `/reset/${token}`, { _csrf: ac, password: 'brandnew123', password2: 'brandnew123' })).location, '/login?reset=1');

  // Settings: announcement shows to merchants; closing signups blocks new accounts.
  await boss('POST', '/admin/settings', { _csrf: boss.csrf, notice: 'Maintenance tonight', notice_level: 'warning', support_whatsapp: '+212 600-000000' });
  const again = client(base);
  const lc = csrfOf((await again('GET', '/login')).text);
  await again('POST', '/login', { _csrf: lc, email: 'seller@example.com', password: 'brandnew123' });
  const dash = (await again('GET', '/dashboard')).text;
  assert.match(dash, /Maintenance tonight/);
  assert.match(dash, /wa\.me\/212600000000/);
  const closed = client(base);
  const cc = csrfOf((await closed('GET', '/login')).text); // the closed signup page has no form
  assert.match((await closed('GET', '/signup')).text, /التسجيل مغلق حالياً/);
  assert.strictEqual((await closed('POST', '/signup', { _csrf: cc, name: 'Late', email: 'late@example.com', password: 'password123' , accept_terms: '1' })).status, 403);
  assert.ok(!db.prepare('SELECT 1 FROM users WHERE email = ?').get('late@example.com'));
  await boss('POST', '/admin/settings', { _csrf: boss.csrf, signups_open: '1' }); // reopen for other tests

  // Deleting a store needs the exact slug.
  assert.strictEqual((await boss('POST', `/admin/stores/${sid}/delete`, { _csrf: boss.csrf, confirm: 'wrong' })).status, 400);
  assert.ok(db.prepare('SELECT 1 FROM stores WHERE id = ?').get(sid));
  await boss('POST', `/admin/stores/${sid}/delete`, { _csrf: boss.csrf, confirm: 'seller-shop' });
  assert.ok(!db.prepare('SELECT 1 FROM stores WHERE id = ?').get(sid));
  assert.strictEqual((await client(base)('GET', '/s/seller-shop')).status, 404);
});

test('landing page: product hero + direct COD order', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { db } = require('../src/db');
  require('../src/limiter').clear();

  const m = client(base);
  await m('POST', '/signup', { _csrf: csrfOf((await m('GET', '/signup')).text), name: 'Lander', email: 'lander@example.com', password: 'password123' , accept_terms: '1' });
  const c = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  const sid = (await m('POST', '/dashboard/stores', { _csrf: c, name: 'Gadget', slug: 'gadget' })).location.match(/\d+$/)[0];
  await m('POST', `/dashboard/stores/${sid}/settings`, { _csrf: c, name: 'Gadget', slug: 'gadget', shipping_fee: '25', free_shipping_over: '300' });
  await m('POST', `/dashboard/stores/${sid}/products`, { _csrf: c, name: 'Smart Bottle', price: '199', compare_price: '299', stock: '10', active: '1', opt1_name: 'Color', opt1_values: 'Black, White' });
  const pid = db.prepare("SELECT id FROM products WHERE name = 'Smart Bottle'").get().id;

  // Create a landing page from the template; it picks the product automatically.
  const pageUrl = (await m('POST', `/dashboard/stores/${sid}/pages`, { _csrf: c, template: 'landing' })).location;
  const sections = JSON.parse(db.prepare('SELECT sections FROM pages WHERE id = ?').get(pageUrl.match(/\d+$/)[0]).sections);
  sections.find((x) => x.type === 'countdown').ends_at = '2020-01-01T00:00'; // past: must be hidden
  await m('POST', pageUrl, { _csrf: c, title: 'Bottle offer', slug: 'bottle', in_menu: '1', sections: JSON.stringify(sections) });
  const v = client(base);
  const page = await v('GET', '/s/gadget/page/bottle');
  assert.match(page.text, /Smart Bottle/);
  assert.match(page.text, /action="\/s\/gadget\/quick-order"/);
  assert.match(page.text, /class="ph-sticky"/);
  assert.doesNotMatch(page.text, /class="cd-box"/);
  const vc = csrfOf(page.text);

  const order = (extra) => fetch(base + '/s/gadget/quick-order', {
    method: 'POST', headers: { cookie: v.cookie(), accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: vc, product_id: String(pid), quantity: '2', customer_name: 'Nora', customer_phone: '0644556677', customer_address: 'Agadir, Talborjt', ...extra }),
  });
  let r = await order({});
  assert.strictEqual(r.status, 400); // color not chosen
  assert.match((await r.json()).error, /Color/);
  r = await order({ opt0: 'Black', website: 'bot' });
  assert.strictEqual(r.status, 400); // honeypot
  r = await order({ opt0: 'Black' });
  assert.strictEqual(r.status, 200);
  const { redirect } = await r.json();
  assert.match(redirect, /^\/s\/gadget\/thanks\/\d+$/);
  const oid = redirect.match(/\d+$/)[0];
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(oid);
  assert.strictEqual(o.total, 398); // 2 × 199, free shipping over 300
  assert.strictEqual(o.shipping, 0);
  assert.strictEqual(db.prepare('SELECT name FROM order_items WHERE order_id = ?').get(oid).name, 'Smart Bottle (Black)');
  assert.strictEqual(db.prepare('SELECT stock FROM products WHERE id = ?').get(pid).stock, 8);
  // Same phone again while pending: refused (fake-order protection is shared with checkout).
  r = await order({ opt0: 'White' });
  assert.strictEqual(r.status, 409);
  // Without JavaScript: redirected back to the page with the error.
  const noJs = await fetch(base + '/s/gadget/quick-order', { method: 'POST', redirect: 'manual', headers: { cookie: v.cookie(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: vc, product_id: String(pid), back: '/s/gadget/page/bottle', customer_name: 'X', customer_phone: '1', customer_address: '' }) });
  assert.match(noJs.headers.get('location'), /^\/s\/gadget\/page\/bottle\?order_error=/);
});

test('AI ads: one button builds the ad + landing page, with limits', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { db, setSetting } = require('../src/db');
  const aiAds = require('../src/ai-ads');
  require('../src/limiter').clear();
  // An earlier test saved the admin settings form without these fields; start from known values.
  setSetting('ai_enabled', '1'); setSetting('ai_cap_usd_month', '20'); setSetting('ai_per_store_month', '10');

  const m = client(base);
  await m('POST', '/signup', { _csrf: csrfOf((await m('GET', '/signup')).text), name: 'Adder', email: 'adder@example.com', password: 'password123' , accept_terms: '1' });
  const c = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  const sid = (await m('POST', '/dashboard/stores', { _csrf: c, name: 'Ad Shop', slug: 'ad-shop' })).location.match(/\d+$/)[0];
  await m('POST', `/dashboard/stores/${sid}/products`, { _csrf: c, name: 'Desk Lamp', price: '120', stock: '9', active: '1' });
  await m('POST', `/dashboard/stores/${sid}/products`, { _csrf: c, name: 'Hidden Thing', price: '10', stock: '9' }); // not active
  const lamp = db.prepare("SELECT id FROM products WHERE name = 'Desk Lamp'").get().id;
  const hidden = db.prepare("SELECT id FROM products WHERE name = 'Hidden Thing'").get().id;

  // Demo mode (no API key): works, clearly labelled, builds a hidden landing page that takes orders.
  assert.strictEqual(aiAds.isConfigured(), false);
  let r = await m('POST', `/dashboard/stores/${sid}/products/${lamp}/ad`, { _csrf: c });
  assert.match(r.location, new RegExp(`/dashboard/stores/${sid}/ads/\\d+$`));
  let page = await m('GET', r.location);
  assert.match(page.text, /🧪/); // demo banner
  assert.match(page.text, /نسخ الإعلان/);
  assert.match(page.text, new RegExp(`/s/ad-shop/page/offer-${lamp}\\?utm_source=facebook`));
  const landing = db.prepare('SELECT * FROM pages WHERE store_id = ? AND slug = ?').get(sid, `offer-${lamp}`);
  assert.ok(landing && landing.in_menu === 0);
  assert.match((await client(base)('GET', `/s/ad-shop/page/offer-${lamp}`)).text, /action="\/s\/ad-shop\/quick-order"/);
  // Hidden products can't be advertised; other merchants can't see the ad.
  assert.strictEqual((await m('POST', `/dashboard/stores/${sid}/products/${hidden}/ad`, { _csrf: c })).status, 400);
  const o = client(base);
  await o('POST', '/signup', { _csrf: csrfOf((await o('GET', '/signup')).text), name: 'Spy', email: 'spy@example.com', password: 'password123' , accept_terms: '1' });
  assert.strictEqual((await o('GET', r.location)).status, 404);

  // "Configured" mode with a stubbed Claude: usage is recorded and the per-store limit applies.
  const real = { gen: aiAds.generateAd, conf: aiAds.isConfigured };
  t.after(() => { aiAds.generateAd = real.gen; aiAds.isConfigured = real.conf; setSetting('ai_per_store_month', '10'); setSetting('ai_cap_usd_month', '20'); });
  aiAds.isConfigured = () => true;
  aiAds.generateAd = async (args) => {
    const demo = await real.gen(args); // same shape as a real answer
    return { ad: { ...demo.ad, headline: 'Claude headline' }, usage: { input: 3000, output: 1500, cost: 0.042 }, demo: false };
  };
  // The monthly AI limit comes from the store's plan (a new store is on the trial = middle plan).
  const billingLib = require('../src/billing');
  setSetting('plans', JSON.stringify(billingLib.DEFAULT_PLANS.map((p) => (p.key === 'pro' ? { ...p, ai: 2 } : p))));
  t.after(() => setSetting('plans', ''));
  for (let i = 0; i < 2; i++) {
    require('../src/limiter').clear();
    r = await m('POST', `/dashboard/stores/${sid}/products/${lamp}/ad`, { _csrf: c });
    assert.match(r.location, /\/ads\/\d+$/);
  }
  page = await m('GET', r.location);
  assert.doesNotMatch(page.text, /🧪/); // no demo banner
  assert.match(page.text, /Claude headline/);
  require('../src/limiter').clear();
  r = await m('POST', `/dashboard/stores/${sid}/products/${lamp}/ad`, { _csrf: c });
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /الحد المسموح/);
  const used = db.prepare("SELECT COUNT(*) AS n, SUM(cost_usd) AS c FROM ai_usage WHERE store_id = ? AND kind = 'ad'").get(sid);
  assert.strictEqual(used.n, 2);
  assert.ok(Math.abs(used.c - 0.084) < 1e-9);
  // Platform-wide monthly cap.
  setSetting('plans', JSON.stringify(billingLib.DEFAULT_PLANS.map((p) => (p.key === 'pro' ? { ...p, ai: 100 } : p))));
  setSetting('ai_cap_usd_month', '0.05');
  require('../src/limiter').clear();
  r = await m('POST', `/dashboard/stores/${sid}/products/${lamp}/ad`, { _csrf: c });
  assert.match(r.text, /حدّها الشهري/);
  // The landing page was refreshed in place, not duplicated.
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM pages WHERE store_id = ? AND slug LIKE ?').get(sid, 'offer-%').n, 1);
});

test('hardening: lazy sessions, headers, upload cleanup, backup', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { db } = require('../src/db');
  const fsp = require('fs');
  const pth = require('path');
  require('../src/limiter').clear();

  // Anonymous page views don't create session rows; filling a cart does.
  const before = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  for (let i = 0; i < 5; i++) await fetch(base + '/s/test-shop');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, before);
  const v = client(base);
  const page = await v('GET', '/s/gadget/products');
  const pen = db.prepare("SELECT id FROM products WHERE name = 'Pen'").get();
  const store = db.prepare('SELECT slug FROM stores WHERE id = (SELECT store_id FROM products WHERE id = ?)').get(pen.id);
  const vc = csrfOf((await v('GET', `/s/${store.slug}/p/${pen.id}`)).text);
  await v('POST', `/s/${store.slug}/cart`, { _csrf: vc, product_id: String(pen.id), quantity: '1' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, before + 1);
  assert.match((await v('GET', `/s/${store.slug}/cart`)).text, /Pen/); // cart survives on the same cookie

  // Security headers.
  const h = (await fetch(base + '/')).headers;
  assert.match(h.get('content-security-policy'), /object-src 'none'/);
  assert.strictEqual(h.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(h.get('x-powered-by'), null);

  // Unused uploads older than a day are removed; referenced and recent ones stay.
  const { cleanupUploads, referencedUploads } = require('../src/maintenance');
  const { uploadsDir } = require('../src/uploads');
  const mk = (name, ageH) => { const f = pth.join(uploadsDir, name); fsp.writeFileSync(f, 'x'); const t0 = (Date.now() - ageH * 3600e3) / 1000; fsp.utimesSync(f, t0, t0); return f; };
  const orphanOld = mk('a'.repeat(32) + '.webp', 48);
  const orphanNew = mk('b'.repeat(32) + '.webp', 1);
  const used = [...referencedUploads()][0];
  assert.ok(used, 'some upload is referenced by earlier tests');
  fsp.utimesSync(pth.join(uploadsDir, used), Date.now() / 1000 - 3 * 86400, Date.now() / 1000 - 3 * 86400);
  const r = cleanupUploads();
  assert.ok(r.removed >= 1);
  assert.ok(!fsp.existsSync(orphanOld));
  assert.ok(fsp.existsSync(orphanNew));
  assert.ok(fsp.existsSync(pth.join(uploadsDir, used)));

  // Backup produces a readable copy of the database.
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', pth.join(__dirname, '..', 'scripts', 'backup.js')], { env: { ...process.env } }).toString();
  const file = out.match(/Backup written: (\S+\.db)/)[1];
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(file);
  assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM stores').get().n > 0);
  copy.close();
});

test('notifications: bell, phone push, preferences, admin alerts', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { db } = require('../src/db');
  const notify = require('../src/notify');
  require('../src/limiter').clear();
  // Capture pushes instead of contacting real push services.
  const pushes = [];
  const realTransport = notify.transport.send;
  t.after(() => { notify.transport.send = realTransport; });
  notify.transport.send = async (sub, payload) => {
    if (sub.endpoint.includes('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    pushes.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
  };

  // An admin, to receive platform alerts.
  const boss = client(base);
  await boss('POST', '/signup', { _csrf: csrfOf((await boss('GET', '/signup')).text), name: 'Boss3', email: 'boss3@example.com', password: 'password123' , accept_terms: '1' });
  db.prepare("UPDATE users SET role = 'admin' WHERE email = 'boss3@example.com'").run();
  const bc = csrfOf((await boss('GET', '/dashboard/stores/new')).text);
  const bpost = (url, body) => fetch(base + url, { method: 'POST', body: new URLSearchParams(body), headers: { cookie: boss.cookie(), 'x-csrf-token': bc, accept: 'application/json' } });
  await bpost('/dashboard/push/subscribe', { endpoint: 'https://push.example/boss', p256dh: 'k', auth: 'a' });

  // A merchant signs up -> the admin gets a bell entry and a push.
  const m = client(base);
  await m('POST', '/signup', { _csrf: csrfOf((await m('GET', '/signup')).text), name: 'Notif Shop Owner', email: 'notif@example.com', password: 'password123' , accept_terms: '1' });
  assert.ok(pushes.some((p) => p.endpoint.endsWith('/boss') && /تاجر جديد/.test(p.title)));
  const bossNotes = await (await fetch(base + '/dashboard/notes', { headers: { cookie: boss.cookie() } })).json();
  assert.ok(bossNotes.unread >= 1);

  // The merchant enables push on two devices (one of them will be gone).
  const c = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  const mpost = (url, body) => fetch(base + url, { method: 'POST', body: new URLSearchParams(body || {}), headers: { cookie: m.cookie(), 'x-csrf-token': c, accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0' } });
  await mpost('/dashboard/push/subscribe', { endpoint: 'https://push.example/phone', p256dh: 'k', auth: 'a' });
  await mpost('/dashboard/push/subscribe', { endpoint: 'https://push.example/gone', p256dh: 'k', auth: 'a' });
  assert.strictEqual((await mpost('/dashboard/push/subscribe', { endpoint: 'javascript:x', p256dh: 'k', auth: 'a' })).status, 400);
  assert.strictEqual((await (await mpost('/dashboard/push/test')).json()).sent, 2);
  assert.ok(!db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = 'https://push.example/gone'").get(), 'dead device removed');
  assert.match((await m('GET', '/dashboard/settings/notifications')).text, /Android · Chrome/);

  const sid = (await m('POST', '/dashboard/stores', { _csrf: c, name: 'Notif Shop', slug: 'notif-shop' })).location.match(/\d+$/)[0];
  assert.ok(pushes.some((p) => /متجر جديد: Notif Shop/.test(p.title)), 'admin told about the new store');
  await m('POST', `/dashboard/stores/${sid}/products`, { _csrf: c, name: 'Candle', price: '40', stock: '4', active: '1' });
  const candle = db.prepare("SELECT id FROM products WHERE name = 'Candle'").get().id;

  // A customer orders 2 -> order push (with a link to the order) + low-stock push (4 -> 2).
  pushes.length = 0;
  const v = client(base);
  const vc = csrfOf((await v('GET', `/s/notif-shop/p/${candle}`)).text);
  await v('POST', '/s/notif-shop/cart', { _csrf: vc, product_id: String(candle), quantity: '2' });
  const done = await v('POST', '/s/notif-shop/checkout', { _csrf: vc, customer_name: 'Hind', customer_phone: '0612121212', customer_address: 'Tetouan, Center' });
  const oid = done.location.match(/\d+$/)[0];
  const orderPush = pushes.find((p) => p.endpoint.endsWith('/phone') && /طلب جديد/.test(p.title));
  assert.ok(orderPush);
  assert.strictEqual(orderPush.url, `/dashboard/stores/${sid}/orders/${oid}`);
  assert.ok(pushes.some((p) => /بقي 2 فقط/.test(p.title)), 'low stock alert');

  // Chat: several messages collapse into one bell entry; only the first sends an email.
  const chatPost = (body) => fetch(base + '/s/notif-shop/chat', { method: 'POST', body: new URLSearchParams({ body, name: 'Hind' }), headers: { cookie: v.cookie(), 'x-csrf-token': vc } });
  const mailsBefore = sent.length;
  await chatPost('Bonjour'); await chatPost('Still there?');
  const uid = db.prepare("SELECT id FROM users WHERE email = 'notif@example.com'").get().id;
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'chat'").get(uid).n, 1);
  assert.strictEqual(sent.slice(mailsBefore).filter((x) => /رسالة جديدة/.test(x.subject)).length, 1);

  // Bell: unread count, list, mark all read.
  let notes = await (await fetch(base + '/dashboard/notes', { headers: { cookie: m.cookie() } })).json();
  assert.ok(notes.unread >= 3);
  assert.ok(notes.notes.some((n) => /Still there\?/.test(n.body)));
  assert.match((await m('GET', '/dashboard')).text, /class="bell-count" >\d+</);
  notes = await (await mpost('/dashboard/notes/read')).json();
  assert.strictEqual(notes.unread, 0);

  // Preferences: turning off phone alerts for orders stops order pushes.
  await m('POST', '/dashboard/settings/notifications', { _csrf: c, chat_push: '1', stock_push: '1', order_email: '1' });
  pushes.length = 0;
  require('../src/limiter').clear();
  const v2 = client(base);
  const vc2 = csrfOf((await v2('GET', `/s/notif-shop/p/${candle}`)).text);
  await v2('POST', '/s/notif-shop/cart', { _csrf: vc2, product_id: String(candle), quantity: '1' });
  await v2('POST', '/s/notif-shop/checkout', { _csrf: vc2, customer_name: 'Omar', customer_phone: '0613131313', customer_address: 'Oujda, Center' });
  assert.ok(!pushes.some((p) => /طلب جديد/.test(p.title)), 'no order push when turned off');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'order'").get(uid).n >= 2, 'still in the bell');

  // Order page offers a WhatsApp status message once the order moves on.
  await m('POST', `/dashboard/stores/${sid}/orders/${oid}/status`, { _csrf: c, status: 'shipped' });
  assert.match((await m('GET', `/dashboard/stores/${sid}/orders/${oid}`)).text, /في الطريق إليك/);

  // PWA bits are served.
  assert.strictEqual((await fetch(base + '/sw.js')).status, 200);
  assert.strictEqual((await (await fetch(base + '/manifest.webmanifest')).json()).start_url, '/dashboard');
  assert.strictEqual((await fetch(base + '/icon-192.png')).headers.get('content-type'), 'image/png');
});

test('ad pixels: only for customers, only valid IDs, CSP widened only when used', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { db } = require('../src/db');
  require('../src/limiter').clear();
  const m = client(base);
  await m('POST', '/signup', { _csrf: csrfOf((await m('GET', '/signup')).text), name: 'Pix', email: 'pix@example.com', password: 'password123' , accept_terms: '1' });
  const c = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  const sid = (await m('POST', '/dashboard/stores', { _csrf: c, name: 'Pix Shop', slug: 'pix-shop' })).location.match(/\d+$/)[0];
  // Without pixels: plain CSP, no tracking code.
  let r = await fetch(base + '/s/pix-shop');
  assert.doesNotMatch(r.headers.get('content-security-policy'), /facebook/);
  assert.doesNotMatch(await r.text(), /fbevents\.js/);
  // Invalid IDs are dropped; valid ones saved (TikTok upper-cased).
  await m('POST', `/dashboard/stores/${sid}/settings`, { _csrf: c, name: 'Pix Shop', slug: 'pix-shop', fb_pixel_id: '12ab<script>', tiktok_pixel_id: 'x' });
  assert.deepStrictEqual({ ...db.prepare('SELECT fb_pixel_id, tiktok_pixel_id FROM stores WHERE id = ?').get(sid) }, { fb_pixel_id: '', tiktok_pixel_id: '' });
  await m('POST', `/dashboard/stores/${sid}/settings`, { _csrf: c, name: 'Pix Shop', slug: 'pix-shop', fb_pixel_id: '987654321098765', tiktok_pixel_id: 'c4abcdef123456789xyz' });
  assert.strictEqual(db.prepare('SELECT tiktok_pixel_id FROM stores WHERE id = ?').get(sid).tiktok_pixel_id, 'C4ABCDEF123456789XYZ');
  // Customers get the pixels (and the wider CSP); the owner browsing the store doesn't.
  r = await fetch(base + '/s/pix-shop');
  const html = await r.text();
  assert.match(r.headers.get('content-security-policy'), /connect\.facebook\.net/);
  assert.match(html, /fbq\('init', "987654321098765"\)/);
  assert.match(html, /ttq\.load\("C4ABCDEF123456789XYZ"\)/);
  assert.doesNotMatch((await m('GET', '/s/pix-shop')).text, /fbevents\.js/);
  // Not in the design editor preview either.
  assert.doesNotMatch((await m('POST', `/dashboard/stores/${sid}/design/preview`, { _csrf: c, sections: '[]' })).text, /fbevents\.js/);
});

test('legal pages and signup consent', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  require('../src/limiter').clear();
  const terms = await (await fetch(base + '/terms')).text();
  assert.match(terms, /شروط الاستخدام/);
  assert.match(terms, /للقانون المغربي/);
  const privacy = await (await fetch(base + '/privacy')).text();
  assert.match(privacy, /id="data-deletion"/); // Meta asks for data-deletion instructions
  assert.match(privacy, /09-08/);
  const u = client(base);
  const c = csrfOf((await u('GET', '/signup')).text);
  const r = await u('POST', '/signup', { _csrf: c, name: 'NoConsent', email: 'noconsent@example.com', password: 'password123' });
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /الموافقة على شروط الاستخدام/);
  assert.match((await fetch(base + '/')).ok ? await (await fetch(base + '/')).text() : '', /href="\/privacy"/);
});

test('payments: merchant picks methods, bank transfer, Stripe, CMI, expiry', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  require('../src/limiter').clear();
  const { db } = require('../src/db');
  const payments = require('../src/payments');
  const notes = (uid) => db.prepare("SELECT title FROM notifications WHERE user_id = ? AND kind = 'order' ORDER BY id DESC").all(uid).map((n) => n.title);

  const m = client(base);
  let c = csrfOf((await m('GET', '/signup')).text);
  await m('POST', '/signup', { _csrf: c, name: 'Payer', email: 'payer@example.com', password: 'password123', accept_terms: '1' });
  c = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  let r = await m('POST', '/dashboard/stores', { _csrf: c, name: 'Pay Shop', slug: 'pay-shop', currency: 'MAD', color: '#123456' });
  const storeUrl = r.location;
  const sid = Number(storeUrl.split('/').pop());
  const uid = db.prepare('SELECT owner_id FROM stores WHERE id = ?').get(sid).owner_id;
  await m('POST', `${storeUrl}/products`, { _csrf: c, name: 'Lamp', price: '200', stock: '10', active: '1' });
  const pid = db.prepare('SELECT id FROM products WHERE store_id = ?').get(sid).id;
  const stock = () => db.prepare('SELECT stock FROM products WHERE id = ?').get(pid).stock;

  // Default: cash on delivery only.
  let page = await (await fetch(`${base}/s/pay-shop/checkout`)).text();
  assert.match((await m('GET', `${storeUrl}/payments`)).text, /طرق الدفع/);

  // Validation: a bad RIB and a bad Stripe key are refused, nothing saved.
  const form = {
    _csrf: c, cod_enabled: '1', bank_enabled: '1', bank_bank_name: 'CIH', bank_holder: 'Payer SARL', bank_rib: '123',
    stripe_enabled: '1', stripe_secret_key: 'nope', cmi_enabled: '1', cmi_client_id: '600001234', cmi_store_key: 'TEST|key\\1', cmi_mode: 'test',
  };
  r = await m('POST', `${storeUrl}/payments`, form);
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /24 رقماً/);
  assert.match(r.text, /sk_live_/);
  assert.doesNotMatch(r.text, /TEST\|key/); // secrets never echoed
  r = await m('POST', `${storeUrl}/payments`, { ...form, bank_rib: '230 780 1234567890123456 78', stripe_secret_key: 'sk_test_abcdefghijklmnop' });
  assert.strictEqual(r.status, 302);
  const row = db.prepare('SELECT payment_config, payment_secrets FROM stores WHERE id = ?').get(sid);
  assert.doesNotMatch(row.payment_secrets, /sk_test|TEST/); // encrypted at rest
  page = (await m('GET', `${storeUrl}/payments`)).text;
  assert.match(page, /محفوظ ومشفّر/);
  assert.doesNotMatch(page, /sk_test_abcdefghijklmnop/);
  // Saving again with blank secret fields keeps them.
  await m('POST', `${storeUrl}/payments`, { ...form, bank_rib: '230780123456789012345678', stripe_secret_key: '', cmi_store_key: '' });
  const store = () => db.prepare('SELECT * FROM stores WHERE id = ?').get(sid);
  assert.strictEqual(payments.credentials(store(), 'stripe').secret_key, 'sk_test_abcdefghijklmnop');
  assert.deepStrictEqual(payments.available(store()), ['cod', 'bank', 'cmi', 'stripe']);

  // The customer sees every method.
  const cu = client(base);
  page = (await cu('GET', `/s/pay-shop/p/${pid}`)).text;
  const cc = csrfOf(page);
  await cu('POST', '/s/pay-shop/cart', { _csrf: cc, product_id: pid, quantity: '1' });
  page = (await cu('GET', '/s/pay-shop/checkout')).text;
  for (const v of ['cod', 'bank', 'cmi', 'stripe']) assert.match(page, new RegExp(`name="payment_method" value="${v}"`));
  const buyer = { _csrf: cc, customer_name: 'Sara', customer_address: 'Rabat, Agdal 12' };

  // 1) Bank transfer: thanks page shows the RIB; the merchant confirms receipt.
  r = await cu('POST', '/s/pay-shop/checkout', { ...buyer, customer_phone: '0611111111', payment_method: 'bank' });
  const bankId = Number(r.location.match(/thanks\/(\d+)/)[1]);
  page = (await cu('GET', r.location)).text;
  assert.match(page, /230 780 1234567890123456 78/); // RIB shown in its usual groups
  assert.match(page, /Payer SARL/);
  assert.strictEqual(db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(bankId).payment_status, 'awaiting');
  assert.match(notes(uid)[0], new RegExp(`#${bankId}`)); // notified right away
  page = (await m('GET', `${storeUrl}/orders/${bankId}`)).text;
  assert.match(page, /وصلني المبلغ/);
  await m('POST', `${storeUrl}/orders/${bankId}/paid`, { _csrf: c });
  assert.strictEqual(db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(bankId).payment_status, 'paid');

  // 2) Stripe: pay page sends the customer to Stripe; paid only after the server checks the session.
  const calls = [];
  let sessionPaid = false;
  payments.http.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const body = opts.body ? new URLSearchParams(String(opts.body)) : null;
    if (opts.method === 'POST') {
      assert.strictEqual(opts.headers.Authorization, 'Bearer sk_test_abcdefghijklmnop');
      return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', amount: body.get('line_items[0][price_data][unit_amount]') }));
    }
    return new Response(JSON.stringify({ id: 'cs_test_1', payment_status: sessionPaid ? 'paid' : 'unpaid', client_reference_id: String(stripeId), amount_total: 20000, currency: 'mad', payment_intent: 'pi_1' }));
  };
  t.after(() => { payments.http.fetch = (...a) => fetch(...a); });
  await cu('POST', '/s/pay-shop/cart', { _csrf: cc, product_id: pid, quantity: '1' });
  r = await cu('POST', '/s/pay-shop/checkout', { ...buyer, customer_phone: '0622222222', payment_method: 'stripe' });
  assert.match(r.location, /\/s\/pay-shop\/pay\/\d+\?t=[a-f0-9]{32}$/);
  var stripeId = Number(r.location.match(/pay\/(\d+)/)[1]);
  const payLink = r.location;
  assert.ok(!notes(uid).some((n) => n.includes(`#${stripeId}`))); // not before payment
  // Without the token: nothing.
  assert.strictEqual((await cu('GET', `/s/pay-shop/pay/${stripeId}`)).location, '/s/pay-shop');
  assert.doesNotMatch((await cu('GET', `/s/pay-shop/thanks/${stripeId}`)).text, /t=[a-f0-9]{32}/); // the thanks page never leaks the link
  r = await cu('GET', payLink);
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.location, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const sent1 = new URLSearchParams(String(calls[0].opts.body));
  assert.strictEqual(sent1.get('line_items[0][price_data][unit_amount]'), '20000');
  assert.strictEqual(sent1.get('line_items[0][price_data][currency]'), 'mad');
  assert.match(sent1.get('success_url'), /\/pay\/\d+\/return\?t=[a-f0-9]{32}&session_id=\{CHECKOUT_SESSION_ID\}$/);
  const tok = payLink.split('t=')[1];
  // A return without payment is not trusted.
  page = (await cu('GET', `/s/pay-shop/pay/${stripeId}/return?t=${tok}&session_id=cs_test_1`)).text;
  assert.match(page, /لم يكتمل الدفع/);
  assert.match(page, /الدفع عند الاستلام بدلاً من ذلك/);
  assert.notStrictEqual(db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(stripeId).payment_status, 'paid');
  sessionPaid = true;
  r = await cu('GET', `/s/pay-shop/pay/${stripeId}/return?t=${tok}&session_id=cs_test_1`);
  assert.strictEqual(r.location, `/s/pay-shop/thanks/${stripeId}`);
  assert.match((await cu('GET', r.location)).text, /تم الدفع بنجاح/);
  assert.strictEqual(db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(stripeId).payment_status, 'paid');
  assert.match(notes(uid)[0], new RegExp(`#${stripeId}.*مدفوع`));

  // 3) CMI: a signed auto-post form; only a correctly signed callback marks it paid.
  await cu('POST', '/s/pay-shop/cart', { _csrf: cc, product_id: pid, quantity: '1' });
  r = await cu('POST', '/s/pay-shop/checkout', { ...buyer, customer_phone: '0633333333', payment_method: 'cmi' });
  assert.match(r.text, /بريدك الإلكتروني/); // email required for card receipts
  r = await cu('POST', '/s/pay-shop/checkout', { ...buyer, customer_phone: '0633333333', payment_method: 'cmi', customer_email: 'sara@example.com' });
  const cmiId = Number(r.location.match(/pay\/(\d+)/)[1]);
  page = (await cu('GET', r.location)).text;
  assert.match(page, /action="https:\/\/testpayment\.cmi\.co\.ma\/fim\/est3Dgate"/);
  const fields = Object.fromEntries([...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((x) => [x[1], x[2].replace(/&#43;/g, '+').replace(/&#x2F;/g, '/').replace(/&#61;/g, '=').replace(/&amp;/g, '&')]));
  assert.strictEqual(fields.amount, '200.00');
  assert.strictEqual(fields.currency, '504');
  assert.strictEqual(fields.hash, payments.cmiHash(fields, 'TEST|key\\1'));
  const reply = { ...fields, ProcReturnCode: '00', Response: 'Approved', TransId: 'T123', mdStatus: '1' };
  delete reply.hash;
  const post = (p, body) => fetch(`${base}/s/pay-shop/pay/${cmiId}/cmi/${p}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  r = await post('callback', { ...reply, HASH: 'forged' });
  assert.strictEqual(await r.text(), 'FAILURE');
  assert.strictEqual(r.headers.get('set-cookie'), null); // no session cookie for CMI's posts
  r = await post('callback', { ...reply, ProcReturnCode: '05', Response: 'Declined', HASH: payments.cmiHash({ ...reply, ProcReturnCode: '05', Response: 'Declined' }, 'TEST|key\\1') });
  assert.strictEqual(await r.text(), 'APPROVED');
  assert.notStrictEqual(db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(cmiId).payment_status, 'paid');
  r = await post('callback', { ...reply, HASH: payments.cmiHash(reply, 'TEST|key\\1') });
  assert.strictEqual(await r.text(), 'ACTION=POSTAUTH');
  assert.strictEqual(db.prepare('SELECT payment_status, payment_note FROM orders WHERE id = ?').get(cmiId).payment_note, 'T123');
  r = await post('ok', { ...reply, HASH: payments.cmiHash(reply, 'TEST|key\\1') });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.headers.get('location'), `/s/pay-shop/thanks/${cmiId}`);

  // 4) An online order never paid gives its stock back after 2 hours.
  sessionPaid = false;
  await cu('POST', '/s/pay-shop/cart', { _csrf: cc, product_id: pid, quantity: '2' });
  const before = stock();
  r = await cu('POST', '/s/pay-shop/checkout', { ...buyer, customer_phone: '0644444444', payment_method: 'stripe' });
  const lateId = Number(r.location.match(/pay\/(\d+)/)[1]);
  assert.strictEqual(stock(), before - 2);
  db.prepare("UPDATE orders SET created_at = datetime('now', '-3 hours') WHERE id = ?").run(lateId);
  assert.strictEqual(app.expireUnpaid(), 1);
  assert.strictEqual(stock(), before);
  assert.deepStrictEqual({ ...db.prepare('SELECT status, payment_status FROM orders WHERE id = ?').get(lateId) }, { status: 'cancelled', payment_status: 'expired' });
});

test('payments: PayPal converts the amount and only trusts a completed capture', async (t) => {
  const payments = require('../src/payments');
  t.after(() => { payments.http.fetch = (...a) => fetch(...a); });
  const store = { id: 1, name: 'Shop', currency: 'MAD',
    payment_config: JSON.stringify({ enabled: ['paypal'], values: { paypal: { client_id: 'cid', mode: 'sandbox', currency: 'EUR', rate: '0.092' } } }),
    payment_secrets: payments.encrypt({ paypal: { secret: 'sec' } }) };
  let created; let captureStatus = 'COMPLETED';
  payments.http.fetch = async (url, opts = {}) => {
    assert.match(url, /^https:\/\/api-m\.sandbox\.paypal\.com\//);
    if (url.endsWith('/v1/oauth2/token')) {
      assert.strictEqual(opts.headers.Authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
      return new Response(JSON.stringify({ access_token: 'AT' }));
    }
    if (url.endsWith('/v2/checkout/orders')) {
      created = JSON.parse(opts.body);
      return new Response(JSON.stringify({ id: 'PP1', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP1' }] }));
    }
    if (url.endsWith('/PP1/capture')) {
      return new Response(JSON.stringify({ id: 'PP1', status: captureStatus, purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: captureStatus, amount: { value: '18.40', currency_code: 'EUR' } }] } }] }), { status: captureStatus === 'COMPLETED' ? 201 : 422 });
    }
    throw new Error('unexpected ' + url);
  };
  const order = { id: 7, total: 200 };
  const step = await payments.PROVIDERS.paypal.start({ store, order, urls: { return: 'https://x/r?t=1', cancel: 'https://x/c?t=1' } });
  assert.strictEqual(created.purchase_units[0].amount.value, '18.40');
  assert.strictEqual(created.purchase_units[0].amount.currency_code, 'EUR');
  assert.strictEqual(step.redirect, 'https://www.sandbox.paypal.com/checkoutnow?token=PP1');
  const saved = { ...order, payment_ref: step.ref, payment_amount: step.amount };
  assert.deepStrictEqual(await payments.PROVIDERS.paypal.verify({ store, order: saved, query: { token: 'OTHER' } }), { paid: false });
  assert.strictEqual((await payments.PROVIDERS.paypal.verify({ store, order: saved, query: { token: 'PP1' } })).paid, true);
  captureStatus = 'PENDING';
  assert.strictEqual((await payments.PROVIDERS.paypal.verify({ store, order: saved, query: { token: 'PP1' } })).paid, false);
});

test('templates: services, clinic and restaurant sections render; no cart without products', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  require('../src/limiter').clear();
  const { db } = require('../src/db');
  const { PRESETS } = require('../src/sections');
  const m = client(base);
  let c = csrfOf((await m('GET', '/signup')).text);
  await m('POST', '/signup', { _csrf: c, name: 'Chef', email: 'chef@example.com', password: 'password123', accept_terms: '1' });
  c = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  const r = await m('POST', '/dashboard/stores', { _csrf: c, name: 'Dar Tajine', slug: 'dar-tajine', currency: 'MAD', color: '#9a3412' });
  const sid = Number(r.location.split('/').pop());
  db.prepare("UPDATE stores SET whatsapp = '212600000000', phone = '0522000000' WHERE id = ?").run(sid);
  const preview = (k) => m('POST', `/dashboard/stores/${sid}/design/preview`, { _csrf: c, sections: JSON.stringify(PRESETS[k].sections) });

  let html = (await preview('restaurant')).text;
  assert.match(html, /طاجين دجاج بالزيتون/);
  assert.match(html, /70 درهم/);
  assert.match(html, /class="menu-tabs"/);
  assert.match(html, /wa\.me\/212600000000\?text=[^"]*%D8%B7%D8%A7%D8%AC%D9%8A%D9%86/); // order a dish on WhatsApp
  assert.match(html, /12:00 – 23:00/);
  html = (await preview('clinic')).text;
  assert.match(html, /الطاقم الطبي/);
  assert.match(html, /class="team-card"/);
  assert.match(html, /tel:0522000000/);
  assert.doesNotMatch(html, /sec-testi/); // no patient testimonials in the clinic template
  html = (await preview('about')).text;
  assert.match(html, /class="stats-row"/);
  assert.match(html, /ابتداءً من 300 درهم/);
  assert.match(html, /id="contact"/);

  // A store with nothing for sale shows no cart or "all products" link.
  db.prepare('UPDATE stores SET home_sections = ? WHERE id = ?').run(JSON.stringify(PRESETS.restaurant.sections), sid);
  html = await (await fetch(`${base}/s/dar-tajine`)).text();
  assert.doesNotMatch(html, /aria-label="السلة"/);
  assert.doesNotMatch(html, /كل المنتجات/);
  assert.match(html, /aria-label="واتساب"/);
});

test('advanced sections: render, styles, contact form reaches the inbox', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  require('../src/limiter').clear();
  const { db } = require('../src/db');
  const sections = require('../src/sections');
  const m = client(base);
  let c = csrfOf((await m('GET', '/signup')).text);
  await m('POST', '/signup', { _csrf: c, name: 'Adv', email: 'adv@example.com', password: 'password123', accept_terms: '1' });
  c = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  const r = await m('POST', '/dashboard/stores', { _csrf: c, name: 'Adv Shop', slug: 'adv-shop', currency: 'MAD', color: '#7c3aed' });
  const sid = Number(r.location.split('/').pop());
  db.prepare("UPDATE stores SET whatsapp = '212611111111', instagram = 'https://instagram.com/adv' WHERE id = ?").run(sid);
  const list = sections.sanitize([
    { type: 'marquee', items: [{ text: 'توصيل مجاني' }], style: 'dark' },
    { type: 'pricing', bg: 'brand', anim: 'zoom', items: [{ name: 'Pro', price: '299', period: '/ شهر', features: 'ميزة 1\nميزة 2', featured: 'yes' }] },
    { type: 'steps', items: [{ title: 'اختر' }, { title: 'اطلب' }] },
    { type: 'promo_grid', items: [{ title: 'رجال', link: '/products' }] },
    { type: 'before_after', before: 'https://example.com/a.jpg', after: 'https://example.com/b.jpg' },
    { type: 'logos', items: [{ name: 'BrandX' }] },
    { type: 'map', address: 'Casablanca' },
    { type: 'social' },
    { type: 'divider', line: 'wave' },
    { type: 'contact_form', title: 'راسلنا', bg: 'evil"><script>' },
  ]);
  assert.strictEqual(list[9].bg, 'none'); // style options are validated like any other field
  assert.strictEqual(list[1].anim, 'zoom');
  const html = (await m('POST', `/dashboard/stores/${sid}/design/preview`, { _csrf: c, sections: JSON.stringify(list) })).text;
  assert.match(html, /class="mq mq-dark/);
  assert.match(html, /class="sec bg-brand rv rv-zoom sec-pricing"/);
  assert.match(html, /الأكثر طلباً/);
  assert.match(html, /wa\.me\/212611111111\?text=/);
  assert.match(html, /class="steps-row"/);
  assert.match(html, /class="ba"/);
  assert.match(html, /BrandX/);
  assert.match(html, /maps\.google\.com\/maps\?q=Casablanca&output=embed/);
  assert.match(html, /soc-instagram/);
  assert.match(html, /dv-wave/);

  // Contact form: lands in the inbox and notifies the merchant.
  db.prepare('UPDATE stores SET home_sections = ? WHERE id = ?').run(JSON.stringify(list), sid);
  const v = client(base);
  const page = (await v('GET', '/s/adv-shop')).text;
  assert.match(fetchCsp = (await fetch(`${base}/s/adv-shop`)).headers.get('content-security-policy'), /frame-src[^;]*maps\.google\.com/);
  const vc = csrfOf(page);
  let res = await v('POST', '/s/adv-shop/contact', { _csrf: vc, back: '/s/adv-shop', name: 'Omar', phone: '12', message: 'Bonjour' });
  assert.match(decodeURIComponent(res.location), /رقم الهاتف غير صحيح/);
  res = await v('POST', '/s/adv-shop/contact', { _csrf: vc, back: '/s/adv-shop', name: 'Omar', phone: '0677777777', message: 'هل عندكم مقاس كبير؟' });
  assert.strictEqual(res.location, '/s/adv-shop?contact=sent#contact-form');
  assert.match((await v('GET', '/s/adv-shop?contact=sent')).text, /وصلت رسالتك/);
  const conv = db.prepare('SELECT * FROM conversations WHERE store_id = ? ORDER BY id DESC').get(sid);
  assert.strictEqual(conv.phone, '0677777777');
  assert.strictEqual(conv.unread_merchant, 1);
  assert.match(db.prepare('SELECT body FROM messages WHERE conversation_id = ?').get(conv.id).body, /مقاس كبير/);
  // Off-site "back" values are ignored.
  res = await v('POST', '/s/adv-shop/contact', { _csrf: vc, back: 'https://evil.example', name: 'Omar', phone: '0677777777', message: 'test message' });
  assert.match(res.location, /^\/s\/adv-shop\?/);
});
var fetchCsp;

test('style options: saved, validated, applied on every storefront page', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  require('../src/limiter').clear();
  const { db } = require('../src/db');
  const m = client(base);
  let c = csrfOf((await m('GET', '/signup')).text);
  await m('POST', '/signup', { _csrf: c, name: 'Sty', email: 'sty@example.com', password: 'password123', accept_terms: '1' });
  c = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  const r = await m('POST', '/dashboard/stores', { _csrf: c, name: 'Style Shop', slug: 'style-shop', currency: 'MAD', color: '#9d174d' });
  const sid = Number(r.location.split('/').pop());
  const page = (await m('GET', `/dashboard/stores/${sid}/design`)).text;
  assert.match(page, /data-kit="luxury"/);
  assert.match(page, /name="t_mode" value="dark"/);
  assert.match(page, /<option value="amiri"/); // heading font list comes from the fonts

  // Preview shows unsaved choices.
  let html = (await m('POST', `/dashboard/stores/${sid}/design/preview`, { _csrf: c, sections: '[]', t_mode: 'dark', t_btn: 'outline', t_card: 'minimal', t_hfont: 'amiri', t_size: 'l' })).text;
  assert.match(html, /class="storefront t-mode-dark t-btn-outline t-card-minimal t-ratio-portrait t-density-m t-head-sticky"/);
  assert.match(html, /--bg:#0e1014/);
  assert.match(html, /--hfont:'Amiri'/);
  assert.match(html, /family=Amiri/);
  assert.match(html, /html\{font-size:17\.5px\}/);

  // Saving: unknown values fall back to defaults; nothing odd reaches the page.
  await m('POST', `/dashboard/stores/${sid}/design`, { _csrf: c, sections: '[]', font: 'cairo', radius: 'round', header_style: 'classic', color: '#9d174d',
    t_mode: 'cream', t_btn: 'x"><script>', t_card: 'shadow', t_ratio: 'square', t_density: 'l', t_head: 'static', t_hfont: 'nope' });
  assert.deepStrictEqual(JSON.parse(db.prepare('SELECT theme FROM stores WHERE id = ?').get(sid).theme),
    { mode: 'cream', hfont: 'same', size: 'm', btn: 'solid', card: 'shadow', ratio: 'square', density: 'l', head: 'static' });
  for (const path of ['/s/style-shop', '/s/style-shop/products', '/s/style-shop/cart']) {
    html = await (await fetch(base + path)).text();
    assert.match(html, /class="storefront t-mode-cream t-btn-solid t-card-shadow t-ratio-square t-density-l t-head-static"/, path);
    assert.match(html, /--bg:#f8f3ea/, path);
  }
  // The dashboard keeps the fixed YASSER look.
  assert.doesNotMatch((await m('GET', '/dashboard')).text, /t-mode-cream|--bg:#f8f3ea/);
});

test('templates: every template renders, and template styles use valid values', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  require('../src/limiter').clear();
  const { PRESETS, GROUPS } = require('../src/sections');
  const themeLib = require('../src/theme');
  const m = client(base);
  let c = csrfOf((await m('GET', '/signup')).text);
  await m('POST', '/signup', { _csrf: c, name: 'Tpl', email: 'tpl@example.com', password: 'password123', accept_terms: '1' });
  c = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  const r = await m('POST', '/dashboard/stores', { _csrf: c, name: 'Tpl Shop', slug: 'tpl-shop', currency: 'MAD', color: '#123456' });
  const sid = Number(r.location.split('/').pop());
  const page = (await m('GET', `/dashboard/stores/${sid}/design`)).text;
  for (const g of Object.values(GROUPS)) assert.ok(page.includes(g), g);
  for (const [k, p] of Object.entries(PRESETS)) {
    assert.ok(GROUPS[p.group], `${k} has a group`);
    assert.ok(page.includes(`data-preset="${k}"`), k);
    if (p.style) {
      assert.deepStrictEqual(themeLib.sanitize(p.style.theme), p.style.theme, `${k} theme values are valid`);
      assert.match(p.style.color, /^#[0-9a-f]{6}$/);
    }
    const form = { _csrf: c, sections: JSON.stringify(p.sections), ...(p.style ? { color: p.style.color, font: p.style.font, radius: p.style.radius } : {}) };
    for (const [kk, v] of Object.entries(p.style?.theme || {})) form['t_' + kk] = v;
    const res = await m('POST', `/dashboard/stores/${sid}/design/preview`, form);
    assert.strictEqual(res.status, 200, k);
    assert.match(res.text, /class="storefront /, k);
  }
});

test('subscriptions: free plan, trial, request, admin activation, limits, fallback to free', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  require('../src/limiter').clear();
  const { db, setSetting } = require('../src/db');
  const billing = require('../src/billing');
  t.after(() => { setSetting('plans', ''); setSetting('trial_days', '14'); });
  const day = 86400000;

  // Admin and merchant.
  const a = client(base);
  let ac = csrfOf((await a('GET', '/signup')).text);
  await a('POST', '/signup', { _csrf: ac, name: 'Boss', email: 'billing-boss@example.com', password: 'password123', accept_terms: '1' });
  db.prepare("UPDATE users SET role = 'admin' WHERE email = 'billing-boss@example.com'").run();
  ac = csrfOf((await a('GET', '/admin/billing')).text);
  const m = client(base);
  let c = csrfOf((await m('GET', '/signup')).text);
  await m('POST', '/signup', { _csrf: c, name: 'Sub', email: 'sub@example.com', password: 'password123', accept_terms: '1' });
  c = csrfOf((await m('GET', '/dashboard/stores/new')).text);
  const newStore = async (slug) => Number((await m('POST', '/dashboard/stores', { _csrf: c, name: slug, slug, currency: 'MAD', color: '#123456' })).location.split('/').pop());
  const sid = await newStore('sub-shop');
  const store = (id = sid) => db.prepare('SELECT * FROM stores WHERE id = ?').get(id);

  // The first plan is free forever, and the default plans don't sell AI ads.
  const pl = billing.plans();
  assert.deepStrictEqual(pl.map((p) => [p.key, p.price, p.free]), [['free', 0, true], ['pro', 199, false], ['business', 399, false]]);
  assert.ok(!pl.some((p) => /الذكاء الاصطناعي/.test(p.features)));

  // A new store gets a 14-day trial of the paid features.
  let s = billing.statusOf(store());
  assert.strictEqual(s.state, 'trial');
  assert.ok(s.daysLeft >= 13 && s.daysLeft <= 14);
  assert.ok(s.limits.templates && s.limits.domain);
  let page = (await m('GET', `/dashboard/stores/${sid}/billing`)).text;
  for (const p of pl) assert.match(page, new RegExp(p.name));
  assert.match(page, /name="plan" value="free"[^>]*disabled/);

  // Without trial days, a new store starts straight on the free plan: basic templates only, no domain.
  setSetting('trial_days', '0');
  const fid = await newStore('free-shop');
  s = billing.statusOf(store(fid));
  assert.strictEqual(s.state, 'free');
  assert.strictEqual(s.limits.templates, false);
  require('../src/db').backfillTrials(); // what every server start runs
  assert.strictEqual(billing.statusOf(store(fid)).state, 'free', 'a restart must not turn a free store into a trial');
  let res;
  // Free plan: professional templates/sections/styles can be tried in the preview, but aren't saved.
  page = (await m('GET', `/dashboard/stores/${fid}/design`)).text;
  assert.match(page, /const PRO_LOCKED = true/);
  const { PRESETS } = require('../src/sections');
  const proForm = { _csrf: c, sections: JSON.stringify(PRESETS.agency.sections), font: 'plex', radius: 'soft', header_style: 'classic', color: '#6d28d9',
    t_mode: 'dark', t_btn: 'gradient', t_card: 'shadow', t_hfont: 'cairo', t_size: 'm', t_ratio: 'landscape', t_density: 'm', t_head: 'sticky' };
  const pv = (await m('POST', `/dashboard/stores/${fid}/design/preview`, proForm)).text;
  assert.match(pv, /sec-pricing/);
  assert.match(pv, /t-mode-dark/);
  res = await m('POST', `/dashboard/stores/${fid}/design`, proForm);
  assert.strictEqual(res.location, `/dashboard/stores/${fid}/design?saved=1&stripped=1`);
  let saved = JSON.parse(store(fid).home_sections);
  assert.ok(saved.length > 0 && !saved.some((x) => ['pricing', 'logos', 'steps', 'contact_form'].includes(x.type)));
  assert.ok(saved.every((x) => !x.bg || x.bg === 'none'));
  assert.deepStrictEqual(JSON.parse(store(fid).theme), require('../src/theme').DEFAULTS);
  assert.strictEqual(store(fid).color, '#6d28d9'); // colour, font and corners stay free
  // Free templates save untouched.
  res = await m('POST', `/dashboard/stores/${fid}/design`, { ...proForm, sections: JSON.stringify(PRESETS.restaurant.sections), t_mode: 'light', t_btn: 'solid', t_card: 'plain', t_hfont: 'same', t_ratio: 'portrait' });
  assert.strictEqual(res.location, `/dashboard/stores/${fid}/design?saved=1`);
  assert.strictEqual(JSON.parse(store(fid).home_sections).length, PRESETS.restaurant.sections.length);
  // Custom pages follow the same rule.
  const pg = Number((await m('POST', `/dashboard/stores/${fid}/pages`, { _csrf: c, title: 'عنا', template: 'blank' })).location.split('/').pop());
  res = await m('POST', `/dashboard/stores/${fid}/pages/${pg}`, { _csrf: c, title: 'عنا', slug: 'about-us', sections: JSON.stringify([{ type: 'text', title: 'مرحبا', text: 'نص' }, { type: 'pricing', items: [{ name: 'A', price: '1' }] }]) });
  assert.match(res.location, /saved=1&stripped=1$/);
  assert.deepStrictEqual(JSON.parse(db.prepare('SELECT sections FROM pages WHERE id = ?').get(pg).sections).map((x) => x.type), ['text']);
  res = await m('POST', `/dashboard/stores/${fid}/domain`, { _csrf: c, domain: 'myfreeshop.com' });
  assert.match(res.text, /الباقة الاحترافية/);
  setSetting('plans', JSON.stringify(billing.DEFAULT_PLANS.map((p) => (p.key === 'free' ? { ...p, products: 1 } : p))));
  await m('POST', `/dashboard/stores/${fid}/products`, { _csrf: c, name: 'One', price: '10', stock: '5', active: '1' });
  res = await m('POST', `/dashboard/stores/${fid}/products`, { _csrf: c, name: 'Two', price: '10', stock: '5', active: '1' });
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /الحد الأقصى لباقتك/);
  // The free plan can't be "bought".
  res = await m('POST', `/dashboard/stores/${fid}/billing/request`, { _csrf: c, plan: 'free', months: '1', method: 'cash' });
  assert.strictEqual(res.status, 400);

  // Merchant asks for the pro plan for 3 months; the admin sees it and is notified.
  res = await m('POST', `/dashboard/stores/${fid}/billing/request`, { _csrf: c, plan: 'pro', months: '3', method: 'bank', note: 'تحويل يوم الإثنين' });
  assert.strictEqual(res.location, `/dashboard/stores/${fid}/billing?sent=1`);
  const reqRow = billing.pendingOf(fid);
  assert.strictEqual(reqRow.amount, 199 * 3);
  assert.match((await m('GET', `/dashboard/stores/${fid}/billing`)).text, new RegExp(`YS-${fid}-${reqRow.id}`));
  page = (await a('GET', '/admin/billing')).text;
  assert.match(page, /free-shop/);
  assert.match(page, /تحويل يوم الإثنين/);
  assert.ok(db.prepare("SELECT 1 FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'billing-boss@example.com' AND n.title LIKE '%طلب اشتراك%'").get());
  assert.notStrictEqual((await m('POST', `/admin/billing/${reqRow.id}/approve`, { _csrf: c })).status, 302); // merchants can't approve

  // Admin approves -> pro for ~3 months, paid features unlocked, merchant notified.
  await a('POST', `/admin/billing/${reqRow.id}/approve`, { _csrf: ac, plan: 'pro', months: '3', amount: '597', reference: 'REC-77' });
  s = billing.statusOf(store(fid));
  assert.strictEqual(s.state, 'active');
  assert.strictEqual(s.plan.key, 'pro');
  assert.ok(s.daysLeft >= 88 && s.daysLeft <= 93, String(s.daysLeft));
  assert.ok(s.limits.templates && s.limits.domain);
  assert.match((await m('GET', `/dashboard/stores/${fid}/design`)).text, /const PRO_LOCKED = false/);
  res = await m('POST', `/dashboard/stores/${fid}/design`, proForm);
  assert.strictEqual(res.location, `/dashboard/stores/${fid}/design?saved=1`); // paid: saved as is
  assert.ok(JSON.parse(store(fid).home_sections).some((x) => x.type === 'pricing'));
  assert.strictEqual(JSON.parse(store(fid).theme).mode, 'dark');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE kind = 'billing' AND title LIKE '%الاحترافية%'").get());

  // Early renewal of the same plan adds to the remaining time; the free plan can't be activated.
  const before = billing.parse(store(fid).plan_until);
  await a('POST', `/admin/stores/${fid}/plan`, { _csrf: ac, plan: 'pro', months: '1', method: 'cash', amount: '' });
  assert.ok(billing.parse(store(fid).plan_until) - before > 27 * day);
  assert.strictEqual((await a('POST', `/admin/stores/${fid}/plan`, { _csrf: ac, plan: 'free', months: '1' })).status, 400);

  // When it ends: grace days keep the paid features, then the store falls back to free. It never closes.
  db.prepare('UPDATE stores SET plan_until = ? WHERE id = ?').run(billing.iso(Date.now() - 1 * day), fid);
  assert.strictEqual(billing.statusOf(store(fid)).state, 'grace');
  assert.match((await m('GET', `/dashboard/stores/${fid}`)).text, /ينتقل إلى الباقة المجانية/);
  db.prepare('UPDATE stores SET plan_until = ? WHERE id = ?').run(billing.iso(Date.now() - 10 * day), fid);
  s = billing.statusOf(store(fid));
  assert.strictEqual(s.state, 'free');
  assert.ok(s.lapsed);
  assert.strictEqual(s.limits.domain, false);
  assert.strictEqual((await fetch(`${base}/s/free-shop`)).status, 200); // still open to customers

  // A year is charged 10 months; a rejected request notifies the merchant.
  await a('POST', `/admin/stores/${fid}/plan`, { _csrf: ac, plan: 'business', months: '12', method: 'bank', amount: '' });
  assert.strictEqual(db.prepare('SELECT amount FROM subscriptions WHERE store_id = ? ORDER BY id DESC').get(fid).amount, 399 * 10);
  await m('POST', `/dashboard/stores/${fid}/billing/request`, { _csrf: c, plan: 'pro', months: '1', method: 'cash' });
  const rej = billing.pendingOf(fid);
  await a('POST', `/admin/billing/${rej.id}/reject`, { _csrf: ac, reason: 'لم يصل المبلغ' });
  assert.strictEqual(db.prepare('SELECT status FROM subscriptions WHERE id = ?').get(rej.id).status, 'rejected');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE kind = 'billing' AND body = 'لم يصل المبلغ'").get());

  // Admin edits the plans: the free plan stays at 0; the landing page follows.
  await a('POST', '/admin/billing/settings', { _csrf: ac, plan0_name: 'Gratuit', plan0_price: '50', plan0_products: '20', plan0_ai: '0', plan0_features: 'a',
    plan1_name: 'Pro', plan1_price: '149', plan1_products: '300', plan1_ai: '10', plan1_domain: '1', plan1_templates: '1', plan1_features: 'b',
    plan2_name: 'Max', plan2_price: '299', plan2_products: '0', plan2_ai: '40', plan2_domain: '1', plan2_templates: '1', plan2_features: 'c', featured: 'business', trial_days: '7', grace_days: '2', billing_info: 'RIB 123' });
  assert.deepStrictEqual(billing.plans().map((p) => [p.name, p.price, p.featured, p.templates]), [['Gratuit', 0, false, false], ['Pro', 149, false, true], ['Max', 299, true, true]]);
  assert.strictEqual(billing.settings().trialDays, 7);
  const home = await (await fetch(base + '/')).text();
  assert.match(home, /Gratuit[\s\S]*للأبد[\s\S]*Pro[\s\S]*149/);
  // AI ads switched off by the admin (the default): no "ads" link or launch button in the dashboard.
  assert.strictEqual(require('../src/db').getSettings.length, 0);
  setSetting('ai_enabled', '0');
  assert.doesNotMatch((await m('GET', `/dashboard/stores/${fid}`)).text, /\/ads" class/);
  assert.doesNotMatch((await m('GET', `/dashboard/stores/${fid}/products`)).text, /class="ai-launch/);
  setSetting('ai_enabled', '1');
  assert.match((await m('GET', `/dashboard/stores/${fid}`)).text, /\/ads" class/);
});
