// Zazzoyance on Telegram — the bot's logic, independent of where it runs.
// The Netlify edge function (netlify/edge-functions/telegram.js) wires in the token, the Gemini key and storage;
// test/bot.test.mjs runs the same code against fakes.
//
// Each Telegram user gets one JSON record: their closet (items point at Telegram photo file_ids, so no images
// are stored here), city, recent chat and the update ids already handled.

import { TAG_SYSTEM, STYLIST_VOICE, catalogue, profileText, cleanItem } from '../../js/ai.js';
import { CATEGORIES, OCCASIONS, suggestOffline, weatherAdvice } from '../../js/stylist.js';
import { describe } from '../../js/weather.js';
import { todayISO } from '../../js/util.js';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const MAX_ITEMS = 300;
const HISTORY = 16;

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const shortId = () => Math.random().toString(36).slice(2, 9);

export async function webhookSecret(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`zazzoyance:${token}`)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

export const COMMANDS = [
  { command: 'today', description: 'What to wear today (add a plan, e.g. /today work)' },
  { command: 'tomorrow', description: 'What to wear tomorrow' },
  { command: 'closet', description: 'List everything in your closet' },
  { command: 'city', description: 'Set your city, e.g. /city Shimla' },
  { command: 'wore', description: 'Log what you wore, e.g. /wore 1 4 7' },
  { command: 'photo', description: 'See a piece, e.g. /photo 3' },
  { command: 'remove', description: 'Remove pieces, e.g. /remove 3' },
  { command: 'help', description: 'How to use Zazzoyance' },
];

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function parseJSON(text) {
  try {
    return JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('unexpected AI reply');
  }
}

export function createBot({ token, geminiKey, model = 'gemini-3.6-flash', allowed = [], passcode = '', store, fetch = globalThis.fetch }) {
  // ---------- outside services ----------

  async function tg(method, params) {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) console.error(`telegram ${method} failed:`, j.description || r.status);
    return j.result;
  }

  const say = (chatId, html, extra = {}) =>
    tg('sendMessage', { chat_id: chatId, text: html.slice(0, 4000), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

  async function gemini(messages, { effort = 'low', maxTokens = 4096 } = {}) {
    if (!geminiKey) throw new Error('the AI key is not set on the server');
    const body = JSON.stringify({ model, messages, max_tokens: maxTokens, reasoning_effort: effort });
    const call = () => fetch(GEMINI_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${geminiKey}` }, body });
    let r = await call();
    if ([429, 500, 502, 503, 504].includes(r.status)) {
      await new Promise((res) => setTimeout(res, 1200));
      r = await call();
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = Array.isArray(j) ? j[0]?.error : j?.error;
      throw new Error(e?.message || `AI request failed (${r.status})`);
    }
    return j.choices?.[0]?.message?.content ?? '';
  }

  async function downloadPhoto(fileId) {
    const f = await tg('getFile', { file_id: fileId });
    if (!f?.file_path) throw new Error('could not fetch the photo from Telegram');
    const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
    if (!r.ok) throw new Error('could not download the photo');
    const bytes = new Uint8Array(await r.arrayBuffer());
    return `data:image/jpeg;base64,${toBase64(bytes)}`;
  }

  async function weatherFor(city) {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({
      latitude: city.lat, longitude: city.lon, timezone: 'auto', forecast_days: 2,
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,uv_index_max,wind_speed_10m_max',
    });
    const j = await (await fetch(url)).json();
    return [0, 1].map((i) => ({
      code: j.daily.weather_code[i],
      max: j.daily.temperature_2m_max[i],
      min: j.daily.temperature_2m_min[i],
      feelsMax: j.daily.apparent_temperature_max[i],
      feelsMin: j.daily.apparent_temperature_min[i],
      rainChance: j.daily.precipitation_probability_max[i] ?? 0,
      uv: j.daily.uv_index_max[i] ?? 0,
      wind: j.daily.wind_speed_10m_max[i] ?? 0,
    }));
  }

  const dayLine = (city, d, i) => `${i ? 'Tomorrow' : 'Today'} in ${city.name}: ${describe(d.code)[0].toLowerCase()}, ${Math.round(d.min)}–${Math.round(d.max)}°C ` +
    `(feels ${Math.round(d.feelsMin)}–${Math.round(d.feelsMax)}°C), ${d.rainChance}% chance of rain, UV ${Math.round(d.uv)}, wind up to ${Math.round(d.wind)} km/h.`;

  async function geocode(q) {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`);
    const x = (await r.json()).results?.[0];
    return x ? { name: [x.name, x.country].filter(Boolean).join(', '), lat: x.latitude, lon: x.longitude } : null;
  }

  async function sendPieces(chatId, items, caption = '') {
    const ids = [...new Set(items.map((i) => i.fileId).filter(Boolean))].slice(0, 10);
    if (!ids.length) return;
    if (ids.length === 1) return tg('sendPhoto', { chat_id: chatId, photo: ids[0], caption, parse_mode: 'HTML' });
    return tg('sendMediaGroup', { chat_id: chatId, media: ids.map((id, n) => ({ type: 'photo', media: id, ...(n === 0 && caption ? { caption, parse_mode: 'HTML' } : {}) })) });
  }

  // ---------- records ----------

  const key = (id) => `user-${id}`;
  async function load(from) {
    const u = (await store.get(key(from.id))) || { id: from.id, items: [], history: [], seen: [], joined: false, city: null };
    u.name = from.first_name || u.name || '';
    return u;
  }
  const save = (u) => store.set(key(u.id), u);
  const isAllowed = (u) => (allowed.length ? allowed.includes(String(u.id)) : passcode ? u.joined : true);
  const numbered = (u) => u.items.map((it, i) => ({ ...it, n: i + 1 }));
  const byNumbers = (u, text) => [...new Set((text.match(/\d+/g) || []).map(Number))].map((n) => u.items[n - 1]).filter(Boolean);

  const OCCASION_WORDS = [
    ['festive', /\b(wedding|festive|festival|shaadi|puja|pooja|diwali|holi|eid|sangeet|mehendi|reception)\b/],
    ['formal', /\b(formal|black tie|gala|ceremony)\b/],
    ['workout', /\b(workout|gym|run|running|yoga|trek|hike|sport)\b/],
    ['work', /\b(work|office|meeting|interview|court|client|conference)\b/],
    ['date', /\b(date|dinner|drinks)\b/],
    ['party', /\b(party|club|clubbing|birthday)\b/],
    ['travel', /\b(travel|flight|airport|trip|train)\b/],
    ['lounge', /\b(home|lounge|chill|wfh)\b/],
    ['casual', /\b(casual|brunch|errands|shopping|college|weekend)\b/],
  ];
  function occasionFrom(text, fallback = 'casual') {
    const t = text.toLowerCase();
    const id = OCCASION_WORDS.find(([, re]) => re.test(t))?.[0] || fallback;
    return OCCASIONS.find((o) => o.id === id);
  }

  // ---------- handlers ----------

  const HELP = [
    '<b>Zazzoyance</b> — your stylist, built from what you own.',
    '',
    '📸 <b>Send a photo</b> of a piece of clothing (or of yourself wearing an outfit) and I\'ll add each piece to your closet.',
    '❓ Send a photo <b>with a question</b> in the caption (e.g. "does this go with my jeans?") and I\'ll answer instead of saving it.',
    '📍 <b>Share your location</b> or type /city Delhi so I can dress you for the weather.',
    '👗 /today or /tomorrow — outfits for the weather. Add the plan: <code>/today wedding</code>',
    '💬 Or just ask: "what should I pack for Goa?"',
    '',
    '/closet — see everything · /photo 3 — see a piece · /remove 3 — delete it · /wore 1 4 — log what you wore',
  ].join('\n');

  async function addPhoto(u, chatId, fileId, caption) {
    if (u.items.length >= MAX_ITEMS) return say(chatId, `Your closet is full (${MAX_ITEMS} pieces). Remove some with /remove first.`);
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    const url = await downloadPhoto(fileId);
    const text = await gemini([
      { role: 'system', content: TAG_SYSTEM },
      { role: 'user', content: [
        { type: 'text', text: 'Identify the clothing in this photo. If a person is wearing an outfit, list only what they are wearing and do not describe their body or face; otherwise list each clothing item shown (usually one).' + (caption ? ` The owner says: "${caption}"` : '') },
        { type: 'image_url', image_url: { url, detail: 'low' } },
      ] },
    ], { effort: 'minimal' });
    const out = parseJSON(text);
    const found = (Array.isArray(out.items) ? out.items : []).map(cleanItem);
    if (!found.length) return say(chatId, 'I couldn\'t spot any clothing in that photo. Try a clearer shot with the piece laid flat or hung up.');
    const start = u.items.length;
    for (const f of found) {
      const { bbox, ...rest } = f;
      u.items.push({ ...rest, id: shortId(), fileId, createdAt: Date.now(), wornCount: 0, lastWorn: null, favorite: false });
    }
    const lines = found.map((f, i) => `${start + i + 1}. ${esc(f.name)} <i>(${esc(CATEGORIES[f.category])}, ${esc(f.colors.join('/'))})</i>`);
    const look = out.look ? `\n\n<i>${esc(out.look)}</i>` : '';
    return say(chatId, `Added to your closet:\n${lines.join('\n')}${look}\n\nWrong? /remove ${start + 1}${found.length > 1 ? `-${start + found.length}` : ''} · Your closet now has ${u.items.length} pieces.`);
  }

  async function styleDay(u, chatId, dayIdx, argText) {
    if (u.items.length < 2) return say(chatId, 'Add a few pieces first — send me photos of your clothes. A handful of tops, bottoms and shoes is enough to start.');
    if (!u.city) return say(chatId, 'Where are you? Share your location (📎 → Location) or type <code>/city Delhi</code>, then try again.');
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    const days = await weatherFor(u.city);
    const day = days[dayIdx];
    const occasion = occasionFrom(argText, new Date().getUTCDay() % 6 === 0 ? 'casual' : 'work');
    const extra = argText.trim();
    let outfits, missing = '', note = '';
    try {
      const out = parseJSON(await gemini([
        { role: 'system', content: `${STYLIST_VOICE}\n\nAbout them: ${profileText({ name: u.name })}\n\nWardrobe (id | name | category | colours | fabric | warmth 1-5 | formality 1-5 | occasions | …):\n${catalogue(u.items)}\n\n` +
          'Reply with raw JSON only (no markdown fences): {"outfits":[{"title":"short evocative name","itemIds":["ids from the wardrobe"],"why":"1-2 sentences","tip":"one styling tip"}],"missing":"one sentence naming a gap in their wardrobe for this situation, or empty string"}. ' +
          'Give 3 distinct outfits. Each needs either a top + bottom or a one-piece, plus footwear if they own any. Only use ids that appear in the wardrobe.' },
        { role: 'user', content: `Weather: ${dayLine(u.city, day, dayIdx)}\nPlan: ${occasion.label}.${extra ? `\nThey said: ${extra}` : ''}` },
      ]));
      const byId = new Map(u.items.map((i) => [i.id, i]));
      outfits = (out.outfits || []).map((o) => ({ title: String(o.title || 'Outfit'), items: (o.itemIds || []).map((id) => byId.get(String(id).trim())).filter(Boolean), why: String(o.why || ''), tip: String(o.tip || '') }))
        .filter((o) => o.items.length);
      missing = String(out.missing || '');
    } catch (err) {
      note = `\n<i>(AI unavailable — ${esc(err.message)}. These are built-in picks.)</i>`;
    }
    if (!outfits?.length) ({ outfits, missing } = suggestOffline(u.items, day, occasion.id, { dayOffset: dayIdx }));
    if (!outfits.length) return say(chatId, esc(missing || 'I need at least a top and a bottom, or a dress, to build an outfit.'));

    const num = new Map(u.items.map((it, i) => [it.id, i + 1]));
    const icon = describe(day.code)[1];
    const header = `${icon} <b>${dayIdx ? 'Tomorrow' : 'Today'} in ${esc(u.city.name)}</b> — ${Math.round(day.min)}–${Math.round(day.max)}°C, ${day.rainChance}% rain\n${esc(weatherAdvice(day))}\n<b>Plan:</b> ${esc(occasion.label)}${note}`;
    const blocks = outfits.slice(0, 3).map((o, i) => `<b>${i + 1}. ${esc(o.title)}</b>\n` +
      o.items.map((it) => `  • ${esc(it.name)} <i>#${num.get(it.id)}</i>`).join('\n') +
      (o.why ? `\n${esc(o.why)}` : '') + (o.tip ? `\n💡 ${esc(o.tip)}` : ''));
    const first = outfits[0].items.map((it) => num.get(it.id)).join(' ');
    await say(chatId, `${header}\n\n${blocks.join('\n\n')}${missing ? `\n\n🛍 ${esc(missing)}` : ''}\n\nWearing the first one? /wore ${first}`);
    await sendPieces(chatId, outfits[0].items, `<b>1. ${esc(outfits[0].title)}</b>`);
  }

  async function chat(u, chatId, text, photoFileId) {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    let weather = 'unknown — they have not set a city (suggest /city or sharing their location if it matters)';
    if (u.city) {
      try {
        const days = await weatherFor(u.city);
        weather = days.map((d, i) => dayLine(u.city, d, i)).join(' ');
      } catch { /* answer without weather */ }
    }
    const sys = `${STYLIST_VOICE}\n\nAbout them: ${profileText({ name: u.name })}\nWeather: ${weather}\nToday is ${new Date().toDateString()}.\n\n` +
      `Wardrobe (id | name | category | colours | fabric | warmth | formality | occasions | …):\n${catalogue(u.items) || '(empty — tell them to send photos of their clothes to fill it)'}\n\n` +
      'Whenever you mention a piece they own, put its id in double square brackets right after its name, like: the white linen shirt [[abc123]]. ' +
      'This is a Telegram chat: plain text, short paragraphs, simple dashes for lists, no markdown headings, tables or asterisks. Keep it under 150 words unless they ask for more. ' +
      'If they ask about a trip or another city, dress for what that place is usually like at this time of year and say so.';
    const msgs = [{ role: 'system', content: sys }, ...u.history.map((m) => ({ role: m.role, content: m.text }))];
    if (photoFileId) {
      msgs.push({ role: 'user', content: [{ type: 'text', text: text || 'What do you think of this?' }, { type: 'image_url', image_url: { url: await downloadPhoto(photoFileId), detail: 'low' } }] });
    } else {
      msgs.push({ role: 'user', content: text });
    }
    const reply = await gemini(msgs);
    const byId = new Map(u.items.map((i) => [i.id, i]));
    const mentioned = [];
    const clean = reply.replace(/\s*\[\[([a-z0-9]+)\]\]/gi, (_, id) => {
      const it = byId.get(id);
      if (it && !mentioned.includes(it)) mentioned.push(it);
      return '';
    }).replace(/\*\*/g, '');
    u.history.push({ role: 'user', text: (photoFileId ? '[shared a photo] ' : '') + text }, { role: 'assistant', text: reply });
    u.history = u.history.slice(-HISTORY);
    await say(chatId, esc(clean));
    if (mentioned.length) await sendPieces(chatId, mentioned);
  }

  async function command(u, chatId, cmd, arg) {
    switch (cmd) {
      case 'start':
      case 'help':
        return say(chatId, (cmd === 'start' ? `Hi${u.name ? ` ${esc(u.name)}` : ''}! ` : '') + HELP);
      case 'whoami':
        return say(chatId, `Your Telegram user id is <code>${u.id}</code>.`);
      case 'today':
        return styleDay(u, chatId, 0, arg);
      case 'tomorrow':
        return styleDay(u, chatId, 1, arg);
      case 'closet': {
        if (!u.items.length) return say(chatId, 'Your closet is empty. Send me photos of your clothes to start.');
        const groups = {};
        for (const it of numbered(u)) (groups[it.category] ||= []).push(it);
        const body = Object.keys(CATEGORIES).filter((c) => groups[c]).map((c) =>
          `<b>${esc(CATEGORIES[c])}</b>\n${groups[c].map((it) => `${it.n}. ${esc(it.name)}${it.lastWorn ? ` <i>· worn ${it.lastWorn}</i>` : ''}`).join('\n')}`).join('\n\n');
        return say(chatId, `${body}\n\n/photo 3 to see one · /remove 3 to delete`);
      }
      case 'photo': {
        const picks = byNumbers(u, arg).slice(0, 10);
        if (!picks.length) return say(chatId, 'Which one? e.g. <code>/photo 3</code> (numbers are from /closet).');
        return sendPieces(chatId, picks, picks.map((p) => esc(p.name)).join(' · '));
      }
      case 'remove': {
        const range = arg.match(/^(\d+)\s*-\s*(\d+)$/);
        const nums = range ? Array.from({ length: Math.max(0, range[2] - range[1] + 1) }, (_, i) => Number(range[1]) + i) : (arg.match(/\d+/g) || []).map(Number);
        const doomed = new Set(nums.map((n) => u.items[n - 1]).filter(Boolean));
        if (!doomed.size) return say(chatId, 'Which one? e.g. <code>/remove 3</code> or <code>/remove 3-5</code>.');
        u.items = u.items.filter((it) => !doomed.has(it));
        return say(chatId, `Removed ${[...doomed].map((d) => esc(d.name)).join(', ')}. Numbers have shifted — see /closet.`);
      }
      case 'wore': {
        const picks = byNumbers(u, arg);
        if (!picks.length) return say(chatId, 'Tell me the numbers, e.g. <code>/wore 1 4 7</code>.');
        const d = todayISO();
        for (const p of picks) { p.wornCount = (p.wornCount || 0) + 1; p.lastWorn = d; }
        return say(chatId, `Logged for today: ${picks.map((p) => esc(p.name)).join(', ')}. I'll keep them out of tomorrow's picks.`);
      }
      case 'city': {
        if (!arg.trim()) return say(chatId, `Type a city, e.g. <code>/city Shimla</code>${u.city ? `. Currently: ${esc(u.city.name)}` : ''}.`);
        const c = await geocode(arg.trim());
        if (!c) return say(chatId, `I couldn't find "${esc(arg)}". Try the nearest big city.`);
        u.city = c;
        return say(chatId, `📍 Set to ${esc(c.name)}. Try /today.`);
      }
      case 'reset':
        u.history = [];
        return say(chatId, 'Chat memory cleared. Your closet is untouched.');
      case 'clear':
        if (arg.trim() !== 'yes') return say(chatId, `This deletes all ${u.items.length} pieces. Send <code>/clear yes</code> to confirm.`);
        u.items = [];
        u.history = [];
        return say(chatId, 'Closet cleared.');
      default:
        return say(chatId, 'I don\'t know that command. /help');
    }
  }

  async function handleUpdate(update) {
    const msg = update.message;
    if (!msg?.from || msg.chat?.type !== 'private') return; // private chats only
    const chatId = msg.chat.id;
    const u = await load(msg.from);
    // Telegram re-sends an update if we are slow; handle each one once.
    if (u.seen.includes(update.update_id)) return;
    u.seen = [...u.seen, update.update_id].slice(-30);
    await save(u);

    const text = (msg.text || msg.caption || '').trim();
    const cmdMatch = text.match(/^\/([a-z_]+)(?:@\w+)?\s*([\s\S]*)$/i);

    if (!isAllowed(u)) {
      if (passcode && cmdMatch && ['start', 'join'].includes(cmdMatch[1].toLowerCase()) && cmdMatch[2].trim() === passcode) {
        u.joined = true;
        await save(u);
        return say(chatId, `You're in! ${HELP}`);
      }
      const how = allowed.length
        ? `This is a private stylist. Ask the owner to add your id: <code>${u.id}</code>`
        : 'This stylist is invite-only. Send <code>/join your-passcode</code>.';
      return say(chatId, how);
    }

    try {
      if (msg.location) {
        const { latitude: lat, longitude: lon } = msg.location;
        let name = 'your location';
        try {
          const j = await (await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`)).json();
          name = j.city || j.locality || j.principalSubdivision || name;
        } catch { /* keep generic name */ }
        u.city = { name, lat, lon };
        await say(chatId, `📍 Got it — ${esc(name)}. Try /today.`);
      } else if (msg.photo?.length || msg.document?.mime_type?.startsWith('image/')) {
        // Pick the largest size up to ~1280px — plenty for the AI, small to download.
        const fileId = msg.photo
          ? (msg.photo.filter((p) => Math.max(p.width, p.height) <= 1280).pop() || msg.photo[0]).file_id
          : msg.document.file_id;
        if (text.includes('?')) await chat(u, chatId, text, fileId);
        else await addPhoto(u, chatId, fileId, text);
      } else if (cmdMatch) {
        await command(u, chatId, cmdMatch[1].toLowerCase(), cmdMatch[2] || '');
      } else if (text) {
        await chat(u, chatId, text);
      } else {
        await say(chatId, 'Send me a photo, a question, or /help.');
      }
    } catch (err) {
      console.error(err);
      await say(chatId, `Sorry — something went wrong: ${esc(err.message)}. Please try again.`);
    }
    await save(u);
  }

  return { handleUpdate, tg };
}
