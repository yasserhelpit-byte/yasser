// Order totals: shipping by city and discount coupons. Used by the cart checkout, landing-page orders
// and order creation, so the customer always sees the amount the server will charge.
const { db } = require('./db');

const money2 = (n) => Math.round(Number(n) * 100) / 100;
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// ---- Shipping zones ----
// Stored as JSON [{ city, fee }]. Entered by the merchant as lines like "الدار البيضاء = 20".
function zonesOf(store) {
  try {
    const z = JSON.parse(store.shipping_zones || '[]');
    return Array.isArray(z) ? z.filter((x) => x && x.city).map((x) => ({ city: String(x.city).slice(0, 60), fee: money2(Math.max(0, Number(x.fee) || 0)) })) : [];
  } catch { return []; }
}
function parseZones(text) {
  const out = [];
  const errors = [];
  const seen = new Set();
  String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200).forEach((line, i) => {
    const m = line.match(/^(.+?)\s*[=:،,]\s*([\d.,]+)\s*(?:درهم|dh|mad)?$/i);
    if (!m) { errors.push(`السطر ${i + 1}: اكتب المدينة ثم = ثم السعر، مثال: الدار البيضاء = 20`); return; }
    const city = m[1].trim().slice(0, 60);
    if (seen.has(norm(city))) return;
    seen.add(norm(city));
    out.push({ city, fee: money2(Math.max(0, Number(m[2].replace(',', '.')) || 0)) });
  });
  return { zones: out, errors };
}
const zonesText = (store) => zonesOf(store).map((z) => `${z.city} = ${z.fee}`).join('\n');

// Shipping for a subtotal and a city. Unknown city -> the store's default fee ("other cities").
function shippingFor(store, subtotal, city) {
  if (!(subtotal > 0)) return 0;
  if (store.free_shipping_over > 0 && subtotal >= store.free_shipping_over) return 0;
  const zone = zonesOf(store).find((z) => norm(z.city) === norm(city));
  return zone ? zone.fee : money2(store.shipping_fee || 0);
}

// ---- Coupons ----
const TYPES = { percent: 'نسبة مئوية', fixed: 'مبلغ ثابت', shipping: 'توصيل مجاني' };
const cleanCode = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
const findCoupon = (storeId, code) => (cleanCode(code) ? db.prepare('SELECT * FROM coupons WHERE store_id = ? AND code = ?').get(storeId, cleanCode(code)) : null);

// Is this coupon usable on this subtotal? Returns an Arabic reason when not.
function couponProblem(c, subtotal) {
  if (!c || !c.active) return 'كود الخصم غير صحيح.';
  if (c.ends_at && Date.parse(c.ends_at.replace(' ', 'T') + 'Z') < Date.now()) return 'انتهت صلاحية كود الخصم.';
  if (c.max_uses > 0 && c.used >= c.max_uses) return 'استُعمل كود الخصم بالكامل.';
  if (c.min_total > 0 && subtotal < c.min_total) return `كود الخصم صالح للطلبات من ${c.min_total} فما فوق.`;
  return null;
}

// Full totals. opts: { city, coupon (code) }. Returns the amounts and the applied coupon (or why not).
function totals(store, subtotal, opts = {}) {
  subtotal = money2(subtotal);
  let shipping = shippingFor(store, subtotal, opts.city);
  let discount = 0;
  let coupon = null;
  let couponError = null;
  if (opts.coupon) {
    const c = findCoupon(store.id, opts.coupon);
    couponError = couponProblem(c, subtotal);
    if (!couponError) {
      coupon = c;
      if (c.type === 'percent') discount = money2(subtotal * Math.min(100, Math.max(0, c.value)) / 100);
      else if (c.type === 'fixed') discount = money2(Math.min(subtotal, Math.max(0, c.value)));
      else if (c.type === 'shipping') shipping = 0;
    }
  }
  return { subtotal, shipping, discount, total: money2(Math.max(0, subtotal - discount) + shipping), coupon, couponError };
}

const describe = (c, currency) => (c.type === 'percent' ? `خصم ${c.value}%` : c.type === 'fixed' ? `خصم ${c.value} ${currency}` : 'توصيل مجاني');

module.exports = { zonesOf, parseZones, zonesText, shippingFor, TYPES, cleanCode, findCoupon, couponProblem, totals, describe, money2 };
