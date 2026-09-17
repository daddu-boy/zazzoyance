// AI stylist. Two routes to OpenAI, tried in this order:
//   1. The host's server key, via /api/ai (Netlify edge function) — nothing to set up on the phone.
//   2. A key the user pasted into Settings — the browser calls OpenAI directly.
// If neither is available, the app falls back to the offline stylist.
import { kvGet } from './db.js';
import { blobToDataURL, daysSince } from './util.js';
import { CATEGORIES, CATEGORY_HINT, OCCASIONS, SEASONS } from './stylist.js';

const DEFAULT_MODEL = 'gpt-5-mini';
let serverInfo = null;

export async function settings() {
  return kvGet('settings', {});
}

export async function checkServer(force = false) {
  if (serverInfo && !force) return serverInfo;
  try {
    const r = await fetch('/api/ai', { method: 'GET', cache: 'no-store' });
    const j = r.ok ? await r.json() : {};
    serverInfo = { configured: !!j.configured, passcode: !!j.passcode, model: j.model || null };
  } catch {
    serverInfo = { configured: false, passcode: false, model: null };
  }
  return serverInfo;
}

/** 'server' | 'key' | 'off' */
export async function mode() {
  const s = await settings();
  if (s.apiKey) return 'key'; // a personal key always wins — the user chose it
  const srv = await checkServer();
  if (srv.configured && (!srv.passcode || s.passcode)) return 'server';
  return 'off';
}

const isReasoning = (m) => /^(gpt-5|o\d)/.test(m);

async function complete(messages, { json = false, effort = 'low', maxTokens = 6000 } = {}) {
  const s = await settings();
  const m = await mode();
  if (m === 'off') throw new AIOff();
  const model = s.model?.trim() || (m === 'server' && serverInfo?.model) || DEFAULT_MODEL;
  const body = { model, messages };
  if (json) body.response_format = { type: 'json_object' };
  if (isReasoning(model)) {
    body.reasoning_effort = effort;
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = Math.min(maxTokens, 2000);
    body.temperature = 0.7;
  }

  let r;
  if (m === 'server') {
    r = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-passcode': s.passcode || '' },
      body: JSON.stringify(body),
    });
  } else {
    try {
      r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch {
      // OpenAI's rejections (bad key, no credit) carry no CORS headers, so the browser only sees a network error.
      throw new Error(navigator.onLine === false
        ? 'you are offline'
        : 'OpenAI refused the request — check the API key and that the account has credit');
    }
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || j?.error || `AI request failed (${r.status})`;
    throw new Error(String(msg).slice(0, 240));
  }
  const text = j.choices?.[0]?.message?.content ?? '';
  if (!json) return text;
  try {
    return JSON.parse(text);
  } catch {
    const m2 = text.match(/\{[\s\S]*\}/);
    if (m2) return JSON.parse(m2[0]);
    throw new Error('The stylist replied in an unexpected format. Try again.');
  }
}

export class AIOff extends Error {
  constructor() { super('AI is not connected'); this.name = 'AIOff'; }
}

export async function ping() {
  const out = await complete([{ role: 'user', content: 'Reply with the single word: ready' }], { effort: 'minimal', maxTokens: 400 });
  return out.trim();
}

// ---------- Tagging photos ----------

const TAG_SCHEMA = `{
  "look": "one-line description of the whole outfit, or empty string if these are not being worn",
  "items": [{
    "name": "short specific name, e.g. 'White linen shirt', 'Olive cargo trousers'",
    "category": one of ${JSON.stringify(Object.keys(CATEGORIES))},
    "colors": ["main colour first, simple names"],
    "pattern": "solid | stripes | checks | floral | print | embroidered | other",
    "material": "best guess, e.g. cotton, denim, linen, wool, leather, silk, synthetic",
    "warmth": 1-5 (1 = very light summer wear, 5 = heavy winter wear),
    "formality": 1-5 (1 = gym/lounge, 3 = smart casual, 5 = black tie / wedding),
    "occasions": subset of ${JSON.stringify(OCCASIONS.map((o) => o.id))},
    "seasons": subset of ${JSON.stringify(SEASONS)},
    "waterproof": true/false,
    "notes": "fit, styling notes, anything distinctive (max 20 words)",
    "bbox": [x0, y0, x1, y1] normalised 0-1 bounding box of this piece in the image
  }]
}`;

export async function tagPhoto(blob, kind) {
  const url = await blobToDataURL(blob);
  const instructions = kind === 'person'
    ? 'This is a photo of a person wearing an outfit. Identify every distinct clothing piece, shoe and notable accessory they are wearing that is clearly visible. Ignore the background and anything not being worn. Do not describe the person\'s body or face.'
    : 'This is a photo of one or more clothing items (laid flat, hung, or held up). Identify each distinct piece. Usually there is just one.';
  const out = await complete([
    {
      role: 'system',
      content: `You catalogue a person's wardrobe from photos. Categories: ${Object.entries(CATEGORY_HINT).map(([k, v]) => `${k} (${v})`).join('; ')}. ` +
        'Indian and global clothing are both common — name pieces accurately (kurta, saree, dupatta, nehru jacket, etc.). ' +
        `Reply with JSON only, shaped exactly like:\n${TAG_SCHEMA}\nIf there is no clothing in the image, return {"look":"","items":[]}.`,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: instructions },
        { type: 'image_url', image_url: { url, detail: 'low' } },
      ],
    },
  ], { json: true, effort: 'minimal' });
  return {
    look: typeof out.look === 'string' ? out.look : '',
    items: Array.isArray(out.items) ? out.items.map(cleanItem) : [],
  };
}

const clamp = (n, d = 3) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : d;
};
const arr = (a) => (Array.isArray(a) ? a.map((x) => String(x).toLowerCase().trim()).filter(Boolean) : []);

export function cleanItem(x = {}) {
  return {
    name: String(x.name || 'Untitled piece').slice(0, 60),
    category: CATEGORIES[x.category] ? x.category : 'top',
    colors: arr(x.colors).slice(0, 4),
    pattern: String(x.pattern || 'solid'),
    material: String(x.material || ''),
    warmth: clamp(x.warmth),
    formality: clamp(x.formality),
    occasions: arr(x.occasions).filter((o) => OCCASIONS.some((k) => k.id === o)),
    seasons: arr(x.seasons).filter((o) => SEASONS.includes(o)),
    waterproof: !!x.waterproof,
    notes: String(x.notes || '').slice(0, 200),
    bbox: Array.isArray(x.bbox) ? x.bbox.map(Number) : null,
  };
}

// ---------- Styling ----------

function catalogue(items) {
  return items.map((i) => {
    const since = daysSince(i.lastWorn);
    const worn = i.lastWorn ? `last worn ${since === 0 ? 'today' : `${since}d ago`}` : 'not worn yet';
    return `${i.id} | ${i.name} | ${i.category} | ${(i.colors || []).join('/')} | ${i.pattern || ''} ${i.material || ''} | warmth ${i.warmth} | formality ${i.formality} | ${(i.occasions || []).join(',')}${i.waterproof ? ' | waterproof' : ''}${i.favorite ? ' | favourite' : ''} | ${worn}${i.notes ? ` | ${i.notes}` : ''}`;
  }).join('\n');
}

function profileText(profile) {
  const bits = [];
  if (profile.name) bits.push(`Name: ${profile.name}.`);
  if (profile.wear && profile.wear !== 'mixed') bits.push(`Mostly wears ${profile.wear}.`);
  if (profile.style) bits.push(`Style notes from them: ${profile.style}`);
  return bits.join(' ') || 'No profile details given.';
}

const STYLIST_VOICE = 'You are Zazzoyance, a warm, decisive personal stylist. You only style with clothes the person actually owns (listed in the wardrobe below), ' +
  'and you dress for the weather first. Be specific and brief; no filler, no disclaimers. Consider colour harmony, pattern mixing, fabric vs weather, ' +
  'dressiness vs occasion, and avoid repeating pieces worn in the last couple of days.';

export async function suggestOutfits({ items, profile, weatherText, occasion, extra }) {
  const out = await complete([
    {
      role: 'system',
      content: `${STYLIST_VOICE}\n\nAbout them: ${profileText(profile)}\n\nWardrobe (id | name | category | colours | fabric | warmth 1-5 | formality 1-5 | occasions | …):\n${catalogue(items)}\n\n` +
        'Reply with JSON only: {"outfits":[{"title":"short evocative name","itemIds":["ids from the wardrobe"],"why":"1-2 sentences on why it works for this weather and plan","tip":"one styling tip"}],"missing":"one sentence naming a gap in their wardrobe for this situation, or empty string"}. ' +
        'Give 3 distinct outfits. Each needs either a top + bottom or a one-piece, plus footwear if they own any. Only use ids that appear in the wardrobe.',
    },
    { role: 'user', content: `Weather: ${weatherText}\nPlan: ${occasion.label}.${extra ? `\nAlso: ${extra}` : ''}` },
  ], { json: true, effort: 'low' });
  const byId = new Map(items.map((i) => [i.id, i]));
  const outfits = (out.outfits || []).map((o) => ({
    title: String(o.title || 'Outfit'),
    items: (o.itemIds || []).map((id) => byId.get(String(id).trim())).filter(Boolean),
    why: String(o.why || ''),
    tip: String(o.tip || ''),
  })).filter((o) => o.items.length);
  if (!outfits.length) throw new Error('The stylist could not build an outfit from your closet.');
  return { outfits, missing: String(out.missing || '') };
}

export async function chatReply({ history, items, profile, weatherText, image }) {
  const sys = `${STYLIST_VOICE}\n\nAbout them: ${profileText(profile)}\nWeather: ${weatherText}\nToday is ${new Date().toDateString()}.\n\n` +
    `Wardrobe (id | name | category | colours | fabric | warmth | formality | occasions | …):\n${catalogue(items) || '(empty — encourage them to add clothes in the Closet tab)'}\n\n` +
    'Whenever you mention a piece they own, write its id in double square brackets right after its name, like: the white linen shirt [[abc123]]. ' +
    'The app turns those into pictures. Plain text only — no markdown headings or tables; short paragraphs or simple dashes are fine. ' +
    'If they ask about a trip or another city, dress for what that place is usually like at this time of year and say so. ' +
    'If they share a photo, respond to it directly (e.g. whether it goes with what they own).';
  const msgs = [{ role: 'system', content: sys }];
  const recent = history.slice(-16);
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i];
    const isLast = i === recent.length - 1;
    if (isLast && image && m.role === 'user') {
      msgs.push({ role: 'user', content: [
        { type: 'text', text: m.text || 'What do you think of this?' },
        { type: 'image_url', image_url: { url: await blobToDataURL(image), detail: 'low' } },
      ] });
    } else {
      msgs.push({ role: m.role, content: m.text + (m.hadImage && !isLast ? ' [shared a photo]' : '') });
    }
  }
  return complete(msgs, { effort: 'low' });
}
