// The offline stylist: a scoring engine that works with no AI at all.
// The AI stylist (ai.js) is preferred when available; this is the fallback and the safety net.
import { daysSince } from './util.js';
import { dressingTemp } from './weather.js';

export const CATEGORIES = {
  top: 'Tops',
  bottom: 'Bottoms',
  onepiece: 'Dresses & sets',
  layer: 'Layers',
  footwear: 'Footwear',
  accessory: 'Accessories',
};
export const CATEGORY_HINT = {
  top: 'shirt, tee, blouse, kurta top, sweater',
  bottom: 'jeans, trousers, skirt, shorts, churidar',
  onepiece: 'dress, jumpsuit, saree, kurta set, suit worn as one',
  layer: 'jacket, blazer, coat, cardigan, shawl, hoodie',
  footwear: 'shoes, sneakers, sandals, boots, juttis',
  accessory: 'bag, belt, scarf, watch, jewellery, cap, sunglasses',
};

export const OCCASIONS = [
  { id: 'casual', label: 'Casual day', formality: 2 },
  { id: 'work', label: 'Work', formality: 3.5 },
  { id: 'date', label: 'Date night', formality: 3 },
  { id: 'party', label: 'Party', formality: 3.5 },
  { id: 'festive', label: 'Wedding / festive', formality: 4.5 },
  { id: 'formal', label: 'Formal event', formality: 5 },
  { id: 'travel', label: 'Travel', formality: 2 },
  { id: 'workout', label: 'Workout', formality: 1 },
  { id: 'lounge', label: 'At home', formality: 1 },
];
export const SEASONS = ['summer', 'monsoon', 'autumn', 'winter', 'spring'];

const NEUTRALS = new Set(['black', 'white', 'grey', 'gray', 'charcoal', 'navy', 'denim', 'beige', 'cream', 'ivory', 'off-white',
  'tan', 'khaki', 'brown', 'camel', 'olive', 'taupe', 'silver', 'gold', 'nude', 'stone', 'light blue']);
const RAIN_UNFRIENDLY = /suede|silk|velvet|canvas|nubuck|satin/i;

export function targetWarmth(tempC) {
  if (tempC >= 31) return 1;
  if (tempC >= 25) return 2;
  if (tempC >= 18) return 3;
  if (tempC >= 10) return 4;
  return 5;
}

export function weatherNeeds(day) {
  const t = dressingTemp(day);
  return {
    temp: t,
    warmth: targetWarmth(t),
    layer: t < 20 || (day.max - day.min >= 10 && day.feelsMin < 18),
    rain: day.rainChance >= 50,
    sun: day.uv >= 7,
    wind: day.wind >= 35,
  };
}

export function weatherAdvice(day) {
  const n = weatherNeeds(day);
  const bits = [];
  if (n.warmth === 1) bits.push('Hot — breathable cotton or linen, loose fits, light colours.');
  else if (n.warmth === 2) bits.push('Warm — light fabrics; skip heavy layers.');
  else if (n.warmth === 3) bits.push('Mild — easy to dress for; one light layer is plenty.');
  else if (n.warmth === 4) bits.push('Cool — wear a proper layer you can take off indoors.');
  else bits.push('Cold — insulate: knit, coat, closed shoes.');
  if (n.layer && n.warmth <= 3) bits.push('Carry a light layer for the evening.');
  if (n.rain) bits.push(`${day.rainChance}% rain — closed or waterproof shoes, and avoid suede.`);
  if (n.sun) bits.push('Strong sun — sunglasses and a cap help.');
  if (n.wind) bits.push('Windy — skip flowy pieces and hats that fly.');
  return bits.join(' ');
}

const colorsOf = (item) => (item.colors || []).map((c) => String(c).toLowerCase().trim()).filter(Boolean);
const isNeutral = (c) => NEUTRALS.has(c) || /black|white|grey|gray|navy|beige|cream|denim/.test(c);

function colorPenalty(pieces) {
  const loud = new Set();
  for (const p of pieces) for (const c of colorsOf(p).slice(0, 1)) if (!isNeutral(c)) loud.add(c);
  let pen = 0;
  if (loud.size > 2) pen += 2.5;
  else if (loud.size === 2) pen += 0.8;
  const patterned = pieces.filter((p) => p.pattern && !/solid|plain|none/i.test(p.pattern) && p.category !== 'accessory');
  if (patterned.length > 1) pen += 1.5;
  return pen;
}

function itemScore(item, ctx) {
  const { needs, occasion, offset } = ctx;
  let s = 0;
  const w = item.warmth ?? 3;
  const f = item.formality ?? 3;
  // Layers are judged by whether you need one at all; the base outfit carries the temperature.
  if (item.category === 'layer') s -= Math.abs(w - Math.max(needs.warmth, 2)) * 0.8;
  else if (item.category !== 'accessory') s -= Math.abs(w - needs.warmth) * 1.2;
  s -= Math.abs(f - occasion.formality) * 1.1;
  if ((item.occasions || []).includes(occasion.id)) s += 1.5;
  if (needs.rain && (item.category === 'footwear' || item.category === 'layer')) {
    if (item.waterproof) s += 1.5;
    if (RAIN_UNFRIENDLY.test(`${item.material} ${item.name}`)) s -= 2;
  }
  if (needs.rain && item.category === 'bottom' && /white|cream|linen/i.test(`${colorsOf(item)} ${item.material}`)) s -= 0.6;
  const since = daysSince(item.lastWorn);
  if (since <= 1 + offset) s -= 2.5;
  else if (since <= 4) s -= 1;
  if (item.favorite) s += 0.6;
  s += Math.random() * 0.6; // a little variety between taps
  return s;
}

const top = (list, n) => list.slice().sort((a, b) => b._s - a._s).slice(0, n);

/**
 * Returns up to `count` outfits: [{ title, items:[item], why, tip }] and a `missing` note.
 */
export function suggestOffline(items, day, occasionId, { count = 3, dayOffset = 0 } = {}) {
  const occasion = OCCASIONS.find((o) => o.id === occasionId) || OCCASIONS[0];
  const needs = weatherNeeds(day);
  const ctx = { needs, occasion, offset: dayOffset };
  const by = {};
  for (const it of items) {
    const scored = { ...it, _s: itemScore(it, ctx) };
    (by[it.category] ||= []).push(scored);
  }
  const tops = top(by.top || [], 5);
  const bottoms = top(by.bottom || [], 5);
  const ones = top(by.onepiece || [], 4);
  const shoes = top(by.footwear || [], 3);
  const layers = top(by.layer || [], 3);
  const accs = top(by.accessory || [], 3);

  const bases = [];
  for (const t of tops) for (const b of bottoms) bases.push([t, b]);
  for (const o of ones) bases.push([o]);

  const combos = [];
  for (const base of bases) {
    const shoeOpts = shoes.length ? shoes : [null];
    for (const sh of shoeOpts) {
      const pieces = [...base, sh].filter(Boolean);
      if (needs.layer && layers.length) {
        pieces.push(layers.find((l) => colorPenalty([...pieces, l]) < 1.5) || layers[0]);
      }
      const acc = accs.find((a) => colorPenalty([...pieces, a]) < 1.5);
      if (acc && (occasion.formality >= 3 || needs.sun)) pieces.push(acc);
      const score = pieces.reduce((a, p) => a + p._s, 0) / pieces.length - colorPenalty(pieces);
      combos.push({ pieces, score });
    }
  }
  combos.sort((a, b) => b.score - a.score);

  // Prefer outfits that don't share their main pieces.
  const chosen = [];
  const used = new Set();
  for (const c of combos) {
    const core = c.pieces.filter((p) => p.category !== 'footwear' && p.category !== 'accessory' && p.category !== 'layer');
    if (chosen.length && core.some((p) => used.has(p.id))) continue;
    core.forEach((p) => used.add(p.id));
    chosen.push(c);
    if (chosen.length >= count) break;
  }
  // If the closet is small, allow overlaps rather than returning nothing.
  for (const c of combos) {
    if (chosen.length >= count) break;
    if (!chosen.includes(c)) chosen.push(c);
  }

  const missing = [];
  if (!tops.length && !ones.length) missing.push('tops or dresses');
  if (!ones.length && !bottoms.length) missing.push('bottoms');
  if (!shoes.length) missing.push('footwear');
  if (needs.layer && !layers.length) missing.push('a layer (jacket, cardigan or shawl)');
  if (needs.rain && shoes.length && !shoes.some((s) => s.waterproof)) missing.push('rain-proof shoes');

  const outfits = chosen.map((c, i) => ({
    title: titleFor(c.pieces, occasion, i),
    items: c.pieces.map(({ _s, ...rest }) => rest),
    why: whyFor(c.pieces, needs, occasion),
    tip: tipFor(needs, occasion),
  }));

  return { outfits, missing: missing.length ? `Add ${missing.join(', ')} to your closet for fuller looks.` : '' };
}

function titleFor(pieces, occasion, i) {
  const main = pieces[0];
  const names = ['The pick', 'Plan B', 'Something different'];
  return `${names[i] || 'Option'}: ${main?.name || 'outfit'} for ${occasion.label.toLowerCase()}`;
}

function whyFor(pieces, needs, occasion) {
  const words = ['', 'very light', 'light', 'mid-weight', 'warm', 'heavy'];
  const parts = [`Built around ${words[needs.warmth]} pieces for about ${Math.round(needs.temp)}°C`];
  parts.push(`pitched at the right dressiness for ${occasion.label.toLowerCase()}`);
  if (pieces.some((p) => p.category === 'layer')) parts.push('with a layer for the cooler hours');
  const colors = [...new Set(pieces.flatMap((p) => colorsOf(p).slice(0, 1)))];
  if (colors.length) parts.push(`colours kept to ${colors.slice(0, 3).join(', ')}`);
  return parts.join(', ') + '.';
}

function tipFor(needs, occasion) {
  if (needs.rain) return 'Roll the hem up a turn so it stays out of puddles.';
  if (needs.sun) return 'Add sunglasses — UV is high today.';
  if (needs.warmth >= 4) return 'Tuck the base layer in to hold the warmth.';
  if (occasion.formality >= 4) return 'A pressed finish makes this; give it five minutes with the iron.';
  if (needs.warmth <= 1) return 'Pick the loosest fit you own of each piece — airflow beats everything.';
  return 'A half-tuck on the top sharpens this without trying too hard.';
}
