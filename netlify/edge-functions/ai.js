// Server-side proxy to Google Gemini (Google AI Studio key), so phones don't need their own key.
//
// Set these in Netlify → Project configuration → Environment variables:
//   GOOGLE_AI_STUDIO_KEY  required — your key from aistudio.google.com/apikey
//   APP_PASSCODE          optional — if set, the app must send this passcode
//   GEMINI_MODEL          optional — default model, e.g. gemini-3.6-flash
//
// Deliberately NOT read: OPENAI_* / GEMINI_API_KEY / NETLIFY_AI_GATEWAY_*. Netlify's AI Gateway injects
// those automatically and bills Netlify credits; this app only ever uses your own Google key.
//
// An edge function (not a regular Netlify function) because vision calls can take longer than
// the 10-second limit on regular functions; edge functions only count CPU time, not waiting.

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const MAX_BODY = 4 * 1024 * 1024;
const ALLOWED_KEYS = new Set(['model', 'messages', 'response_format', 'reasoning_effort', 'max_tokens', 'temperature']);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default async (request) => {
  const key = Netlify.env.get('GOOGLE_AI_STUDIO_KEY');
  const passcode = Netlify.env.get('APP_PASSCODE');
  const defaultModel = Netlify.env.get('GEMINI_MODEL') || 'gemini-3.6-flash';

  if (request.method === 'GET') {
    return json({ configured: !!key, passcode: !!passcode, model: defaultModel, provider: 'gemini' });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  // Browsers always send Origin on POST; only accept calls from this site (and its deploy previews).
  // This stops other websites using the endpoint, not a determined script — use APP_PASSCODE for that.
  const origin = request.headers.get('origin');
  const host = new URL(request.url).hostname;
  if (!origin || !(new URL(origin).hostname === host || /(^|\.)zazzoyance\.netlify\.app$/.test(new URL(origin).hostname))) {
    return json({ error: 'Forbidden.' }, 403);
  }
  if (!key) return json({ error: 'The server has no Google AI Studio key configured.' }, 503);
  if (passcode && request.headers.get('x-app-passcode') !== passcode) {
    return json({ error: 'Wrong or missing passcode. Enter it in the You tab.' }, 401);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'Request too large.' }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length > 40) return json({ error: 'Invalid messages.' }, 400);

  // Only forward the fields the app uses, and only Gemini models.
  const payload = Object.fromEntries(Object.entries(body).filter(([k]) => ALLOWED_KEYS.has(k)));
  payload.model = typeof payload.model === 'string' && /^gemini-/.test(payload.model) ? payload.model : defaultModel;
  payload.max_tokens = Math.min(Number(payload.max_tokens) || 4096, 8192);

  const upstream = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};

export const config = { path: '/api/ai' };
