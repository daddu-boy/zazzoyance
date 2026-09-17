// Server-side proxy to OpenAI, so phones don't need their own API key.
//
// Set these in Netlify → Site configuration → Environment variables:
//   OPENAI_API_KEY   required — your key from platform.openai.com
//   APP_PASSCODE     optional — if set, the app must send this passcode (stops strangers spending your credits)
//   OPENAI_MODEL     optional — default model, e.g. gpt-5-mini
//
// An edge function (not a regular Netlify function) because vision calls can take longer than
// the 10-second limit on regular functions; edge functions only count CPU time, not waiting.

const MAX_BODY = 4 * 1024 * 1024;
const ALLOWED_KEYS = new Set(['model', 'messages', 'response_format', 'reasoning_effort', 'max_completion_tokens', 'max_tokens', 'temperature']);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default async (request) => {
  const key = Netlify.env.get('OPENAI_API_KEY');
  const passcode = Netlify.env.get('APP_PASSCODE');
  const defaultModel = Netlify.env.get('OPENAI_MODEL') || 'gpt-5-mini';

  if (request.method === 'GET') {
    return json({ configured: !!key, passcode: !!passcode, model: defaultModel });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!key) return json({ error: 'The server has no OpenAI key configured.' }, 503);
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

  // Only forward the fields the app uses.
  const payload = Object.fromEntries(Object.entries(body).filter(([k]) => ALLOWED_KEYS.has(k)));
  payload.model = typeof payload.model === 'string' && payload.model ? payload.model : defaultModel;
  if (payload.max_completion_tokens) payload.max_completion_tokens = Math.min(Number(payload.max_completion_tokens) || 4000, 8000);
  if (payload.max_tokens) payload.max_tokens = Math.min(Number(payload.max_tokens) || 1500, 2000);

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' },
  });
};

export const config = { path: '/api/ai' };
