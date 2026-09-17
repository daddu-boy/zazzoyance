// Runs the Telegram bot's logic against fake Telegram, Gemini and weather services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot, webhookSecret } from '../netlify/lib/bot.mjs';

function harness({ gemini, allowed = [], passcode = '' } = {}) {
  const db = new Map();
  const sent = [];
  let geminiCalls = 0;
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.telegram.org/file/')) return new Response(new Uint8Array([255, 216, 255, 224, 1, 2, 3]));
    if (u.startsWith('https://api.telegram.org/bot')) {
      const method = u.split('/').pop();
      const params = JSON.parse(opts.body || '{}');
      sent.push({ method, ...params });
      if (method === 'getFile') return reply({ ok: true, result: { file_path: 'photos/x.jpg' } });
      return reply({ ok: true, result: {} });
    }
    if (u.includes('generativelanguage')) {
      geminiCalls++;
      const body = JSON.parse(opts.body);
      const out = gemini(body, geminiCalls);
      if (out instanceof Response) return out;
      return reply({ choices: [{ message: { content: out } }] });
    }
    if (u.includes('geocoding-api')) return reply({ results: [{ name: 'Shimla', country: 'India', latitude: 31.1, longitude: 77.17 }] });
    if (u.includes('api.open-meteo.com')) {
      return reply({ daily: { weather_code: [61, 1], temperature_2m_max: [22, 24], temperature_2m_min: [12, 13], apparent_temperature_max: [21, 23],
        apparent_temperature_min: [10, 12], precipitation_probability_max: [70, 10], uv_index_max: [5, 6], wind_speed_10m_max: [12, 9] } });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const store = { get: async (k) => structuredClone(db.get(k) ?? null), set: async (k, v) => db.set(k, structuredClone(v)) };
  const bot = createBot({ token: 'T', geminiKey: 'G', allowed, passcode, store, fetch });
  let uid = 0;
  const send = (message) => bot.handleUpdate({ update_id: ++uid, message: { chat: { id: 7, type: 'private' }, from: { id: 42, first_name: 'Sid' }, ...message } });
  const texts = () => sent.filter((s) => s.method === 'sendMessage').map((s) => s.text);
  const user = () => db.get('user-42');
  return { bot, send, sent, texts, user, db, calls: () => geminiCalls };
}

const TAGS = '```json\n' + JSON.stringify({ look: '', items: [
  { name: 'White crewneck T-shirt', category: 'top', colors: ['white'], warmth: 1, formality: 1, box_2d: [78, 80, 456, 581] },
  { name: 'Blue jeans', category: 'bottom', colors: ['blue'], material: 'denim', warmth: 2, formality: 2 },
  { name: 'White sneakers', category: 'footwear', colors: ['white'], warmth: 1, formality: 1 },
] }) + '\n```';

function fakeGemini(body) {
  const sys = body.messages[0].content;
  if (sys.startsWith('You catalogue')) return TAGS;
  const ids = [...sys.matchAll(/^(\w+) \| /gm)].map((m) => m[1]);
  if (sys.includes('Give 3 distinct outfits')) return JSON.stringify({ outfits: [{ title: 'Easy rain day', itemIds: ids, why: 'Denim handles the drizzle.', tip: 'Cuff the jeans.' }], missing: 'A rain jacket.' });
  return `Wear your jeans [[${ids[1]}]] with the tee [[${ids[0]}]]. **Stay dry.**`;
}

test('photo → closet, city, today, chat, wore, remove', async () => {
  const h = harness({ gemini: fakeGemini });
  await h.send({ text: '/start' });
  assert.match(h.texts()[0], /Hi Sid/);

  await h.send({ photo: [{ file_id: 'small', width: 320, height: 320 }, { file_id: 'big', width: 1280, height: 960 }, { file_id: 'huge', width: 2560, height: 1920 }] });
  assert.equal(h.user().items.length, 3);
  assert.equal(h.user().items[0].fileId, 'big', 'uses the largest size ≤1280px');
  assert.equal(h.user().items[0].bbox, undefined);
  assert.match(h.texts().at(-1), /1\. White crewneck T-shirt.*\n2\. Blue jeans.*\n3\. White sneakers/);
  assert.match(h.texts().at(-1), /\/remove 1-3/);

  await h.send({ text: '/today' });
  assert.match(h.texts().at(-1), /share your location/i, 'asks for a city first');

  await h.send({ text: '/city shimla' });
  assert.deepEqual(h.user().city, { name: 'Shimla, India', lat: 31.1, lon: 77.17 });

  await h.send({ text: '/today office' });
  const today = h.texts().at(-1);
  assert.match(today, /Today in Shimla/);
  assert.match(today, /Plan:<\/b> Work/);
  assert.match(today, /Easy rain day/);
  assert.match(today, /\/wore 1 2 3/);
  assert.equal(h.sent.at(-1).method, 'sendPhoto', 'all three pieces share one photo, so it is sent once');

  await h.send({ text: 'what goes with my jeans?' });
  assert.equal(h.texts().at(-1), 'Wear your jeans with the tee. Stay dry.');
  assert.equal(h.user().history.length, 2);

  await h.send({ text: '/wore 1 3' });
  assert.ok(h.user().items[0].lastWorn && h.user().items[2].lastWorn && !h.user().items[1].lastWorn);

  await h.send({ text: '/closet' });
  assert.match(h.texts().at(-1), /<b>Tops<\/b>\n1\. White crewneck T-shirt <i>· worn/);

  await h.send({ text: '/remove 2' });
  assert.deepEqual(h.user().items.map((i) => i.name), ['White crewneck T-shirt', 'White sneakers']);
});

test('photo with a question is answered, not saved', async () => {
  const h = harness({ gemini: fakeGemini });
  await h.send({ photo: [{ file_id: 'p', width: 800, height: 800 }], caption: 'does this suit me?' });
  assert.equal(h.user().items.length, 0);
  const call = h.sent.filter((s) => s.method === 'sendMessage').at(-1);
  assert.ok(call.text.length > 0);
});

test('duplicate updates are handled once', async () => {
  const h = harness({ gemini: fakeGemini });
  const update = { update_id: 99, message: { chat: { id: 7, type: 'private' }, from: { id: 42 }, photo: [{ file_id: 'a', width: 500, height: 500 }] } };
  await h.bot.handleUpdate(update);
  await h.bot.handleUpdate(update);
  assert.equal(h.user().items.length, 3);
  assert.equal(h.calls(), 1);
});

test('allow-list and passcode gate access', async () => {
  const a = harness({ gemini: fakeGemini, allowed: ['1'] });
  await a.send({ text: 'hello' });
  assert.match(a.texts()[0], /add your id: <code>42<\/code>/);
  assert.equal(a.calls(), 0);

  const p = harness({ gemini: fakeGemini, passcode: 'silk' });
  await p.send({ text: '/start' });
  assert.match(p.texts()[0], /invite-only/);
  await p.send({ text: '/join wrong' });
  assert.match(p.texts()[1], /invite-only/);
  await p.send({ text: '/join silk' });
  assert.match(p.texts()[2], /You're in/);
  await p.send({ text: '/closet' });
  assert.match(p.texts()[3], /closet is empty/);
});

test('AI failure falls back to built-in picks and group chats are ignored', async () => {
  const h = harness({ gemini: (body, n) => (n <= 2 ? TAGS : new Response('[{"error":{"message":"quota exceeded"}}]', { status: 429 })) });
  await h.send({ photo: [{ file_id: 'a', width: 500, height: 500 }] });
  await h.send({ photo: [{ file_id: 'b', width: 500, height: 500 }] });
  await h.send({ text: '/city shimla' });
  await h.send({ text: '/tomorrow wedding' });
  assert.match(h.texts().at(-1), /AI unavailable — quota exceeded/);
  assert.match(h.texts().at(-1), /Tomorrow in Shimla/);
  assert.match(h.texts().at(-1), /Wedding \/ festive/);

  const before = h.sent.length;
  await h.bot.handleUpdate({ update_id: 500, message: { chat: { id: -1, type: 'group' }, from: { id: 42 }, text: 'hi' } });
  assert.equal(h.sent.length, before);
});

test('webhook secret is stable and token-derived', async () => {
  assert.equal(await webhookSecret('abc'), await webhookSecret('abc'));
  assert.notEqual(await webhookSecret('abc'), await webhookSecret('abd'));
  assert.match(await webhookSecret('abc'), /^[0-9a-f]{48}$/);
});
