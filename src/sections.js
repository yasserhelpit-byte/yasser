// Page sections: the building blocks merchants use to design their homepage and custom pages.
// SCHEMA drives both the dashboard builder (sent to the browser) and server-side sanitizing.
const { isImageUrl } = require('./uploads');

const f = (k, t, l, extra = {}) => ({ k, t, l, ...extra });
const BTN = [f('button', 'text', 'نص الزر', { max: 40, ph: 'تسوّق الآن' }), f('link', 'link', 'رابط الزر', { ph: '/products أو https://...' })];

const SCHEMA = {
  hero: {
    label: 'واجهة المتجر', icon: '🏠', desc: 'الشعار والعنوان والوصف وصورة الغلاف من إعدادات المتجر',
    fields: [f('title', 'text', 'العنوان (اتركه فارغاً لاستعمال شعار المتجر)', { max: 120 }), f('subtitle', 'textarea', 'النص', { max: 300 }), f('image', 'image', 'صورة الخلفية (اختياري)'), ...BTN],
  },
  slider: {
    label: 'سلايدر صور', icon: '🎞️', desc: 'شرائح صور كبيرة تتبدّل تلقائياً',
    fields: [f('height', 'select', 'الارتفاع', { options: { m: 'متوسط', l: 'كبير', s: 'صغير' } })],
    items: { label: 'شريحة', max: 6, fields: [f('image', 'image', 'الصورة'), f('title', 'text', 'العنوان', { max: 100 }), f('subtitle', 'text', 'النص', { max: 200 }), ...BTN] },
  },
  banner: {
    label: 'بانر صورة', icon: '🖼️', desc: 'صورة عريضة مع نص وزر',
    fields: [f('image', 'image', 'الصورة'), f('title', 'text', 'العنوان', { max: 100 }), f('subtitle', 'text', 'النص', { max: 200 }), ...BTN,
      f('height', 'select', 'الارتفاع', { options: { m: 'متوسط', l: 'كبير', s: 'صغير' } }),
      f('align', 'select', 'محاذاة النص', { options: { center: 'وسط', start: 'يمين', end: 'يسار' } })],
  },
  image_text: {
    label: 'صورة مع نص', icon: '📰', desc: 'صورة بجانب نص، مثالي لقصة المتجر',
    fields: [f('image', 'image', 'الصورة'), f('eyebrow', 'text', 'عنوان صغير', { max: 40 }), f('title', 'text', 'العنوان', { max: 100 }), f('text', 'textarea', 'النص', { max: 1500 }), ...BTN,
      f('side', 'select', 'مكان الصورة', { options: { start: 'يمين', end: 'يسار' } })],
  },
  products: {
    label: 'منتجات', icon: '🛍️', desc: 'شبكة من منتجاتك',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'وصل حديثاً' }), f('subtitle', 'text', 'النص', { max: 200 }),
      f('source', 'select', 'أي منتجات؟', { options: { newest: 'الأحدث', sale: 'العروض والتخفيضات', best: 'الأكثر مبيعاً', category: 'تصنيف معيّن' } }),
      f('category', 'text', 'التصنيف (إذا اخترت تصنيفاً معيّناً)', { max: 60 }),
      f('limit', 'select', 'العدد', { options: { 4: '4', 8: '8', 12: '12' } })],
  },
  categories: {
    label: 'التصنيفات بالصور', icon: '🗂️', desc: 'بطاقات تصنيفات بصور، تنقل إلى منتجات كل تصنيف',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'تسوّق حسب التصنيف' })],
    items: { label: 'تصنيف', max: 8, fields: [f('name', 'text', 'اسم التصنيف (كما في المنتجات)', { max: 60 }), f('image', 'image', 'الصورة')] },
  },
  gallery: {
    label: 'معرض صور', icon: '📸', desc: 'شبكة صور (مثل إنستغرام)',
    fields: [f('title', 'text', 'العنوان', { max: 80 }), f('subtitle', 'text', 'النص', { max: 200 }),
      f('columns', 'select', 'عدد الأعمدة', { options: { 3: '3', 4: '4', 2: '2' } })],
    items: { label: 'صورة', max: 12, fields: [f('image', 'image', 'الصورة'), f('caption', 'text', 'تعليق', { max: 80 }), f('link', 'link', 'رابط (اختياري)')] },
  },
  features: {
    label: 'مميزات', icon: '✨', desc: 'أيقونات مع نص: التوصيل، الدفع، الجودة...',
    fields: [f('title', 'text', 'العنوان', { max: 80 })],
    items: { label: 'ميزة', max: 6, fields: [f('icon', 'text', 'أيقونة (إيموجي)', { max: 4, ph: '🚚' }), f('title', 'text', 'العنوان', { max: 60 }), f('text', 'text', 'النص', { max: 120 })] },
  },
  testimonials: {
    label: 'آراء العملاء', icon: '💬', desc: 'تقييمات وشهادات عملائك',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'ماذا يقول عملاؤنا' })],
    items: { label: 'رأي', max: 9, fields: [f('name', 'text', 'اسم العميل', { max: 60 }), f('city', 'text', 'المدينة', { max: 40 }), f('text', 'textarea', 'الرأي', { max: 400 }),
      f('rating', 'select', 'التقييم', { options: { 5: '★★★★★', 4: '★★★★', 3: '★★★' } }), f('image', 'image', 'صورة (اختياري)')] },
  },
  text: {
    label: 'نص', icon: '📝', desc: 'فقرة نصية بعنوان',
    fields: [f('title', 'text', 'العنوان', { max: 100 }), f('text', 'textarea', 'النص', { max: 5000 }),
      f('align', 'select', 'المحاذاة', { options: { start: 'يمين', center: 'وسط' } })],
  },
  video: {
    label: 'فيديو يوتيوب', icon: '▶️', desc: 'فيديو من يوتيوب',
    fields: [f('title', 'text', 'العنوان', { max: 100 }), f('url', 'link', 'رابط الفيديو على يوتيوب', { ph: 'https://youtube.com/watch?v=...' })],
  },
  faq: {
    label: 'أسئلة شائعة', icon: '❓', desc: 'أسئلة وأجوبة قابلة للطي',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'الأسئلة الشائعة' })],
    items: { label: 'سؤال', max: 15, fields: [f('q', 'text', 'السؤال', { max: 200 }), f('a', 'textarea', 'الجواب', { max: 1000 })] },
  },
};

const MAX_SECTIONS = 20;

function cleanLink(v) {
  const s = String(v ?? '').trim().slice(0, 500);
  if (!s) return '';
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  if (/^\/[\w\-/%.?=&#]*$/.test(s)) return s; // relative to the store, e.g. /products
  if (/^#[\w-]*$/.test(s)) return s;
  return '';
}

function cleanField(field, value) {
  const v = value ?? '';
  switch (field.t) {
    case 'image': return isImageUrl(String(v)) ? String(v) : '';
    case 'link': return cleanLink(v);
    case 'select': return Object.hasOwn(field.options, String(v)) ? String(v) : Object.keys(field.options)[0];
    default: return String(v).slice(0, field.max || 300);
  }
}

function cleanObject(fields, obj) {
  const out = {};
  for (const field of fields) out[field.k] = cleanField(field, obj?.[field.k]);
  return out;
}

// Validate a sections array coming from the browser against SCHEMA. Unknown types/keys are dropped.
function sanitize(input) {
  let arr = input;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s) => s && SCHEMA[s.type])
    .slice(0, MAX_SECTIONS)
    .map((s) => {
      const def = SCHEMA[s.type];
      const out = { type: s.type, hidden: !!s.hidden, ...cleanObject(def.fields, s) };
      if (def.items) {
        out.items = (Array.isArray(s.items) ? s.items : []).slice(0, def.items.max).map((it) => cleanObject(def.items.fields, it));
      }
      return out;
    });
}

// Starting layouts merchants can pick from.
const item = (o) => o;
const PRESETS = {
  classic: {
    label: 'كلاسيكي',
    sections: [
      { type: 'hero' },
      { type: 'features', items: [item({ icon: '💵', title: 'الدفع عند الاستلام', text: 'ادفع عندما يصلك طلبك' }), item({ icon: '🚚', title: 'توصيل سريع', text: 'إلى باب منزلك' }), item({ icon: '📞', title: 'خدمة العملاء', text: 'نجيب على أسئلتك' })] },
      { type: 'products', title: 'وصل حديثاً', source: 'newest', limit: '8' },
    ],
  },
  fashion: {
    label: 'أزياء وموضة',
    sections: [
      { type: 'slider', height: 'l', items: [item({ title: 'تشكيلة الموسم الجديد', subtitle: 'اكتشف أحدث الصيحات', button: 'تسوّق الآن', link: '/products' }), item({ title: 'تخفيضات حتى 50%', subtitle: 'لفترة محدودة', button: 'اكتشف العروض', link: '/products?sale=1' })] },
      { type: 'categories', title: 'تسوّق حسب التصنيف', items: [] },
      { type: 'products', title: 'وصل حديثاً', source: 'newest', limit: '8' },
      { type: 'banner', title: 'جودة تستحقها', subtitle: 'خامات مختارة بعناية', button: 'اكتشف المزيد', link: '/products', height: 'm', align: 'center' },
      { type: 'products', title: 'العروض', source: 'sale', limit: '4' },
      { type: 'testimonials', title: 'ماذا يقول عملاؤنا', items: [item({ name: 'سارة', city: 'الدار البيضاء', text: 'جودة ممتازة وتوصيل سريع. أنصح به!', rating: '5' }), item({ name: 'يوسف', city: 'الرباط', text: 'خدمة رائعة والمنتج كما في الصور.', rating: '5' }), item({ name: 'مريم', city: 'مراكش', text: 'تعامل راقٍ، سأطلب مرة أخرى.', rating: '5' })] },
      { type: 'features', items: [item({ icon: '💵', title: 'الدفع عند الاستلام', text: 'ادفع عندما يصلك طلبك' }), item({ icon: '🚚', title: 'توصيل لكل المدن', text: 'خلال 24 إلى 72 ساعة' }), item({ icon: '🔄', title: 'استبدال سهل', text: 'خلال 7 أيام' })] },
    ],
  },
  boutique: {
    label: 'بوتيك أنيق',
    sections: [
      { type: 'banner', title: '', subtitle: '', height: 'l', align: 'center', button: 'اكتشف المجموعة', link: '/products' },
      { type: 'image_text', eyebrow: 'قصتنا', title: 'صُنع بحب وعناية', text: 'نختار كل قطعة بعناية لنقدّم لك منتجات تجمع بين الجودة والأناقة.', button: 'تعرّف علينا', link: '', side: 'start' },
      { type: 'products', title: 'مختاراتنا', source: 'newest', limit: '4' },
      { type: 'gallery', title: 'تابعنا على إنستغرام', columns: '4', items: [] },
      { type: 'faq', title: 'الأسئلة الشائعة', items: [item({ q: 'كم يستغرق التوصيل؟', a: 'من 24 إلى 72 ساعة حسب مدينتك.' }), item({ q: 'كيف أدفع؟', a: 'الدفع نقداً عند استلام طلبك.' })] },
    ],
  },
};
for (const p of Object.values(PRESETS)) p.sections = sanitize(p.sections);

const DEFAULT_HOME = PRESETS.classic.sections;

// YouTube URL -> video id (or '').
function youtubeId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : '';
}

module.exports = { SCHEMA, PRESETS, DEFAULT_HOME, sanitize, cleanLink, youtubeId };
