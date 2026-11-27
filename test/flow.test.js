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
  let r = await merchant('POST', '/signup', { _csrf: csrf, name: 'Yasser', email: 'm@example.com', password: 'password123' });
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
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const upload = async (buf, type) => {
    const fd = new FormData();
    fd.append('files', new Blob([buf], { type }), 'x.png');
    return fetch(`${base}${storeUrl}/uploads`, { method: 'POST', body: fd, headers: { cookie: merchant.cookie(), 'x-csrf-token': csrf } });
  };
  let up = await upload(png, 'image/png');
  assert.strictEqual(up.status, 200);
  const { urls } = await up.json();
  assert.match(urls[0], /^\/uploads\/[a-f0-9]{32}\.png$/);
  assert.strictEqual((await fetch(base + urls[0])).status, 200);
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
  assert.match(sp.text, /<img src="\/uploads\/[a-f0-9]{32}\.png"/); // uploaded image shown
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
  await other('POST', '/signup', { _csrf: ocsrf, name: 'O', email: 'o@example.com', password: 'password123' });
  r = await other('GET', storeUrl);
  assert.strictEqual(r.status, 404);
});

test('login lockout and password reset', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const u = client(base);
  let csrf = csrfOf((await u('GET', '/signup')).text);
  await u('POST', '/signup', { _csrf: csrf, name: 'Reset Me', email: 'r@example.com', password: 'oldpassword' });
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
    await c('POST', '/signup', { _csrf: csrfOf((await c('GET', '/signup')).text), name, email, password: 'password123' });
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
  await m('POST', '/signup', { _csrf: csrfOf((await m('GET', '/signup')).text), name: 'Dom', email: 'dom@example.com', password: 'password123' });
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
  await m2('POST', '/signup', { _csrf: csrfOf((await m2('GET', '/signup')).text), name: 'Other', email: 'other2@example.com', password: 'password123' });
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
  await m('POST', '/signup', { _csrf: csrfOf((await m('GET', '/signup')).text), name: 'Chat Owner', email: 'chat@example.com', password: 'password123' });
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
  await o('POST', '/signup', { _csrf: csrfOf((await o('GET', '/signup')).text), name: 'Nosy', email: 'nosy@example.com', password: 'password123' });
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
    await c('POST', '/signup', { _csrf: csrfOf((await c('GET', '/signup')).text), name, email, password: 'password123' });
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
  assert.strictEqual((await closed('POST', '/signup', { _csrf: cc, name: 'Late', email: 'late@example.com', password: 'password123' })).status, 403);
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
  await m('POST', '/signup', { _csrf: csrfOf((await m('GET', '/signup')).text), name: 'Lander', email: 'lander@example.com', password: 'password123' });
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
