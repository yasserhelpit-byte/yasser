// Payment methods a merchant can offer at checkout.
//
// Offline: cash on delivery. Manual: bank transfer / money-transfer agency (the merchant confirms
// receipt). Online: CMI (Moroccan cards), Stripe and PayPal, each with the merchant's OWN account,
// so money goes straight to the merchant, never through the platform.
//
// A payment is only ever marked paid after the server checks it with the provider (API call or a
// signed callback); return URLs and query strings are never trusted on their own.
const crypto = require('crypto');

const METHODS = {
  cod: {
    label: 'الدفع عند الاستلام', icon: '💵', kind: 'offline', hint: 'ادفع نقداً عند وصول طلبك',
    about: 'العميل يدفع نقداً لعامل التوصيل.',
    fields: [],
  },
  bank: {
    label: 'تحويل بنكي', icon: '🏦', kind: 'manual', hint: 'حوّل المبلغ إلى حسابنا البنكي',
    about: 'يظهر للعميل رقم حسابك بعد الطلب، وتؤكد أنت استلام المبلغ من صفحة الطلب.',
    fields: [
      { k: 'bank_name', label: 'اسم البنك', required: true, placeholder: 'CIH Bank' },
      { k: 'holder', label: 'اسم صاحب الحساب', required: true },
      { k: 'rib', label: 'رقم الحساب RIB (24 رقماً)', required: true, ltr: true, placeholder: '230 780 1234567890123456 78' },
      { k: 'iban', label: 'IBAN / SWIFT (اختياري، للتحويل من الخارج)', ltr: true },
      { k: 'note', label: 'تعليمات إضافية (اختياري)', type: 'textarea', placeholder: 'أرسل صورة وصل التحويل عبر واتساب مع رقم الطلب.' },
    ],
  },
  cash: {
    label: 'تحويل عبر وكالة', icon: '🏪', kind: 'manual', hint: 'Wafacash · Cash Plus · Barid Cash',
    about: 'يرسل العميل المبلغ من وكالة تحويل الأموال باسمك، وتؤكد أنت الاستلام.',
    fields: [
      { k: 'name', label: 'اسم المستفيد (كما في البطاقة الوطنية)', required: true },
      { k: 'phone', label: 'هاتف المستفيد', required: true, ltr: true },
      { k: 'city', label: 'المدينة', required: true },
      { k: 'agencies', label: 'الوكالات المقبولة', placeholder: 'Wafacash، Cash Plus، Barid Cash' },
      { k: 'note', label: 'تعليمات إضافية (اختياري)', type: 'textarea' },
    ],
  },
  cmi: {
    label: 'بطاقة بنكية', icon: '💳', kind: 'online', hint: 'بطاقة مغربية أو دولية عبر CMI',
    about: 'يحتاج عقد «الأداء الإلكتروني» مع بنكك (CMI). بعد التوقيع يعطيك البنك رقم التاجر ومفتاح المتجر.',
    fields: [
      { k: 'client_id', label: 'رقم التاجر (Client ID)', required: true, ltr: true },
      { k: 'store_key', label: 'مفتاح المتجر (Store Key)', required: true, ltr: true, secret: true },
      { k: 'mode', label: 'البيئة', type: 'select', options: { test: 'تجريبية (للاختبار)', live: 'حقيقية' } },
    ],
  },
  stripe: {
    label: 'بطاقة بنكية (Stripe)', icon: '💳', kind: 'online', hint: 'Visa · Mastercard · Apple Pay · Google Pay',
    about: 'يتطلب حساب Stripe مفعّلاً (شركة في بلد يدعمه Stripe). خذ المفتاح السري من Developers ← API keys.',
    fields: [
      { k: 'secret_key', label: 'المفتاح السري (sk_live_… أو rk_live_…)', required: true, ltr: true, secret: true },
    ],
  },
  paypal: {
    label: 'PayPal', icon: '🅿️', kind: 'online', hint: 'بحساب PayPal أو ببطاقة',
    about: 'يتطلب حساب PayPal Business. خذ Client ID و Secret من developer.paypal.com ← Apps & Credentials. PayPal لا يدعم الدرهم، فيُحوَّل المبلغ بسعر الصرف الذي تحدده.',
    fields: [
      { k: 'client_id', label: 'Client ID', required: true, ltr: true },
      { k: 'secret', label: 'Secret', required: true, ltr: true, secret: true },
      { k: 'mode', label: 'البيئة', type: 'select', options: { live: 'حقيقية', sandbox: 'تجريبية (Sandbox)' } },
      { k: 'currency', label: 'عملة الدفع في PayPal', type: 'select', options: { EUR: 'يورو EUR', USD: 'دولار USD' } },
      { k: 'rate', label: 'سعر الصرف: 1 من عملة متجرك = ؟', required: true, ltr: true, type: 'number', placeholder: '0.092' },
    ],
  },
};
const ORDER = ['cod', 'bank', 'cash', 'cmi', 'stripe', 'paypal'];

const PAY_STATUS = {
  unpaid: 'الدفع عند الاستلام',
  awaiting: 'بانتظار التحويل',
  pending: 'بانتظار الدفع',
  paid: 'مدفوع',
  failed: 'فشل الدفع',
  expired: 'لم يكتمل الدفع',
};

// ---- Secrets at rest: AES-256-GCM with a key derived from the server secret ----
let KEY = null;
function init(secret) {
  KEY = crypto.createHash('sha256').update(`yasser-payments:${secret}`).digest();
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}
function decrypt(str) {
  if (!str) return {};
  try {
    const buf = Buffer.from(str, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch {
    return {};
  }
}

// ---- Store configuration ----
function settingsOf(store) {
  let cfg = {};
  try { cfg = JSON.parse(store.payment_config || '{}') || {}; } catch {}
  const enabled = Array.isArray(cfg.enabled) ? cfg.enabled.filter((m) => METHODS[m]) : ['cod'];
  return { enabled, values: cfg.values && typeof cfg.values === 'object' ? cfg.values : {} };
}
const secretsOf = (store) => decrypt(store.payment_secrets);

// Everything a method needs, public and secret, merged.
function credentials(store, method) {
  return { ...(settingsOf(store).values[method] || {}), ...(secretsOf(store)[method] || {}) };
}
const isComplete = (store, method) => METHODS[method].fields.every((f) => !f.required || String(credentials(store, method)[f.k] || '').trim());

// Methods the customer can pick. Never empty: falls back to cash on delivery.
function available(store) {
  const list = ORDER.filter((m) => settingsOf(store).enabled.includes(m) && isComplete(store, m));
  return list.length ? list : ['cod'];
}

// Public details shown to the customer for manual methods (never secrets).
function publicDetails(store, method) {
  const v = settingsOf(store).values[method] || {};
  return METHODS[method].fields.filter((f) => !f.secret && f.type !== 'select').map((f) => ({ ...f, value: String(v[f.k] || '') })).filter((f) => f.value);
}

// Parse the merchant's settings form. Blank secret inputs keep the saved secret.
function parseForm(body, store) {
  const old = settingsOf(store);
  const oldSecrets = secretsOf(store);
  const enabled = ORDER.filter((m) => body[`${m}_enabled`]);
  const values = {};
  const secrets = {};
  const errors = [];
  for (const m of ORDER) {
    values[m] = {};
    for (const f of METHODS[m].fields) {
      let v = String(body[`${m}_${f.k}`] ?? '').trim().slice(0, f.type === 'textarea' ? 600 : 200);
      if (f.type === 'select' && !Object.hasOwn(f.options, v)) v = Object.keys(f.options)[0];
      if (f.secret) {
        if (body[`${m}_${f.k}_clear`]) continue;
        const keep = (oldSecrets[m] || {})[f.k];
        if (v || keep) (secrets[m] ||= {})[f.k] = v || keep;
      } else {
        values[m][f.k] = v;
      }
    }
  }
  // Light validation for enabled methods, so mistakes show up here and not at a customer's checkout.
  const on = (m) => enabled.includes(m);
  const val = (m, k) => (values[m][k] ?? (secrets[m] || {})[k] ?? '');
  for (const m of enabled) {
    const missing = METHODS[m].fields.filter((f) => f.required && !String(val(m, f.k)).trim());
    if (missing.length) errors.push(`${METHODS[m].label}: أكمل ${missing.map((f) => `«${f.label.replace(/ \(.*\)$/, '')}»`).join('، ')}.`);
  }
  if (on('bank') && values.bank.rib && values.bank.rib.replace(/\D/g, '').length !== 24) errors.push('تحويل بنكي: رقم RIB المغربي يتكون من 24 رقماً.');
  if (on('cmi') && store.currency !== 'MAD') errors.push('CMI يقبل الدرهم (MAD) فقط. غيّر عملة المتجر من الإعدادات أو استعمل Stripe/PayPal.');
  if (on('stripe') && val('stripe', 'secret_key') && !/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(val('stripe', 'secret_key'))) errors.push('Stripe: المفتاح السري يبدأ بـ sk_live_ أو sk_test_.');
  if (on('paypal')) {
    const rate = Number(values.paypal.rate);
    if (!(rate > 0 && rate < 1000)) errors.push('PayPal: أدخل سعر صرف صحيحاً (مثال 0.092).');
  }
  if (!enabled.length) errors.push('فعّل طريقة دفع واحدة على الأقل.');
  return {
    errors,
    payment_config: JSON.stringify({ enabled: enabled.length ? enabled : old.enabled, values }),
    payment_secrets: encrypt(secrets),
  };
}

// ---- Providers ----
// Replaceable in tests.
const http = { fetch: (...a) => fetch(...a) };
const cents = (n) => Math.round(Number(n) * 100);

async function readJson(r) {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
}

// Stripe Checkout (hosted page).
const stripe = {
  async start({ store, order, urls }) {
    const c = credentials(store, 'stripe');
    const body = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': store.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(cents(order.total)),
      'line_items[0][price_data][product_data][name]': `${store.name} · #${order.id}`,
      success_url: `${urls.return}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: urls.cancel,
      client_reference_id: String(order.id),
      'metadata[order_id]': String(order.id),
      'metadata[store_id]': String(store.id),
    });
    if (order.customer_email) body.set('customer_email', order.customer_email);
    const r = await http.fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.secret_key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const d = await readJson(r);
    if (!r.ok || !d.url) throw new Error(`Stripe: ${d.error?.message || r.status}`);
    return { ref: d.id, amount: `${cents(order.total)} ${store.currency.toLowerCase()}`, redirect: d.url };
  },
  async verify({ store, order }) {
    if (!order.payment_ref) return { paid: false };
    const c = credentials(store, 'stripe');
    const r = await http.fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(order.payment_ref)}`, {
      headers: { Authorization: `Bearer ${c.secret_key}` },
    });
    const d = await readJson(r);
    if (!r.ok) throw new Error(`Stripe: ${d.error?.message || r.status}`);
    const paid = d.payment_status === 'paid'
      && d.client_reference_id === String(order.id)
      && `${d.amount_total} ${d.currency}` === order.payment_amount;
    return { paid, ref: d.payment_intent || d.id };
  },
};

// PayPal Orders v2 (approve on PayPal, then capture from here).
const paypal = {
  base: (c) => (c.mode === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'),
  async token(c) {
    const r = await http.fetch(`${paypal.base(c)}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${c.client_id}:${c.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const d = await readJson(r);
    if (!r.ok || !d.access_token) throw new Error(`PayPal: ${d.error_description || r.status}`);
    return d.access_token;
  },
  async start({ store, order, urls }) {
    const c = credentials(store, 'paypal');
    const currency = c.currency || 'EUR';
    const value = (Number(order.total) * Number(c.rate)).toFixed(2);
    const r = await http.fetch(`${paypal.base(c)}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await paypal.token(c)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: `order-${order.id}`, custom_id: String(order.id), description: `${store.name} #${order.id}`.slice(0, 127), amount: { currency_code: currency, value } }],
        payment_source: { paypal: { experience_context: { brand_name: store.name.slice(0, 127), user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: urls.return, cancel_url: urls.cancel } } },
      }),
    });
    const d = await readJson(r);
    const link = (d.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
    if (!r.ok || !link) throw new Error(`PayPal: ${d.message || d.details?.[0]?.description || r.status}`);
    return { ref: d.id, amount: `${value} ${currency}`, redirect: link.href };
  },
  async verify({ store, order, query = {} }) {
    if (!order.payment_ref || (query.token && query.token !== order.payment_ref)) return { paid: false };
    const c = credentials(store, 'paypal');
    const auth = { Authorization: `Bearer ${await paypal.token(c)}`, 'Content-Type': 'application/json' };
    const base = `${paypal.base(c)}/v2/checkout/orders/${encodeURIComponent(order.payment_ref)}`;
    let r = await http.fetch(`${base}/capture`, { method: 'POST', headers: { ...auth, 'PayPal-Request-Id': `capture-${order.payment_ref}` }, body: '{}' });
    let d = await readJson(r);
    // Already captured (e.g. the customer reloaded the return page): read the order instead.
    if (!r.ok && JSON.stringify(d).includes('ORDER_ALREADY_CAPTURED')) {
      r = await http.fetch(base, { headers: auth });
      d = await readJson(r);
    }
    if (!r.ok) return { paid: false };
    const cap = d.purchase_units?.[0]?.payments?.captures?.[0];
    const paid = d.status === 'COMPLETED' && cap?.status === 'COMPLETED'
      && `${cap.amount?.value} ${cap.amount?.currency_code}` === order.payment_amount;
    return { paid, ref: cap?.id || d.id };
  },
};

// CMI (Centre Monétique Interbancaire) 3D Pay Hosting.
const CMI_URL = { test: 'https://testpayment.cmi.co.ma/fim/est3Dgate', live: 'https://payment.cmi.co.ma/fim/est3Dgate' };
const cmiEscape = (v) => String(v ?? '').trim().replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
// Hash v3: values sorted by parameter name (case-insensitive), "|"-joined, then "|" + store key, SHA-512, base64.
function cmiHash(params, storeKey) {
  const keys = Object.keys(params)
    .filter((k) => !['hash', 'encoding'].includes(k.toLowerCase()))
    .sort((a, b) => { const x = a.toLowerCase(); const y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
  const plain = keys.map((k) => cmiEscape(params[k])).join('|') + '|' + cmiEscape(storeKey);
  return crypto.createHash('sha512').update(plain, 'utf8').digest('base64');
}
const cmi = {
  url: (c) => CMI_URL[c.mode === 'live' ? 'live' : 'test'],
  async start({ store, order, urls }) {
    const c = credentials(store, 'cmi');
    const oid = `${order.id}T${Date.now().toString(36)}`.toUpperCase();
    const amount = Number(order.total).toFixed(2);
    const fields = {
      clientid: c.client_id,
      amount,
      okUrl: urls.cmiOk,
      failUrl: urls.cmiFail,
      callbackUrl: urls.cmiCallback,
      shopurl: urls.shop,
      TranType: 'PreAuth',
      currency: '504',
      rnd: crypto.randomBytes(10).toString('hex'),
      storetype: '3D_PAY_HOSTING',
      hashAlgorithm: 'ver3',
      lang: 'ar',
      oid,
      BillToName: order.customer_name,
      email: order.customer_email || '',
      tel: order.customer_phone,
      AutoRedirect: 'true',
      CallbackResponse: 'true',
      encoding: 'UTF-8',
    };
    fields.hash = cmiHash(fields, c.store_key);
    return { ref: oid, amount: `${amount} 504`, form: { action: cmi.url(c), fields } };
  },
  // Checks a POST from CMI (callback or browser return). Never trusts an unsigned message.
  check(store, order, body) {
    const c = credentials(store, 'cmi');
    const sent = String(body.HASH || body.hash || '');
    const expected = cmiHash(body, c.store_key);
    const a = Buffer.from(sent);
    const b = Buffer.from(expected);
    const signed = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!signed) return { signed: false, paid: false };
    const sameOrder = String(body.oid || '') === order.payment_ref && `${Number(body.amount).toFixed(2)} 504` === order.payment_amount;
    const approved = String(body.ProcReturnCode) === '00' && String(body.Response || '').toLowerCase() === 'approved';
    return { signed: true, paid: sameOrder && approved, ref: String(body.TransId || body.oid || '') };
  },
  // CMI posts back to us; the merchant can't re-query, so verify() only reports the stored state.
  async verify({ order }) {
    return { paid: order.payment_status === 'paid' };
  },
};

const PROVIDERS = { stripe, paypal, cmi };
const isOnline = (m) => METHODS[m]?.kind === 'online';
const isManual = (m) => METHODS[m]?.kind === 'manual';

module.exports = {
  METHODS, ORDER, PAY_STATUS, PROVIDERS, CMI_URL, http,
  init, encrypt, decrypt, settingsOf, secretsOf, credentials, available, publicDetails, parseForm,
  isOnline, isManual, cmiHash,
};
