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
      f('limit', 'select', 'العدد', { options: { 4: '4', 8: '8', 12: '12' } }),
      f('layout', 'select', 'طريقة العرض', { options: { grid: 'شبكة', carousel: 'شريط يمرَّر أفقياً' } })],
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
  marquee: {
    label: 'شريط نصوص متحرك', icon: '📢', desc: 'جمل قصيرة تتحرك باستمرار: عروض، توصيل مجاني، ضمان...',
    fields: [f('speed', 'select', 'السرعة', { options: { normal: 'عادية', slow: 'بطيئة', fast: 'سريعة' } }),
      f('style', 'select', 'اللون', { options: { brand: 'لون المتجر', dark: 'داكن', light: 'فاتح' } })],
    items: { label: 'جملة', max: 8, fields: [f('text', 'text', 'النص', { max: 80, ph: '🚚 توصيل مجاني فوق 300 درهم' })] },
  },
  promo_grid: {
    label: 'بطاقات عروض', icon: '🧩', desc: '2 أو 3 بطاقات بصور كبيرة، لكل واحدة عنوان وزر (تشكيلات، عروض...)',
    fields: [f('title', 'text', 'العنوان (اختياري)', { max: 80 }), f('columns', 'select', 'عدد البطاقات في الصف', { options: { 2: '2', 3: '3' } })],
    items: { label: 'بطاقة', max: 6, fields: [f('image', 'image', 'الصورة'), f('eyebrow', 'text', 'شارة صغيرة', { max: 30, ph: 'جديد' }), f('title', 'text', 'العنوان', { max: 60 }),
      f('subtitle', 'text', 'النص', { max: 120 }), ...BTN] },
  },
  steps: {
    label: 'خطوات (كيف نعمل)', icon: '🪜', desc: 'خطوات مرقّمة تشرح طريقة الطلب أو العمل',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'كيف تطلب؟' }), f('subtitle', 'text', 'النص', { max: 200 })],
    items: { label: 'خطوة', max: 6, fields: [f('icon', 'text', 'أيقونة (اختياري)', { max: 4, ph: '🛒' }), f('title', 'text', 'العنوان', { max: 60 }), f('text', 'text', 'النص', { max: 160 })] },
  },
  pricing: {
    label: 'الباقات والأسعار', icon: '💎', desc: 'جدول باقات بأسعار ومميزات، مع إبراز الباقة المقترحة',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'اختر باقتك' }), f('subtitle', 'text', 'النص', { max: 200 })],
    items: { label: 'باقة', max: 4, fields: [f('name', 'text', 'اسم الباقة', { max: 40 }), f('price', 'text', 'السعر', { max: 20, ph: '299' }), f('period', 'text', 'المدة (اختياري)', { max: 20, ph: '/ شهر' }),
      f('features', 'textarea', 'المميزات (كل ميزة في سطر)', { max: 800 }), f('featured', 'select', 'إبراز هذه الباقة؟', { options: { no: 'لا', yes: 'نعم: «الأكثر طلباً»' } }),
      f('button', 'text', 'نص الزر', { max: 30, ph: 'اختر الباقة' }), f('link', 'link', 'رابط الزر (فارغ = واتساب المتجر)')] },
  },
  before_after: {
    label: 'قبل / بعد', icon: '↔️', desc: 'صورتان يقارن بينهما الزائر بسحب الخط (تجميل، تنظيف، ترميم...)',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'شاهد الفرق' }), f('subtitle', 'text', 'النص', { max: 200 }),
      f('before', 'image', 'صورة «قبل»'), f('after', 'image', 'صورة «بعد»'),
      f('before_label', 'text', 'تسمية «قبل»', { max: 20, ph: 'قبل' }), f('after_label', 'text', 'تسمية «بعد»', { max: 20, ph: 'بعد' })],
  },
  logos: {
    label: 'شعارات (علامات وشركاء)', icon: '🏷️', desc: 'شعارات العلامات التي تبيعها أو الشركاء والعملاء',
    fields: [f('title', 'text', 'العنوان (اختياري)', { max: 80, ph: 'علامات نثق بها' })],
    items: { label: 'شعار', max: 12, fields: [f('image', 'image', 'الشعار'), f('name', 'text', 'الاسم', { max: 40 }), f('link', 'link', 'رابط (اختياري)')] },
  },
  contact_form: {
    label: 'نموذج تواصل', icon: '✉️', desc: 'يرسل الزائر اسمه وهاتفه ورسالته، وتصلك في «الرسائل» مع إشعار',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'راسلنا' }), f('subtitle', 'text', 'النص', { max: 200, ph: 'نرد عليك في أقرب وقت.' }),
      f('button', 'text', 'نص الزر', { max: 30, ph: 'إرسال' })],
  },
  map: {
    label: 'خريطة', icon: '🗺️', desc: 'خريطة Google لموقع متجرك أو محلك',
    fields: [f('title', 'text', 'العنوان (اختياري)', { max: 80, ph: 'موقعنا' }), f('address', 'text', 'العنوان كما تبحث عنه في خرائط Google', { max: 200, ph: 'Café X, Boulevard Zerktouni, Casablanca' }),
      f('height', 'select', 'الارتفاع', { options: { m: 'متوسط', s: 'صغير', l: 'كبير' } })],
  },
  social: {
    label: 'تابعنا', icon: '📱', desc: 'أزرار حسابات المتجر (إنستغرام، فيسبوك، تيك توك، واتساب) من الإعدادات',
    fields: [f('title', 'text', 'العنوان', { max: 80, ph: 'تابعنا على مواقع التواصل' }), f('subtitle', 'text', 'النص', { max: 200 })],
  },
  divider: {
    label: 'فاصل / مسافة', icon: '➖', desc: 'مسافة أو خط بين الأقسام',
    fields: [f('size', 'select', 'المسافة', { options: { m: 'متوسطة', s: 'صغيرة', l: 'كبيرة' } }),
      f('line', 'select', 'الشكل', { options: { none: 'مسافة فقط', line: 'خط', dots: 'نقاط', wave: 'موجة' } })],
  },
};

// Options every section gets: background band and entrance animation.
const STYLE_FIELDS = [
  f('bg', 'select', '🎨 خلفية القسم', { options: { none: 'بدون', soft: 'فاتحة', brand: 'لون المتجر', dark: 'داكنة' } }),
  f('anim', 'select', '✨ حركة عند الظهور', { options: { up: 'ظهور تدريجي', zoom: 'تكبير خفيف', none: 'بدون' } }),
];
const NO_STYLE = new Set(['marquee', 'divider', 'slider', 'banner', 'hero', 'contact_cta']);
for (const [type, def] of Object.entries(SCHEMA)) {
  if (type === 'marquee' || type === 'divider') continue;
  def.fields.push(...STYLE_FIELDS.filter((x) => !(NO_STYLE.has(type) && x.k === 'bg')));
}

// Sections only paid plans can publish (free plans can still try them in the editor preview).
const PRO_TYPES = new Set(['marquee', 'promo_grid', 'steps', 'pricing', 'before_after', 'logos', 'contact_form', 'map']);
for (const t of PRO_TYPES) SCHEMA[t].pro = true;
// What in a sections list needs a paid plan: professional section types and coloured section backgrounds.
function proUsage(list) {
  const types = [...new Set(list.filter((s) => PRO_TYPES.has(s.type)).map((s) => SCHEMA[s.type].label))];
  const bg = list.some((s) => s.bg && s.bg !== 'none');
  return { types, bg, any: types.length > 0 || bg };
}
const stripPro = (list) => list.filter((s) => !PRO_TYPES.has(s.type)).map((s) => (s.bg && s.bg !== 'none' ? { ...s, bg: 'none' } : s));

const MAX_SECTIONS = 30;

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
    label: 'كلاسيكي', icon: '🏠', group: 'store', desc: 'بداية بسيطة لأي متجر',
    sections: [
      { type: 'hero' },
      { type: 'features', items: [item({ icon: '💵', title: 'الدفع عند الاستلام', text: 'ادفع عندما يصلك طلبك' }), item({ icon: '🚚', title: 'توصيل سريع', text: 'إلى باب منزلك' }), item({ icon: '📞', title: 'خدمة العملاء', text: 'نجيب على أسئلتك' })] },
      { type: 'products', title: 'وصل حديثاً', source: 'newest', limit: '8' },
    ],
  },
  fashion: {
    label: 'أزياء وموضة', icon: '👗', group: 'store', desc: 'ملابس وأحذية وإكسسوارات',
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
    label: 'بوتيك أنيق', icon: '💎', group: 'store', desc: 'متجر صغير بقصة وهوية',
    sections: [
      { type: 'banner', title: '', subtitle: '', height: 'l', align: 'center', button: 'اكتشف المجموعة', link: '/products' },
      { type: 'image_text', eyebrow: 'قصتنا', title: 'صُنع بحب وعناية', text: 'نختار كل قطعة بعناية لنقدّم لك منتجات تجمع بين الجودة والأناقة.', button: 'تعرّف علينا', link: '', side: 'start' },
      { type: 'products', title: 'مختاراتنا', source: 'newest', limit: '4' },
      { type: 'gallery', title: 'تابعنا على إنستغرام', columns: '4', items: [] },
      { type: 'faq', title: 'الأسئلة الشائعة', items: [item({ q: 'كم يستغرق التوصيل؟', a: 'من 24 إلى 72 ساعة حسب مدينتك.' }), item({ q: 'كيف أدفع؟', a: 'الدفع نقداً عند استلام طلبك.' })] },
    ],
  },
  landing: {
    label: 'صفحة هبوط (منتج واحد)', icon: '🎯', group: 'landing', desc: 'لإعلانات فيسبوك وتيك توك',
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
    label: 'تعريف وخدمات', icon: '🧰', group: 'service', desc: 'شركة أو حرفي أو مستقل',
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
    label: 'عيادة / طبيب', icon: '🩺', group: 'service', desc: 'خدمات وطاقم وأوقات وحجز',
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
    label: 'مطعم (منيو)', icon: '🍽️', group: 'service', desc: 'منيو وطلب عبر واتساب',
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

// ---- Professional templates: sections + a matching style (applied with the template). ----
const plan = (name, price, period, features, extra = {}) => item({ name, price, period, features, button: extra.button || 'اختر الباقة', featured: extra.featured || 'no' });
const step = (icon, title, text) => item({ icon, title, text });
const say = (name, city, text) => item({ name, city, text, rating: '5' });
const q = (qq, a) => item({ q: qq, a });
Object.assign(PRESETS, {
  electronics: {
    label: 'إلكترونيات وتقنية', icon: '📱', group: 'store', desc: 'هواتف، إكسسوارات، أجهزة ذكية',
    style: { color: '#1e3a8a', font: 'cairo', radius: 'soft', theme: { mode: 'light', hfont: 'same', size: 'm', btn: 'gradient', card: 'shadow', ratio: 'square', density: 'm', head: 'sticky' } },
    sections: [
      { type: 'marquee', style: 'dark', items: [item({ text: '⚡ شحن سريع لكل المدن' }), item({ text: '🛡️ ضمان 12 شهراً' }), item({ text: '💵 الدفع عند الاستلام' }), item({ text: '🔄 استبدال خلال 7 أيام' })] },
      { type: 'slider', height: 'l', items: [item({ title: 'أحدث الهواتف والإكسسوارات', subtitle: 'أصلية ومضمونة، بأفضل الأسعار', button: 'تسوّق الآن', link: '/products' }), item({ title: 'عروض الأسبوع', subtitle: 'تخفيضات حتى 30% على السماعات والساعات الذكية', button: 'شاهد العروض', link: '/products?sale=1' })] },
      { type: 'promo_grid', columns: '3', items: [
        item({ eyebrow: 'جديد', title: 'الهواتف الذكية', subtitle: 'آخر الإصدارات', button: 'اكتشف', link: '/products' }),
        item({ eyebrow: 'الأكثر مبيعاً', title: 'السماعات', subtitle: 'صوت نقي بدون أسلاك', button: 'اكتشف', link: '/products' }),
        item({ eyebrow: '-20%', title: 'الساعات الذكية', subtitle: 'صحتك على معصمك', button: 'اكتشف', link: '/products?sale=1' })] },
      { type: 'products', title: 'الأكثر مبيعاً', source: 'best', limit: '8', layout: 'carousel' },
      { type: 'features', bg: 'soft', items: [item({ icon: '🛡️', title: 'منتجات أصلية', text: 'مع ضمان حقيقي' }), item({ icon: '🚚', title: 'توصيل 24–72 ساعة', text: 'لكل المدن المغربية' }), item({ icon: '💵', title: 'الدفع عند الاستلام', text: 'افحص ثم ادفع' }), item({ icon: '🎧', title: 'دعم فني', text: 'نساعدك في الإعداد' })] },
      { type: 'products', title: 'وصل حديثاً', source: 'newest', limit: '8' },
      { type: 'logos', title: 'علامات نتعامل معها', items: [item({ name: 'BRAND 1' }), item({ name: 'BRAND 2' }), item({ name: 'BRAND 3' }), item({ name: 'BRAND 4' }), item({ name: 'BRAND 5' })] },
      { type: 'testimonials', title: 'آراء عملائنا', items: [say('أمين', 'طنجة', 'وصلني الهاتف في يومين، أصلي ومغلف. شكراً!'), say('هند', 'أكادير', 'سماعات ممتازة والسعر أحسن من المحلات.'), say('كريم', 'فاس', 'خدمة ما بعد البيع رائعة، ساعدوني في الإعداد.')] },
      { type: 'faq', title: 'أسئلة متكررة', items: [q('هل المنتجات أصلية؟', 'نعم، وكل منتج مع ضمان. اكتب هنا مدة الضمان وشروطه.'), q('كم يستغرق التوصيل؟', 'من 24 إلى 72 ساعة حسب مدينتك.'), q('هل يمكنني فحص المنتج قبل الدفع؟', 'نعم، تفحص الطلب أمام عامل التوصيل ثم تدفع.')] },
    ],
  },
  beauty: {
    label: 'تجميل وعناية', icon: '💄', group: 'store', desc: 'مستحضرات، عناية بالبشرة والشعر',
    style: { color: '#be185d', font: 'almarai', radius: 'round', theme: { mode: 'light', hfont: 'same', size: 'm', btn: 'solid', card: 'minimal', ratio: 'portrait', density: 'm', head: 'sticky' } },
    sections: [
      { type: 'marquee', style: 'light', items: [item({ text: '🌸 مكونات طبيعية' }), item({ text: '🚚 توصيل مجاني فوق 300 درهم' }), item({ text: '💵 الدفع عند الاستلام' })] },
      { type: 'hero', subtitle: 'عناية طبيعية تليق بجمالك. منتجات مختارة بعناية لبشرتك وشعرك.', button: 'اكتشفي المنتجات', link: '/products' },
      { type: 'categories', title: 'تسوّقي حسب احتياجك', items: [] },
      { type: 'products', title: 'المفضّلة لدى عميلاتنا', source: 'best', limit: '8' },
      { type: 'before_after', title: 'النتيجة تتكلم', subtitle: 'ارفعي صورتين حقيقيتين (بإذن صاحبتها) قبل وبعد الاستعمال.', before_label: 'قبل', after_label: 'بعد 4 أسابيع' },
      { type: 'image_text', eyebrow: 'لماذا نحن؟', title: 'مكونات تعرفينها', text: 'اكتبي هنا ما يميز منتجاتك: المكونات، بلد الصنع، طريقة الاستعمال، والنتائج التي يمكن أن تنتظرها العميلة.', side: 'start', bg: 'soft' },
      { type: 'testimonials', title: 'تجارب عميلاتنا', items: [say('سلمى', 'الرباط', 'بشرتي صارت أنعم من أول أسبوع.'), say('نادية', 'مراكش', 'التغليف راقٍ والتوصيل سريع.'), say('خديجة', 'وجدة', 'أفضل زيت أركان جربته.')] },
      { type: 'features', items: [item({ icon: '🌿', title: 'طبيعي 100%', text: 'بدون مواد ضارة' }), item({ icon: '🐰', title: 'لم يُجرَّب على الحيوانات', text: '' }), item({ icon: '💵', title: 'الدفع عند الاستلام', text: '' })] },
      { type: 'social', title: 'تابعينا لنصائح العناية اليومية' },
    ],
  },
  perfume: {
    label: 'عطور وفخامة', icon: '🕯️', group: 'store', desc: 'عطور، ساعات، مجوهرات',
    style: { color: '#a16207', font: 'plex', radius: 'sharp', theme: { mode: 'dark', hfont: 'amiri', size: 'm', btn: 'outline', card: 'minimal', ratio: 'portrait', density: 'l', head: 'sticky' } },
    sections: [
      { type: 'banner', title: 'عبق لا يُنسى', subtitle: 'عطور مختارة لمن يعرف قيمة التفاصيل', button: 'اكتشف المجموعة', link: '/products', height: 'l', align: 'center' },
      { type: 'image_text', eyebrow: 'قصتنا', title: 'فن صناعة العطر', text: 'احكِ هنا قصة علامتك: من أين تأتي مكوناتك، وكيف تختار عطورك، ولماذا يثق بك عملاؤك.', side: 'end' },
      { type: 'products', title: 'المجموعة المميزة', source: 'newest', limit: '4' },
      { type: 'promo_grid', columns: '2', items: [item({ eyebrow: 'للرجال', title: 'عطور رجالية', subtitle: 'خشبية، جلدية، شرقية', button: 'تسوّق', link: '/products' }), item({ eyebrow: 'للنساء', title: 'عطور نسائية', subtitle: 'زهرية، مسكية، فاكهية', button: 'تسوّق', link: '/products' })] },
      { type: 'features', items: [item({ icon: '✨', title: 'أصلي ومضمون', text: '' }), item({ icon: '🎁', title: 'تغليف فاخر للهدايا', text: '' }), item({ icon: '🚚', title: 'توصيل لكل المدن', text: '' })] },
      { type: 'testimonials', title: 'قالوا عنا', items: [say('ياسين', 'الدار البيضاء', 'العطر يدوم طول اليوم. تغليف رائع.'), say('ليلى', 'الرباط', 'هدية مثالية، أعجبت زوجي كثيراً.')] },
      { type: 'contact_form', title: 'تحتاج نصيحة لاختيار عطرك؟', subtitle: 'اكتب لنا ذوقك وسنقترح عليك الأنسب.', button: 'أرسل' },
    ],
  },
  natural: {
    label: 'منتجات طبيعية وبلدية', icon: '🍯', group: 'store', desc: 'عسل، أركان، أعشاب، منتجات تعاونيات',
    style: { color: '#a16207', font: 'almarai', radius: 'round', theme: { mode: 'cream', hfont: 'kufi', size: 'm', btn: 'solid', card: 'boxed', ratio: 'square', density: 'm', head: 'sticky' } },
    sections: [
      { type: 'hero', subtitle: 'من التعاونيات المغربية إلى بابك: عسل حر، زيت أركان، وأعشاب طبيعية.', button: 'تسوّق الآن', link: '/products' },
      { type: 'features', items: [item({ icon: '🐝', title: 'حر 100%', text: 'بدون إضافات' }), item({ icon: '🏔️', title: 'من الجبال المغربية', text: 'مباشرة من المنتج' }), item({ icon: '🧪', title: 'مُختبر', text: 'شهادات الجودة' })] },
      { type: 'products', title: 'منتجاتنا', source: 'newest', limit: '8' },
      { type: 'image_text', eyebrow: 'من أين يأتي؟', title: 'نعمل مع التعاونيات مباشرة', text: 'اكتب هنا عن المنتجين الذين تعمل معهم، والمنطقة، وطريقة الجني والتعبئة.', side: 'start', bg: 'soft' },
      { type: 'steps', title: 'كيف تطلب؟', items: [step('🛒', 'اختر منتجك', 'والكمية التي تريد'), step('📞', 'نتصل بك', 'لتأكيد الطلب'), step('🚚', 'يصلك الطلب', 'وتدفع عند الاستلام')] },
      { type: 'testimonials', title: 'آراء عملائنا', items: [say('الحاج محمد', 'سلا', 'عسل حقيقي كما كنا نعرفه في البادية.'), say('فاطمة', 'تطوان', 'زيت الأركان ممتاز للشعر.')] },
      { type: 'faq', title: 'أسئلة متكررة', items: [q('كيف أعرف أن العسل حر؟', 'اكتب هنا علامات الجودة والتحاليل التي تتوفر عليها.'), q('هل ترسلون خارج المغرب؟', 'اكتب هنا سياستك.')] },
    ],
  },
  salon: {
    label: 'صالون تجميل وسبا', icon: '💅', group: 'service', desc: 'خدمات، باقات، قبل/بعد، حجز',
    style: { color: '#9d174d', font: 'almarai', radius: 'round', theme: { mode: 'cream', hfont: 'amiri', size: 'm', btn: 'solid', card: 'boxed', ratio: 'portrait', density: 'm', head: 'sticky' } },
    sections: [
      { type: 'hero', subtitle: 'مساحتك للجمال والراحة. احجزي موعدك في دقيقة عبر واتساب.', button: 'احجزي موعدك', link: '#contact' },
      { type: 'services', title: 'خدماتنا', items: [
        item({ icon: '💇‍♀️', title: 'تصفيف وقص الشعر', text: 'قص، سشوار، تسريحات المناسبات', price: 'ابتداءً من 80 درهم', button: 'احجزي' }),
        item({ icon: '💆‍♀️', title: 'العناية بالبشرة', text: 'تنظيف عميق، ماسكات، تقشير', price: 'ابتداءً من 150 درهم', button: 'احجزي' }),
        item({ icon: '💅', title: 'مانيكير وباديكير', text: 'عادي، جل، بناء أظافر', price: 'ابتداءً من 70 درهم', button: 'احجزي' }),
        item({ icon: '🧖‍♀️', title: 'حمام مغربي', text: 'حمام تقليدي مع الصابون البلدي والغاسول', price: '200 درهم', button: 'احجزي' })] },
      { type: 'pricing', title: 'باقات العروس', bg: 'soft', items: [plan('الأساسية', '1500', '', 'تسريحة يوم العرس\nمكياج\nمانيكير'), plan('الذهبية', '3000', '', 'كل ما في الأساسية\nحمام مغربي\nعناية بالبشرة قبل العرس\nتسريحتان', { featured: 'yes' }), plan('الملكية', '5000', '', 'كل ما في الذهبية\nثلاث مناسبات\nخدمة في المنزل')] },
      { type: 'before_after', title: 'من أعمالنا', before_label: 'قبل', after_label: 'بعد' },
      { type: 'gallery', title: 'أجواء الصالون', columns: '3', items: [] },
      { type: 'hours', title: 'أوقات العمل والعنوان', items: [day('الثلاثاء – الأحد', '10:00 – 20:00'), day('الإثنين', 'مغلق')] },
      { type: 'contact_cta', title: 'احجزي موعدك الآن', text: 'اكتبي لنا الخدمة واليوم المناسب لك.', button: 'احجزي عبر واتساب', mode: 'whatsapp', message: 'مرحباً، أريد حجز موعد. الخدمة: … اليوم: …' },
    ],
  },
  agency: {
    label: 'وكالة / خدمات احترافية', icon: '🚀', group: 'service', desc: 'تسويق، تصميم، برمجة، استشارات',
    style: { color: '#6d28d9', font: 'plex', radius: 'soft', theme: { mode: 'light', hfont: 'cairo', size: 'm', btn: 'gradient', card: 'shadow', ratio: 'landscape', density: 'm', head: 'sticky' } },
    sections: [
      { type: 'hero', subtitle: 'نساعد الشركات المغربية على النمو عبر الإنترنت: مواقع، إعلانات، ومحتوى يبيع.', button: 'احصل على استشارة مجانية', link: '#contact-form' },
      { type: 'logos', title: 'وثق بنا', items: [item({ name: 'CLIENT A' }), item({ name: 'CLIENT B' }), item({ name: 'CLIENT C' }), item({ name: 'CLIENT D' }), item({ name: 'CLIENT E' })] },
      { type: 'services', title: 'ماذا نقدّم', items: [
        item({ icon: '🎨', title: 'الهوية البصرية', text: 'شعار، ألوان، ودليل استعمال' }),
        item({ icon: '💻', title: 'المواقع والمتاجر', text: 'سريعة، جميلة، وتظهر في Google' }),
        item({ icon: '📣', title: 'إعلانات فيسبوك وتيك توك', text: 'حملات تُقاس بالمبيعات' }),
        item({ icon: '🎬', title: 'المحتوى والفيديو', text: 'تصوير ومونتاج للشبكات الاجتماعية' })] },
      { type: 'stats', bg: 'dark', items: [item({ value: '+120', label: 'مشروع منجز' }), item({ value: '+60', label: 'عميل راضٍ' }), item({ value: '8', label: 'سنوات من الخبرة' }), item({ value: '24h', label: 'وقت الرد' })] },
      { type: 'steps', title: 'كيف نعمل', items: [step('☕', 'نتعرف عليك', 'جلسة مجانية لفهم هدفك'), step('🧭', 'نقترح خطة', 'بأهداف وميزانية واضحة'), step('⚙️', 'ننفذ', 'مع تقارير أسبوعية'), step('📈', 'نقيس ونحسّن', 'حتى تصل للنتيجة')] },
      { type: 'pricing', title: 'باقاتنا', items: [plan('انطلاقة', '2900', '/ شهر', 'إدارة صفحتين\n12 منشوراً\nتقرير شهري'), plan('نمو', '5900', '/ شهر', 'كل ما في الانطلاقة\nإعلانات ممولة\n4 فيديوهات قصيرة\nمكالمة أسبوعية', { featured: 'yes' }), plan('شركات', 'حسب الطلب', '', 'فريق مخصص\nاستراتيجية كاملة', { button: 'تواصل معنا' })] },
      { type: 'testimonials', title: 'ماذا يقول عملاؤنا', items: [say('مدير شركة X', 'الدار البيضاء', 'تضاعفت طلباتنا في ثلاثة أشهر.'), say('صاحبة متجر Y', 'الرباط', 'فريق محترف ويحترم المواعيد.')] },
      { type: 'faq', title: 'أسئلة متكررة', items: [q('هل الاستشارة الأولى مجانية؟', 'نعم، 30 دقيقة لفهم مشروعك.'), q('هل هناك عقد؟', 'اكتب هنا مدة الالتزام وشروطه.')] },
      { type: 'contact_form', title: 'لنتحدث عن مشروعك', subtitle: 'اترك رقمك وسنتصل بك خلال 24 ساعة.', button: 'أرسل طلبي', bg: 'soft' },
    ],
  },
  coach: {
    label: 'دورات وتدريب', icon: '🎓', group: 'service', desc: 'مدرب، أستاذ، دورات أونلاين أو حضورية',
    style: { color: '#0e7490', font: 'tajawal', radius: 'soft', theme: { mode: 'light', hfont: 'kufi', size: 'm', btn: 'solid', card: 'boxed', ratio: 'landscape', density: 'm', head: 'sticky' } },
    sections: [
      { type: 'hero', subtitle: 'تعلّم المهارة التي تغيّر مسارك، خطوة بخطوة ومع متابعة شخصية.', button: 'سجّل الآن', link: '#pricing' },
      { type: 'stats', items: [item({ value: '+800', label: 'متدرب' }), item({ value: '4.9★', label: 'تقييم المتدربين' }), item({ value: '30', label: 'درساً عملياً' })] },
      { type: 'image_text', eyebrow: 'عن المدرب', title: 'من أنا؟', text: 'عرّف بنفسك وبخبرتك وبالنتائج التي حققها متدربوك.', side: 'start' },
      { type: 'steps', title: 'ماذا ستتعلم؟', items: [step('1', 'الأساسيات', 'ابدأ من الصفر'), step('2', 'التطبيق', 'مشاريع حقيقية'), step('3', 'الاحتراف', 'أسرار المهنة'), step('🏆', 'الشهادة', 'بعد إتمام الدورة')] },
      { type: 'pricing', title: 'اختر طريقتك', bg: 'soft', items: [plan('أونلاين', '490', '', 'كل الدروس المسجلة\nمجموعة دعم\nشهادة'), plan('مع المتابعة', '990', '', 'كل ما في أونلاين\n4 جلسات مباشرة\nتصحيح المشاريع', { featured: 'yes' }), plan('حضوري', '1900', '', 'تكوين في القاعة\nمجموعات صغيرة\nشهادة')] },
      { type: 'testimonials', title: 'قصص نجاح', items: [say('يونس', 'مكناس', 'بعد الدورة حصلت على أول عميل لي.'), say('سارة', 'القنيطرة', 'شرح واضح ومتابعة رائعة.')] },
      { type: 'faq', title: 'أسئلة متكررة', items: [q('هل أحتاج خبرة سابقة؟', 'لا، الدورة تبدأ من الصفر.'), q('كيف أدفع؟', 'تحويل بنكي أو وكالة أو بطاقة، حسب ما فعّلته في «الدفع».')] },
      { type: 'contact_cta', title: 'عندك سؤال قبل التسجيل؟', text: 'راسلنا ونجيبك في نفس اليوم.', button: 'اسألنا عبر واتساب', mode: 'whatsapp', message: 'مرحباً، عندي سؤال عن الدورة.' },
    ],
  },
  landing_pro: {
    label: 'صفحة هبوط احترافية', icon: '🔥', group: 'landing', desc: 'منتج واحد بأقوى عناصر الإقناع',
    style: { color: '#b91c1c', font: 'cairo', radius: 'round', theme: { mode: 'light', hfont: 'same', size: 'l', btn: 'gradient', card: 'shadow', ratio: 'square', density: 's', head: 'static' } },
    sections: [
      { type: 'marquee', style: 'brand', speed: 'fast', items: [item({ text: '🔥 عرض محدود' }), item({ text: '💵 الدفع عند الاستلام' }), item({ text: '🚚 توصيل لكل المدن' })] },
      { type: 'product_hero', eyebrow: '⭐ أكثر من 1000 عميل راضٍ', subtitle: 'جملتان قويتان: ما المشكلة التي يحلها المنتج، وما النتيجة التي سيحصل عليها العميل.', button: 'اطلب الآن · الدفع عند الاستلام' },
      { type: 'countdown', title: '⏳ ينتهي العرض خلال' },
      { type: 'before_after', title: 'شاهد الفرق بنفسك', before_label: 'قبل', after_label: 'بعد' },
      { type: 'features', title: 'لماذا يختاره الجميع؟', bg: 'soft', items: [item({ icon: '✅', title: 'الفائدة الأولى', text: 'اشرحها في جملة' }), item({ icon: '⚡', title: 'الفائدة الثانية', text: 'اشرحها في جملة' }), item({ icon: '💎', title: 'الفائدة الثالثة', text: 'اشرحها في جملة' })] },
      { type: 'steps', title: 'طريقة الاستعمال', items: [step('1', 'الخطوة الأولى', ''), step('2', 'الخطوة الثانية', ''), step('3', 'النتيجة', '')] },
      { type: 'testimonials', title: 'آراء عملائنا', items: [say('اسم العميل', 'المدينة', 'ضع هنا رأياً حقيقياً (احذف القسم إن لم تكن لديك آراء بعد).')] },
      { type: 'faq', title: 'أسئلة متكررة', items: [q('متى أدفع؟', 'عند استلام الطلب.'), q('كم يستغرق التوصيل؟', 'من 24 إلى 72 ساعة.'), q('هل يمكنني الإرجاع؟', 'اكتب سياستك هنا.')] },
      { type: 'order_form', title: 'اطلب الآن قبل نفاد الكمية', subtitle: 'املأ معلوماتك وسنتصل بك للتأكيد.', button: 'تأكيد الطلب', bg: 'soft' },
    ],
  },
});
const GROUPS = { store: '🛍️ متاجر', service: '🧰 خدمات وأنشطة', landing: '🎯 صفحات هبوط' };
for (const p of Object.values(PRESETS)) p.sections = sanitize(p.sections);

const DEFAULT_HOME = PRESETS.classic.sections;

// YouTube URL -> video id (or '').
function youtubeId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : '';
}

module.exports = { SCHEMA, PRESETS, GROUPS, PRO_TYPES, proUsage, stripPro, DEFAULT_HOME, sanitize, cleanLink, youtubeId };
