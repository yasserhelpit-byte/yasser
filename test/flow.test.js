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
  return async function req(method, url, form) {
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
  assert.match(page.text, /<td>1<\/td>/); // stock 3 - 2

  // Another merchant cannot see the store.
  const other = client(base);
  const ocsrf = csrfOf((await other('GET', '/signup')).text);
  await other('POST', '/signup', { _csrf: ocsrf, name: 'O', email: 'o@example.com', password: 'password123' });
  r = await other('GET', storeUrl);
  assert.strictEqual(r.status, 404);
});
