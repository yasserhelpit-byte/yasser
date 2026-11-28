// Page sections: the building blocks merchants use to design their homepage and custom pages.
// SCHEMA drives both the dashboard builder (sent to the browser) and server-side sanitizing.
const { isImageUrl } = require('./uploads');

const f = (k, t, l, extra = {}) => ({ k, t, l, ...extra });
const BTN = [f('button', 'text', 'نص الزر', { max: 40, ph: 'تسوّق الآن' }), f('link', 'link', 'رابط الزر', { ph: '/products أو https://...' })];

const SCHEMA = {
  product_hero: {
    label: 'منتج رئيسي + طلب مباشر', icon: '🎯', desc: 'لصفحات الهبوط: صور المنتج وسعره ونموذج الطلب في نفس الصفحة',
    fields: [f('product', 'product', 'المنتج'), f('eyebrow', 'text', 'شارة صغيرة', { max: 40, ph: '🔥 الأكثر طلباً' }),
      f('headline', 'text', 'عنوان جذاب (اختياري، بدل اسم المنتج)', { max: 120 }), f('subtitle', 'textarea', 'وصف قصير مقنع', { max: 400 }),
      f('button', 'text', 'نص زر الطلب', { max: 40, ph: 'اطلب الآن · الدفع عند الاستلام' })],
  },
  order_form: {
    label: 'نموذج طلب', icon: '📝', desc: 'نموذج الدفع عند الاستلام لمنتج واحد (ضعه أيضاً في آخر الصفحة)',
    fields: [f('product', 'product', 'المنتج'), f('title', 'text', 'العنوان', { max: 80, ph: 'اطلب الآن والدفع عند الاستلام' }),
      f('subtitle', 'text', 'النص', { max: 200 }), f('button', 'text', 'نص الزر', { max: 40, ph: 'تأكيد الطلب' })],
  },
  countdown: {
    label: 'عدّاد تنازلي للعرض', icon: '⏳', desc: 'يعدّ حتى تاريخ انتهاء عرضك الحقيقي، ويختفي تلقائياً بعده',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'العرض ينتهي خلال' }), f('ends_at', 'datetime', 'تاريخ ووقت نهاية العرض')],
  },
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
  services: {
    label: 'الخدمات', icon: '🧰', desc: 'بطاقات خدماتك مع السعر وزر للحجز أو الاستفسار عبر واتساب',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'خدماتنا' }), f('subtitle', 'text', 'النص', { max: 200 })],
    items: { label: 'خدمة', max: 12, fields: [f('icon', 'text', 'أيقونة (إيموجي)', { max: 4, ph: '⭐' }), f('image', 'image', 'صورة (اختياري، بدل الأيقونة)'),
      f('title', 'text', 'اسم الخدمة', { max: 80 }), f('text', 'textarea', 'الوصف', { max: 300 }), f('price', 'text', 'السعر (اختياري)', { max: 40, ph: 'ابتداءً من 300 درهم' }),
      f('button', 'text', 'نص الزر (اختياري)', { max: 30, ph: 'احجز الآن' }), f('link', 'link', 'رابط الزر (فارغ = واتساب المتجر)')] },
  },
  menu: {
    label: 'المنيو (قائمة الطعام)', icon: '🍽️', desc: 'أطباق مرتبة حسب الأقسام مع الأسعار والصور، وطلب عبر واتساب',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'قائمة الطعام' }), f('subtitle', 'text', 'النص', { max: 200 }),
      f('order', 'select', 'زر الطلب بجانب كل طبق', { options: { whatsapp: 'اطلب عبر واتساب', none: 'بدون زر' } }),
      f('note', 'text', 'ملاحظة أسفل المنيو', { max: 200, ph: 'الأسعار بالدرهم وتشمل الضريبة' })],
    items: { label: 'طبق', max: 80, fields: [f('category', 'text', 'القسم', { max: 40, ph: 'الأطباق الرئيسية' }), f('name', 'text', 'اسم الطبق', { max: 80 }),
      f('desc', 'text', 'الوصف', { max: 200 }), f('price', 'text', 'السعر', { max: 20, ph: '45' }), f('tag', 'text', 'شارة (اختياري)', { max: 20, ph: '🌶️ حار · ⭐ الأكثر طلباً' }), f('image', 'image', 'صورة (اختياري)')] },
  },
  team: {
    label: 'الفريق / الأطباء', icon: '👩‍⚕️', desc: 'صور وأسماء وتخصصات فريقك',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'فريقنا' }), f('subtitle', 'text', 'النص', { max: 200 })],
    items: { label: 'عضو', max: 12, fields: [f('image', 'image', 'الصورة'), f('name', 'text', 'الاسم', { max: 80 }), f('role', 'text', 'التخصص / المنصب', { max: 80 }),
      f('text', 'textarea', 'نبذة', { max: 300 })] },
  },
  stats: {
    label: 'أرقام وإنجازات', icon: '📈', desc: 'أرقام كبيرة: سنوات الخبرة، عدد العملاء...',
    fields: [f('title', 'text', 'العنوان (اختياري)', { max: 80 })],
    items: { label: 'رقم', max: 4, fields: [f('value', 'text', 'الرقم', { max: 12, ph: '+10' }), f('label', 'text', 'الوصف', { max: 60, ph: 'سنوات من الخبرة' })] },
  },
  hours: {
    label: 'أوقات العمل والعنوان', icon: '🕘', desc: 'جدول أوقات العمل مع العنوان والخريطة والهاتف',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'أوقات العمل' }), f('address', 'textarea', 'العنوان الكامل', { max: 300 }),
      f('map', 'link', 'رابط الموقع على خرائط Google (اختياري)', { ph: 'https://maps.app.goo.gl/...' }), f('phone', 'text', 'الهاتف (فارغ = هاتف المتجر)', { max: 30 })],
    items: { label: 'يوم', max: 8, fields: [f('day', 'text', 'اليوم / الأيام', { max: 40, ph: 'الإثنين – الجمعة' }), f('time', 'text', 'التوقيت', { max: 40, ph: '09:00 – 18:00 أو مغلق' })] },
  },
  contact_cta: {
    label: 'زر حجز / تواصل', icon: '📅', desc: 'شريط بارز بزر واتساب أو اتصال: احجز موعدك، احجز طاولة...',
    fields: [f('title', 'text', 'العنوان', { max: 100, ph: 'احجز موعدك الآن' }), f('text', 'text', 'النص', { max: 200 }),
      f('button', 'text', 'نص الزر', { max: 40, ph: 'احجز عبر واتساب' }),
      f('mode', 'select', 'عند الضغط', { options: { whatsapp: 'فتح واتساب المتجر', phone: 'اتصال بهاتف المتجر', link: 'فتح رابط' } }),
      f('message', 'text', 'الرسالة الجاهزة في واتساب', { max: 200, ph: 'مرحباً، أريد حجز موعد.' }), f('link', 'link', 'الرابط (إذا اخترت «فتح رابط»)')],
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
    case 'product': return /^\d{1,9}$/.test(String(v)) ? String(v) : '';
    case 'datetime': return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(v)) ? String(v) : '';
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
  landing: {
    label: 'صفحة هبوط (منتج واحد)',
    sections: [
      { type: 'product_hero', eyebrow: '🔥 الأكثر طلباً', subtitle: 'اكتب هنا جملتين تشرحان لماذا يحتاج العميل هذا المنتج وما الذي سيتغيّر في حياته.', button: 'اطلب الآن · الدفع عند الاستلام' },
      { type: 'countdown', title: 'العرض ينتهي خلال' },
      { type: 'features', title: 'لماذا تختار منتجنا؟', items: [item({ icon: '✨', title: 'الميزة الأولى', text: 'اشرح فائدة واضحة للعميل' }), item({ icon: '💪', title: 'الميزة الثانية', text: 'جودة، متانة، سهولة الاستعمال…' }), item({ icon: '🎁', title: 'الميزة الثالثة', text: 'ما الذي يميّزك عن المنافسين؟' })] },
      { type: 'image_text', eyebrow: 'كيف يعمل؟', title: 'شرح المنتج بالصور', text: 'ارفع صورة للمنتج أثناء الاستعمال، واشرح خطوات استعماله أو نتيجته.', side: 'start' },
      { type: 'gallery', title: 'صور المنتج', columns: '3', items: [] },
      { type: 'testimonials', title: 'آراء عملائنا', items: [item({ name: 'اسم العميل', city: 'المدينة', text: 'ضع هنا رأياً حقيقياً من أحد عملائك (احذف هذا القسم إن لم تكن لديك آراء بعد).', rating: '5' })] },
      { type: 'features', title: 'اطلب وأنت مطمئن', items: [item({ icon: '💵', title: 'الدفع عند الاستلام', text: 'لا تدفع شيئاً قبل أن يصلك طلبك' }), item({ icon: '🚚', title: 'توصيل لكل المدن', text: 'إلى باب منزلك' }), item({ icon: '📞', title: 'نتصل بك للتأكيد', text: 'قبل الشحن' })] },
      { type: 'faq', title: 'الأسئلة الشائعة', items: [item({ q: 'كم يستغرق التوصيل؟', a: 'من 24 إلى 72 ساعة حسب مدينتك.' }), item({ q: 'متى أدفع؟', a: 'تدفع نقداً عند استلام طلبك.' }), item({ q: 'هل يمكنني إرجاع المنتج؟', a: 'اكتب هنا سياسة الإرجاع الخاصة بك.' })] },
      { type: 'order_form', title: 'اطلب الآن والدفع عند الاستلام', subtitle: 'املأ معلوماتك وسنتصل بك لتأكيد الطلب.', button: 'تأكيد الطلب' },
    ],
  },
};
const day = (d, t) => item({ day: d, time: t });
const dish = (category, name, desc, price, tag = '') => item({ category, name, desc, price, tag });
Object.assign(PRESETS, {
  about: {
    label: 'تعريف وخدمات',
    sections: [
      { type: 'hero', subtitle: 'نقدّم لك خدمات احترافية بجودة عالية وأسعار مناسبة.', button: 'تواصل معنا', link: '#contact' },
      { type: 'image_text', eyebrow: 'من نحن', title: 'خبرة وثقة في خدمتك', text: 'عرّف بنفسك هنا: من أنت، منذ متى تعمل، وما الذي يميّزك. اكتب بصدق وبلغة بسيطة يفهمها عملاؤك.', side: 'start' },
      { type: 'stats', items: [item({ value: '+10', label: 'سنوات من الخبرة' }), item({ value: '+500', label: 'عميل راضٍ' }), item({ value: '24/7', label: 'نرد على رسائلك' })] },
      { type: 'services', title: 'خدماتنا', subtitle: 'اختر الخدمة التي تحتاجها وتواصل معنا مباشرة', items: [
        item({ icon: '🎯', title: 'الخدمة الأولى', text: 'وصف قصير لما تقدّمه وما يستفيده العميل.', price: 'ابتداءً من 300 درهم', button: 'اطلب الخدمة' }),
        item({ icon: '🛠️', title: 'الخدمة الثانية', text: 'وصف قصير لما تقدّمه وما يستفيده العميل.', price: 'ابتداءً من 500 درهم', button: 'اطلب الخدمة' }),
        item({ icon: '💡', title: 'الخدمة الثالثة', text: 'وصف قصير لما تقدّمه وما يستفيده العميل.', price: 'حسب الطلب', button: 'اطلب عرض سعر' })] },
      { type: 'testimonials', title: 'ماذا يقول عملاؤنا', items: [item({ name: 'اسم العميل', city: 'المدينة', text: 'ضع هنا رأياً حقيقياً من أحد عملائك.', rating: '5' })] },
      { type: 'faq', title: 'الأسئلة الشائعة', items: [item({ q: 'كيف أطلب خدمة؟', a: 'راسلنا عبر واتساب أو اتصل بنا، وسنرد عليك في أقرب وقت.' }), item({ q: 'ما هي مناطق عملكم؟', a: 'اكتب هنا المدن أو المناطق التي تخدمها.' })] },
      { type: 'contact_cta', title: 'جاهز لنبدأ؟', text: 'تواصل معنا الآن واحصل على رد سريع.', button: 'راسلنا عبر واتساب', mode: 'whatsapp', message: 'مرحباً، أريد الاستفسار عن خدماتكم.' },
      { type: 'hours', title: 'أوقات العمل', items: [day('الإثنين – الجمعة', '09:00 – 18:00'), day('السبت', '09:00 – 13:00'), day('الأحد', 'مغلق')] },
    ],
  },
  clinic: {
    label: 'عيادة / طبيب',
    sections: [
      { type: 'hero', title: 'عيادة الدكتور …', subtitle: 'طب عام · استشارات · متابعة\nنستقبلكم بالموعد في أجواء مريحة.', button: 'احجز موعدك', link: '#contact' },
      { type: 'services', title: 'خدماتنا', subtitle: 'الفحوصات والخدمات المتوفرة في العيادة', items: [
        item({ icon: '🩺', title: 'الفحص العام', text: 'فحص شامل وتشخيص ومتابعة الحالة.' }),
        item({ icon: '🫀', title: 'تخطيط القلب', text: 'تخطيط كهربائي للقلب داخل العيادة.' }),
        item({ icon: '🧪', title: 'التحاليل', text: 'توجيه وقراءة نتائج التحاليل الطبية.' }),
        item({ icon: '💉', title: 'التلقيح', text: 'تلقيح الأطفال والبالغين حسب الجدول الوطني.' })] },
      { type: 'team', title: 'الطاقم الطبي', items: [item({ name: 'د. الاسم الكامل', role: 'طبيب عام', text: 'خريج كلية الطب بـ… ، خبرة … سنوات.' }), item({ name: 'الاسم الكامل', role: 'ممرضة', text: '' })] },
      { type: 'hours', title: 'أوقات العمل والعنوان', address: 'اكتب عنوان العيادة كاملاً', items: [day('الإثنين – الجمعة', '09:00 – 13:00 · 15:00 – 19:00'), day('السبت', '09:00 – 13:00'), day('الأحد والأعياد', 'مغلق')] },
      { type: 'contact_cta', title: 'احجز موعدك', text: 'أرسل لنا رسالة على واتساب مع اسمك واليوم المناسب لك، وسنؤكد موعدك.', button: 'احجز عبر واتساب', mode: 'whatsapp', message: 'مرحباً، أريد حجز موعد. الاسم: … اليوم المناسب: …' },
      { type: 'faq', title: 'أسئلة متكررة', items: [item({ q: 'هل يجب الحجز مسبقاً؟', a: 'ننصح بالحجز لتفادي الانتظار، ونستقبل الحالات المستعجلة.' }), item({ q: 'هل تقبلون التأمين (CNSS / CNOPS / التأمين الخاص)؟', a: 'نعم، نملأ لكم ورقة العلاج. اكتب هنا التفاصيل.' }), item({ q: 'ماذا أحضر معي؟', a: 'البطاقة الوطنية، ورقة التأمين، والتحاليل أو الوصفات السابقة إن وُجدت.' })] },
    ],
  },
  restaurant: {
    label: 'مطعم (منيو)',
    sections: [
      { type: 'hero', subtitle: 'أطباق طازجة كل يوم · أكل في المطعم · طلب وتوصيل', button: 'شاهد المنيو', link: '#menu' },
      { type: 'menu', title: 'قائمة الطعام', order: 'whatsapp', note: 'الأسعار بالدرهم.', items: [
        dish('المقبلات', 'سلطة مغربية', 'طماطم، خيار، بصل، زيت زيتون', '25'),
        dish('المقبلات', 'حريرة', 'مع التمر والشباكية', '15'),
        dish('الأطباق الرئيسية', 'طاجين دجاج بالزيتون', 'دجاج بلدي، زيتون، حامض مصيّر', '70', '⭐ الأكثر طلباً'),
        dish('الأطباق الرئيسية', 'كسكس بالخضر', 'كل يوم جمعة', '60'),
        dish('الأطباق الرئيسية', 'مشاوي مشكّلة', 'كفتة، دجاج، لحم مع الخبز والصلصة', '90', '🔥'),
        dish('المشروبات', 'أتاي بالنعناع', 'براد صغير', '10'),
        dish('المشروبات', 'عصير برتقال طبيعي', '', '15'),
        dish('الحلويات', 'حلويات مغربية', 'تشكيلة اليوم', '20')] },
      { type: 'features', items: [item({ icon: '🥗', title: 'مكونات طازجة', text: 'نطبخ كل يوم' }), item({ icon: '🛵', title: 'توصيل', text: 'إلى منزلك أو مكتبك' }), item({ icon: '🪑', title: 'حجز طاولة', text: 'للعائلات والمناسبات' })] },
      { type: 'gallery', title: 'من مطبخنا', columns: '3', items: [] },
      { type: 'contact_cta', title: 'احجز طاولتك أو اطلب الآن', text: 'راسلنا على واتساب وسنجهّز طلبك.', button: 'اطلب عبر واتساب', mode: 'whatsapp', message: 'مرحباً، أريد الطلب / حجز طاولة.' },
      { type: 'hours', title: 'أوقات العمل والعنوان', address: 'اكتب عنوان المطعم', items: [day('كل الأيام', '12:00 – 23:00')] },
    ],
  },
});
for (const p of Object.values(PRESETS)) p.sections = sanitize(p.sections);

const DEFAULT_HOME = PRESETS.classic.sections;

// YouTube URL -> video id (or '').
function youtubeId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : '';
}

module.exports = { SCHEMA, PRESETS, DEFAULT_HOME, sanitize, cleanLink, youtubeId };
