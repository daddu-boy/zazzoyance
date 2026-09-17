// Local dev server: `node dev-server.mjs` → http://localhost:8130
// Serves the static app. /api/ai forwards to OpenAI if OPENAI_API_KEY is set,
// or returns canned replies with MOCK_AI=1 (for testing the UI without spending credits).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.PORT) || 8130;
const MOCK = process.env.MOCK_AI === '1';
const KEY = process.env.OPENAI_API_KEY;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const reply = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });

function mock(body) {
  const sys = String(body.messages[0]?.content || '');
  if (sys.includes('catalogue a person')) {
    const person = JSON.stringify(body.messages[1].content).includes('person wearing');
    const items = person
      ? [
          { name: 'White linen shirt', category: 'top', colors: ['white'], pattern: 'solid', material: 'linen', warmth: 1, formality: 3, occasions: ['work', 'casual'], seasons: ['summer'], waterproof: false, notes: 'Relaxed fit', bbox: [0.25, 0.15, 0.75, 0.5] },
          { name: 'Navy chinos', category: 'bottom', colors: ['navy'], pattern: 'solid', material: 'cotton', warmth: 2, formality: 3, occasions: ['work'], seasons: ['summer', 'spring'], waterproof: false, notes: '', bbox: [0.3, 0.48, 0.7, 0.9] },
          { name: 'Tan loafers', category: 'footwear', colors: ['tan'], pattern: 'solid', material: 'suede', warmth: 2, formality: 3, occasions: ['work', 'date'], seasons: [], waterproof: false, notes: '', bbox: [0.3, 0.88, 0.7, 1] },
        ]
      : [{ name: 'Olive bomber jacket', category: 'layer', colors: ['olive'], pattern: 'solid', material: 'nylon', warmth: 3, formality: 2, occasions: ['casual', 'travel'], seasons: ['autumn', 'winter'], waterproof: true, notes: 'Ribbed cuffs', bbox: [0.1, 0.1, 0.9, 0.9] }];
    return reply(JSON.stringify({ look: person ? 'Smart-casual summer office look' : '', items }));
  }
  const ids = [...sys.matchAll(/^(\w+) \| /gm)].map((m) => m[1]);
  if (sys.includes('Give 3 distinct outfits')) {
    return reply(JSON.stringify({
      outfits: [0, 1, 2].map((i) => ({ title: `Mock outfit ${i + 1}`, itemIds: ids.slice(i, i + 3), why: 'Light fabrics for the heat, polished enough for the plan.', tip: 'Roll the sleeves twice.' })),
      missing: 'A lightweight rain jacket would round this out.',
    }));
  }
  if (sys.includes('Reply with the single word')) return reply('ready');
  return reply(`Try the ${ids[0] ? `piece [[${ids[0]}]]` : 'nothing yet'} with ${ids[1] ? `[[${ids[1]}]]` : 'something neutral'} — breathable and sharp for today.`);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/ai') {
    if (req.method === 'GET') return send(res, 200, { configured: MOCK || !!KEY, passcode: false, model: 'gpt-5-mini' });
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (MOCK) { await new Promise((r) => setTimeout(r, 600)); return send(res, 200, mock(body)); }
    if (!KEY) return send(res, 503, { error: 'No OPENAI_API_KEY on the dev server.' });
    const up = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: raw,
    });
    return send(res, up.status, await up.text());
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel.endsWith('/') ? `${rel}index.html` : rel);
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}).listen(PORT, () => console.log(`Drape dev server on http://localhost:${PORT}${MOCK ? ' (mock AI)' : ''}`));
