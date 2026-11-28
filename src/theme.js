// Storefront-wide style options ("الأسلوب" tab), stored as JSON in stores.theme.
// Every option is a fixed list, so values can go straight into class names and CSS.

const OPTIONS = {
  mode: { label: 'ألوان الخلفية', options: { light: '☀️ فاتح', cream: '🥐 كريمي دافئ', dark: '🌙 داكن', auto: '🖥️ حسب جهاز الزائر' } },
  hfont: { label: 'خط العناوين', options: { same: 'نفس الخط' } }, // filled with the fonts list by the server
  size: { label: 'حجم النص', options: { m: 'عادي', s: 'صغير', l: 'كبير' } },
  btn: { label: 'شكل الأزرار', options: { solid: 'ممتلئ', gradient: 'متدرّج', outline: 'بحدود', soft: 'ناعم' } },
  card: { label: 'بطاقة المنتج', options: { plain: 'بسيطة', boxed: 'بإطار', shadow: 'بظل', minimal: 'أنيقة (في الوسط)' } },
  ratio: { label: 'شكل صور المنتجات', options: { portrait: 'طولية', square: 'مربعة', landscape: 'عرضية' } },
  density: { label: 'المسافة بين الأقسام', options: { m: 'عادية', s: 'متقاربة', l: 'واسعة' } },
  head: { label: 'رأس الصفحة عند التمرير', options: { sticky: 'يبقى ظاهراً', static: 'يختفي' } },
};

// One-click combinations shown above the options.
const KITS = {
  modern: { label: 'عصري', icon: '⚡', theme: { mode: 'light', hfont: 'same', size: 'm', btn: 'solid', card: 'plain', ratio: 'portrait', density: 'm', head: 'sticky' }, font: 'tajawal', radius: 'soft' },
  luxury: { label: 'فاخر', icon: '👑', theme: { mode: 'dark', hfont: 'amiri', size: 'm', btn: 'outline', card: 'minimal', ratio: 'portrait', density: 'l', head: 'sticky' }, font: 'plex', radius: 'sharp' },
  warm: { label: 'دافئ', icon: '🌿', theme: { mode: 'cream', hfont: 'kufi', size: 'm', btn: 'soft', card: 'boxed', ratio: 'square', density: 'm', head: 'sticky' }, font: 'almarai', radius: 'round' },
  bold: { label: 'جريء', icon: '🔥', theme: { mode: 'light', hfont: 'cairo', size: 'l', btn: 'gradient', card: 'shadow', ratio: 'square', density: 's', head: 'sticky' }, font: 'cairo', radius: 'round' },
};

function withFonts(fonts) {
  OPTIONS.hfont.options = { same: 'نفس الخط', ...Object.fromEntries(Object.entries(fonts).map(([k, f]) => [k, f.label.split(' · ')[0]])) };
  return OPTIONS;
}

// From stored JSON or a form body (fields named t_<key>) to a clean theme object.
function sanitize(input) {
  let src = input;
  if (typeof src === 'string') { try { src = JSON.parse(src || '{}'); } catch { src = {}; } }
  src = src || {};
  const out = {};
  for (const [k, def] of Object.entries(OPTIONS)) {
    const v = String(src[`t_${k}`] ?? src[k] ?? '');
    out[k] = Object.hasOwn(def.options, v) ? v : Object.keys(def.options)[0];
  }
  return out;
}

// Free plans keep the default look (these options are a paid feature); returns the labels that differ.
const DEFAULTS = Object.fromEntries(Object.entries(OPTIONS).map(([k, d]) => [k, Object.keys(d.options)[0]]));
const proChanges = (t) => Object.keys(OPTIONS).filter((k) => t[k] !== DEFAULTS[k]).map((k) => OPTIONS[k].label);

// Classes for the storefront wrapper.
const classes = (t) => ['mode', 'btn', 'card', 'ratio', 'density', 'head'].map((k) => `t-${k}-${t[k]}`).join(' ');

module.exports = { OPTIONS, KITS, DEFAULTS, withFonts, sanitize, classes, proChanges };
