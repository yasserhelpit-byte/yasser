// Merchant subscriptions: a free plan, paid plans with manual (cash / transfer) payment, activation by an admin.
//
// A store's subscription is `stores.plan` + `stores.plan_until` (UTC, "YYYY-MM-DD HH:MM:SS").
// The first plan is free forever. New stores may get a trial of the paid features first. When a trial or a
// paid plan ends (after a few grace days) the store simply falls back to the free plan: it never closes,
// it only loses the paid features (more products, professional templates, custom domain).
const { db, getSettings, setSetting, transaction } = require('./db');

const DAY = 86400000;
const DEFAULT_PLANS = [
  { key: 'free', name: 'المجانية', price: 0, products: 30, ai: 0, domain: false, templates: false, featured: false,
    features: 'متجرك على رابط YASSER\nحتى 30 منتجاً\nالقوالب الأساسية (7 قوالب)\nالدفع عند الاستلام والطلبات والإشعارات\nمجانية للأبد' },
  { key: 'pro', name: 'الاحترافية', price: 199, products: 500, ai: 20, domain: true, templates: true, featured: true,
    features: 'كل ما في المجانية\nحتى 500 منتج\nكل القوالب الاحترافية والأساليب الجاهزة\nنطاقك الخاص (yourshop.ma)\nدعم عبر واتساب' },
  { key: 'business', name: 'الأعمال', price: 399, products: 0, ai: 60, domain: true, templates: true, featured: false,
    features: 'كل ما في الاحترافية\nمنتجات غير محدودة\nأولوية في الدعم\nمساعدة في إعداد متجرك' },
];
const FREE = 'free';
// Months -> how many months are charged (a year costs 10 months).
const PERIODS = { 1: { label: 'شهر واحد', pay: 1 }, 3: { label: '3 أشهر', pay: 3 }, 12: { label: 'سنة كاملة', pay: 10, note: 'شهران مجاناً' } };
const METHODS = { cash: 'نقداً', bank: 'تحويل بنكي', agency: 'وكالة تحويل (Wafacash، Cash Plus…)', other: 'أخرى' };

const iso = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);
const parse = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : NaN);
const int = (v, min, max, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt; };

function settings() {
  const st = getSettings();
  return { trialDays: int(st.trial_days, 0, 365, 14), graceDays: int(st.grace_days, 0, 60, 3), info: st.billing_info || '', currency: st.billing_currency || 'MAD' };
}

function plans() {
  let list = null;
  try { list = JSON.parse(getSettings().plans || 'null'); } catch {}
  if (!Array.isArray(list) || list.length !== DEFAULT_PLANS.length || list[0].key !== FREE) list = DEFAULT_PLANS;
  // The first plan is always the free one.
  return list.map((p, i) => ({ ...DEFAULT_PLANS[i], ...p, key: DEFAULT_PLANS[i].key, ...(i === 0 ? { price: 0, free: true } : { free: false }) }));
}
const planByKey = (key) => plans().find((p) => p.key === key) || null;

// Admin form (fields like plan0_name) -> stored plans.
function savePlans(body) {
  const list = DEFAULT_PLANS.map((d, i) => ({
    key: d.key,
    name: String(body[`plan${i}_name`] ?? d.name).trim().slice(0, 40) || d.name,
    price: i === 0 ? 0 : Math.max(0, Math.round(Number(body[`plan${i}_price`]) || 0)),
    products: int(body[`plan${i}_products`], 0, 1000000, d.products),
    ai: int(body[`plan${i}_ai`], 0, 10000, d.ai),
    domain: !!body[`plan${i}_domain`],
    templates: !!body[`plan${i}_templates`],
    featured: body.featured === d.key,
    features: String(body[`plan${i}_features`] ?? '').trim().slice(0, 1000),
  }));
  setSetting('plans', JSON.stringify(list));
  setSetting('trial_days', String(int(body.trial_days, 0, 365, 14)));
  setSetting('grace_days', String(int(body.grace_days, 0, 60, 3)));
  setSetting('billing_info', String(body.billing_info ?? '').trim().slice(0, 1500));
  return list;
}

// Where a store stands right now.
//   state: free | trial | active | expiring (≤ 7 days left) | grace (ended, paid features kept a few days)
function statusOf(store) {
  const { graceDays } = settings();
  const free = planByKey(FREE);
  const trial = store.plan === 'trial';
  const paid = !trial && store.plan !== FREE ? planByKey(store.plan) : null;
  const until = parse(store.plan_until);
  const now = Date.now();
  const msLeft = (Number.isFinite(until) ? until : now) - now;
  const daysLeft = Math.max(0, Math.ceil(msLeft / DAY));
  const graceLeft = Math.max(0, Math.ceil((graceDays * DAY + msLeft) / DAY));
  let state = 'free';
  let plan = free;
  if ((trial || paid) && Number.isFinite(until)) {
    if (msLeft > 0) state = trial ? 'trial' : daysLeft <= 7 ? 'expiring' : 'active';
    else if (-msLeft < graceDays * DAY) state = 'grace';
    // A trial or paid plan gives its features until the grace days are over; then the free plan applies.
    if (state !== 'free') plan = paid || planByKey('pro'); // the trial = the middle plan
  }
  const lapsed = state === 'free' && (trial || !!paid); // was on a trial or paid plan that ended
  return {
    state, trial: state === 'trial', plan, paid: state !== 'free' && !trial ? paid : null, lapsed,
    until: state === 'free' ? null : store.plan_until, daysLeft, graceLeft,
    open: true,
    label: state === 'trial' ? 'فترة تجريبية' : plan.name,
    limits: { products: plan.products, ai: plan.ai, domain: !!plan.domain, templates: !!plan.templates },
  };
}

// New stores: a trial of the paid features if the admin set trial days, otherwise straight on the free plan.
function startTrial(storeId) {
  const days = settings().trialDays;
  if (days > 0) db.prepare("UPDATE stores SET plan = 'trial', plan_until = ? WHERE id = ?").run(iso(Date.now() + days * DAY), storeId);
  else db.prepare('UPDATE stores SET plan = ?, plan_until = NULL WHERE id = ?').run(FREE, storeId);
}

function addMonths(fromMs, months) {
  const d = new Date(fromMs);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0); // 31 Jan + 1 month -> 28/29 Feb
  return d.getTime();
}

const priceOf = (plan, months) => plan.price * (PERIODS[months]?.pay ?? months);

// Activate (or extend) a plan. Renewing the same plan early adds to the remaining time.
function activate({ storeId, planKey, months, adminId, method = 'cash', amount = null, reference = '', note = '', requestId = null }) {
  const plan = planByKey(planKey);
  if (!plan || plan.free || !PERIODS[months]) throw new Error('bad plan');
  return transaction(() => {
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
    const until = parse(store.plan_until);
    const from = store.plan === planKey && until > Date.now() ? until : Date.now();
    const newUntil = iso(addMonths(from, Number(months)));
    db.prepare('UPDATE stores SET plan = ?, plan_until = ? WHERE id = ?').run(planKey, newUntil, storeId);
    const paid = amount === null || amount === '' ? priceOf(plan, months) : Math.max(0, Number(amount) || 0);
    if (requestId) {
      db.prepare(`UPDATE subscriptions SET status = 'approved', plan = ?, months = ?, amount = ?, method = ?, reference = ?, decided_at = datetime('now'), decided_by = ?, until = ? WHERE id = ?`)
        .run(planKey, months, paid, METHODS[method] ? method : 'other', String(reference).slice(0, 80), adminId, newUntil, requestId);
    } else {
      db.prepare(`INSERT INTO subscriptions (store_id, user_id, plan, months, amount, method, reference, note, status, decided_at, decided_by, until)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', datetime('now'), ?, ?)`)
        .run(storeId, store.owner_id, planKey, months, paid, METHODS[method] ? method : 'other', String(reference).slice(0, 80), String(note).slice(0, 300), adminId, newUntil);
    }
    return { plan, until: newUntil, amount: paid };
  });
}

// A merchant asks for a plan; replaces any earlier pending request for the same store.
function request({ store, userId, planKey, months, method, note }) {
  const plan = planByKey(planKey);
  if (!plan || plan.free || !PERIODS[months]) return null;
  db.prepare("DELETE FROM subscriptions WHERE store_id = ? AND status = 'pending'").run(store.id);
  const { lastInsertRowid } = db.prepare(`INSERT INTO subscriptions (store_id, user_id, plan, months, amount, method, note) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(store.id, userId, planKey, Number(months), priceOf(plan, months), METHODS[method] ? method : 'cash', String(note || '').slice(0, 300));
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(lastInsertRowid);
}

const pendingOf = (storeId) => db.prepare("SELECT * FROM subscriptions WHERE store_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(storeId);
const historyOf = (storeId) => db.prepare("SELECT * FROM subscriptions WHERE store_id = ? AND status != 'pending' ORDER BY id DESC LIMIT 24").all(storeId);
const pendingCount = () => db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'pending'").get().n;
const reference = (sub) => `YS-${sub.store_id}-${sub.id}`;

const paidPlans = () => plans().filter((p) => !p.free);

module.exports = {
  FREE, paidPlans, DEFAULT_PLANS, PERIODS, METHODS, settings, plans, planByKey, savePlans, statusOf, startTrial, activate, request,
  pendingOf, historyOf, pendingCount, priceOf, reference, iso, parse,
};
