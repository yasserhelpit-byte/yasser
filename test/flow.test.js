const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yasser-test-'));
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
const csrfOf = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];

test('merchant creates a store, customer orders, stock decreases', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const merchant = client(base);
  let page = await merchant('GET', '/signup');
  let csrf = csrfOf(page.text);
  let r = await merchant('POST', '/signup', { _csrf: csrf, name: 'Yasser', email: 'm@example.com', password: 'password123' });
  assert.strictEqual(r.location, '/dashboard');

  r = await merchant('POST', '/dashboard/stores', { _csrf: csrf, name: 'Test Shop', slug: 'test-shop', currency: 'MAD', color: '#123456' });
  assert.strictEqual(r.status, 302);
  const storeUrl = r.location;
  r = await merchant('POST', `${storeUrl}/products`, { _csrf: csrf, name: 'Mug', price: '50', stock: '3', active: '1' });
  assert.strictEqual(r.location, storeUrl);

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
  assert.match(page.text, /Ali/);
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
  assert.strictEqual(r.location, storeUrl);
  const shop2 = client(base);
  const sp = await shop2('GET', '/s/test-shop');
  const shirtId = sp.text.match(/\/p\/(\d+)" class="name">Shirt</)[1];
  assert.match(sp.text, /<img src="\/uploads\/[a-f0-9]{32}\.png"/); // uploaded image shown
  assert.doesNotMatch(sp.text, /javascript:/); // unsafe image URL dropped
  const scsrf = csrfOf((await shop2('GET', `/s/test-shop/p/${shirtId}`)).text);
  r = await shop2('POST', '/s/test-shop/cart', { _csrf: scsrf, product_id: shirtId, quantity: '1' });
  assert.match(r.location, /choose=1/);
  r = await shop2('POST', '/s/test-shop/cart', { _csrf: scsrf, product_id: shirtId, quantity: '1', opt0: 'XXL' });
  assert.match(r.location, /choose=1/);
  await shop2('POST', '/s/test-shop/cart', { _csrf: scsrf, product_id: shirtId, quantity: '2', opt0: 'M' });
  assert.match((await shop2('GET', '/s/test-shop/cart')).text, /class="variant">M</);
  r = await shop2('POST', '/s/test-shop/checkout', { _csrf: scsrf, customer_name: 'B', customer_phone: '1', customer_address: 'X' });
  const orderId = r.location.match(/thanks\/(\d+)/)[1];
  assert.match((await merchant('GET', `${storeUrl}/orders/${orderId}`)).text, /Shirt \(M\)/);

  // Another merchant cannot see the store.
  const other = client(base);
  const ocsrf = csrfOf((await other('GET', '/signup')).text);
  await other('POST', '/signup', { _csrf: ocsrf, name: 'O', email: 'o@example.com', password: 'password123' });
  r = await other('GET', storeUrl);
  assert.strictEqual(r.status, 404);
});
