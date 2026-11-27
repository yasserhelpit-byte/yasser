// "Launch an ad" assistant: Claude writes a Meta ad (copy, image choice, audience) and landing-page copy
// for one product. Uses the platform owner's Anthropic API key (ANTHROPIC_API_KEY on the server).
// Without a key it returns a clearly-labelled demo ad so the flow can be tried end to end.
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const sdk = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { uploadsDir } = require('./uploads');

const Anthropic = sdk.default || sdk.Anthropic;
const MODEL = 'claude-opus-5-5';
// USD per million tokens for MODEL (input / output). Used for the admin's spend tracking.
const PRICE = { input: 4, output: 20 };

const LANGUAGES = {
  darija: { label: 'الدارجة المغربية', prompt: 'Moroccan Darija written in Arabic script (natural, the way Moroccans write on Facebook; a few common French loanwords are fine)' },
  fusha: { label: 'العربية الفصحى', prompt: 'Modern Standard Arabic, simple and warm' },
  fr: { label: 'Français', prompt: 'French, as used in Moroccan e-commerce' },
};
const CTAS = { SHOP_NOW: 'تسوّق الآن', ORDER_NOW: 'اطلب الآن', LEARN_MORE: 'اعرف المزيد' };

const AdSchema = z.object({
  primary_text: z.string().describe('Main ad text shown above the image. 3-6 short lines, a few emojis, ends with a call to action.'),
  headline: z.string().describe('Short headline under the image, max ~40 characters.'),
  description: z.string().describe('Very short line under the headline, max ~30 characters (e.g. price / COD).'),
  cta: z.enum(['SHOP_NOW', 'ORDER_NOW', 'LEARN_MORE']),
  image_index: z.number().int().describe('0-based index of the best product image for the ad.'),
  audience: z.object({
    age_min: z.number().int(),
    age_max: z.number().int(),
    gender: z.enum(['all', 'women', 'men']),
    interests: z.array(z.string()).describe('Up to 6 Meta interest names, in English.'),
    cities: z.array(z.string()).describe('Moroccan cities to target, or empty for the whole country.'),
  }),
  strategy: z.string().describe('2 sentences for the merchant, in the ad language, explaining the angle and audience choice.'),
  landing: z.object({
    eyebrow: z.string().describe('Short badge above the title, e.g. "🔥 ..."; no fake claims.'),
    headline: z.string(),
    subtitle: z.string().describe('2-3 persuasive sentences.'),
    benefits: z.array(z.object({ icon: z.string().describe('one emoji'), title: z.string(), text: z.string() })).describe('Exactly 3.'),
    faq: z.array(z.object({ q: z.string(), a: z.string() })).describe('3 questions a buyer would ask about THIS product.'),
  }),
});

const SYSTEM = `You write Meta (Facebook + Instagram) ads for small Moroccan online stores that sell with cash on delivery (COD).
You get one product (name, description, price, options, photos) and the store's delivery facts. Produce one ready-to-run ad and the copy for its landing page.

Write to sell, but stay honest and within Meta's advertising policies:
- Only state facts that are in the product data or clearly visible in the photos. Never invent features, materials, results, reviews, awards or guarantees.
- No medical, health, weight-loss or financial-gain claims. No before/after promises.
- Don't assert or imply personal attributes of the viewer (e.g. not "Are you overweight?", "Struggling with debt?").
- No fake urgency or scarcity: mention a discount only if a compare-at price is given, and stock limits only if stock is low in the data.
- Always mention cash on delivery. Mention the price. Mention delivery terms exactly as given.
- Keep it readable on a phone: short lines, a few relevant emojis, no hashtags walls.

Audience: people in Morocco. Pick a realistic age range for the product. Choose gender only if the product is clearly for one gender. Interests must be real Meta interest names in English. Leave cities empty unless the product is clearly local.`;

let client = null;
function getClient() {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return client;
}
const isConfigured = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const IMG_TYPES = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
// Up to 3 product photos as image blocks (uploaded files are read from disk; other URLs passed by URL).
function imageBlocks(images) {
  return images.slice(0, 3).map((src) => {
    const m = src.match(/^\/uploads\/([a-f0-9]{32}\.(jpg|png|webp|gif))$/);
    if (m) {
      const file = path.join(uploadsDir, m[1]);
      if (!fs.existsSync(file)) return null;
      return { type: 'image', source: { type: 'base64', media_type: IMG_TYPES[path.extname(file)], data: fs.readFileSync(file).toString('base64') } };
    }
    return /^https:\/\//.test(src) ? { type: 'image', source: { type: 'url', url: src } } : null;
  }).filter(Boolean);
}

function productBrief({ store, product, images, language }) {
  const opts = JSON.parse(product.options || '[]');
  const lines = [
    `Write everything in: ${LANGUAGES[language].prompt}.`,
    '',
    `Store: ${store.name}${store.city ? ` (based in ${store.city})` : ''}`,
    `Product: ${product.name}`,
    product.category ? `Category: ${product.category}` : '',
    `Price: ${product.price} ${store.currency}`,
    product.compare_price > product.price ? `Compare-at price (before discount): ${product.compare_price} ${store.currency}` : 'No discount.',
    opts.length ? `Options: ${opts.map((o) => `${o.name}: ${o.values.join(', ')}`).join(' | ')}` : '',
    `Stock: ${product.stock}${product.stock <= 5 ? ' (low)' : ''}`,
    `Delivery: ${store.shipping_fee > 0 ? `${store.shipping_fee} ${store.currency}` : 'free'}${store.free_shipping_over > 0 ? `, free over ${store.free_shipping_over} ${store.currency}` : ''}. Payment: cash on delivery.`,
    '',
    `Description:\n${product.description || '(none: rely on the name and photos)'}`,
    '',
    images.length ? `${images.length} product photo(s) attached, in order (index 0 = first).` : 'No photos.',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

// Returns { ad, usage: { input, output, cost }, demo }. Throws Error with a user-facing Arabic message on failure.
async function generateAd({ store, product, language = 'darija' }) {
  if (!LANGUAGES[language]) language = 'darija';
  const images = JSON.parse(product.images || '[]').length ? JSON.parse(product.images) : product.image_url ? [product.image_url] : [];
  if (!isConfigured()) return { ad: demoAd({ store, product, images, language }), usage: { input: 0, output: 0, cost: 0 }, demo: true };

  const content = [...imageBlocks(images), { type: 'text', text: productBrief({ store, product, images, language }) }];
  let response;
  try {
    response = await getClient().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // Server-side fallback: if the model declines, the API retries on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: zodOutputFormat(AdSchema) },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    console.error('Claude ad generation failed:', err.status || '', err.message);
    const busy = err.status === 429 || err.status === 529 || err.status >= 500;
    throw new Error(busy ? 'خدمة الذكاء الاصطناعي مشغولة حالياً. أعد المحاولة بعد دقيقة.' : 'تعذّر إنشاء الإعلان. أعد المحاولة لاحقاً.');
  }
  const usage = {
    input: response.usage?.input_tokens || 0,
    output: response.usage?.output_tokens || 0,
  };
  usage.cost = (usage.input * PRICE.input + usage.output * PRICE.output) / 1e6;
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    const e = new Error('لم نتمكن من كتابة إعلان لهذا المنتج. تأكد أن وصفه وصوره مناسبة للإعلان على فيسبوك.');
    e.usage = usage;
    throw e;
  }
  return { ad: tidy(response.parsed_output, images.length), usage, demo: false };
}

// Clamp lengths and ranges so a slightly-off answer still produces a valid ad.
function tidy(ad, imageCount) {
  const cut = (s, n) => String(s || '').trim().slice(0, n);
  return {
    primary_text: cut(ad.primary_text, 1200),
    headline: cut(ad.headline, 60),
    description: cut(ad.description, 60),
    cta: CTAS[ad.cta] ? ad.cta : 'ORDER_NOW',
    image_index: Math.min(Math.max(0, ad.image_index | 0), Math.max(0, imageCount - 1)),
    audience: {
      age_min: Math.min(Math.max(18, ad.audience.age_min | 0), 65),
      age_max: Math.min(Math.max(ad.audience.age_min | 0, ad.audience.age_max | 0, 18), 65),
      gender: ['all', 'women', 'men'].includes(ad.audience.gender) ? ad.audience.gender : 'all',
      interests: (ad.audience.interests || []).slice(0, 6).map((s) => cut(s, 60)),
      cities: (ad.audience.cities || []).slice(0, 10).map((s) => cut(s, 40)),
    },
    strategy: cut(ad.strategy, 500),
    landing: {
      eyebrow: cut(ad.landing.eyebrow, 40),
      headline: cut(ad.landing.headline, 120),
      subtitle: cut(ad.landing.subtitle, 400),
      benefits: (ad.landing.benefits || []).slice(0, 3).map((b) => ({ icon: cut(b.icon, 4), title: cut(b.title, 60), text: cut(b.text, 120) })),
      faq: (ad.landing.faq || []).slice(0, 5).map((f) => ({ q: cut(f.q, 200), a: cut(f.a, 600) })),
    },
  };
}

// Demo ad used when no API key is configured (so the flow can be tried in development).
function demoAd({ store, product, images, language }) {
  const price = `${product.price} ${store.currency}`;
  const fr = language === 'fr';
  return tidy({
    primary_text: fr
      ? `✨ ${product.name}\n\n💰 Prix : ${price}\n🚚 Livraison partout au Maroc\n💵 Paiement à la livraison\n\n👉 Commandez maintenant !`
      : `✨ ${product.name}\n\n💰 الثمن: ${price}\n🚚 التوصيل لجميع المدن\n💵 الخلاص عند الاستلام\n\n👉 اطلب دابا!`,
    headline: product.name,
    description: fr ? 'Paiement à la livraison' : 'الدفع عند الاستلام',
    cta: 'ORDER_NOW',
    image_index: 0,
    audience: { age_min: 20, age_max: 45, gender: 'all', interests: ['Online shopping'], cities: [] },
    strategy: 'هذا إعلان تجريبي لأن مفتاح Claude غير مضبوط بعد. بعد ضبطه سيكتب Claude إعلاناً حقيقياً مخصصاً لمنتجك.',
    landing: {
      eyebrow: '✨ جديد',
      headline: product.name,
      subtitle: product.description ? product.description.slice(0, 300) : `اطلب ${product.name} الآن والدفع عند الاستلام.`,
      benefits: [
        { icon: '💵', title: 'الدفع عند الاستلام', text: 'لا تدفع حتى يصلك طلبك' },
        { icon: '🚚', title: 'توصيل لكل المدن', text: 'إلى باب منزلك' },
        { icon: '📞', title: 'نتصل بك للتأكيد', text: 'قبل الشحن' },
      ],
      faq: [
        { q: 'متى أدفع؟', a: 'تدفع نقداً عند استلام طلبك.' },
        { q: 'كم يستغرق التوصيل؟', a: 'من 24 إلى 72 ساعة حسب مدينتك.' },
      ],
    },
  }, images.length);
}

module.exports = { generateAd, isConfigured, LANGUAGES, CTAS, MODEL };
