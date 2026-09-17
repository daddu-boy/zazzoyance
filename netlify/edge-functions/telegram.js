// Telegram webhook for the Zazzoyance bot.
//
// Netlify → Project configuration → Environment variables:
//   TELEGRAM_BOT_TOKEN      required — from @BotFather
//   GOOGLE_AI_STUDIO_KEY    required — the same Gemini key the web app uses
//   TELEGRAM_ALLOWED_USERS  optional — comma-separated Telegram user ids; only they can use the bot
//   APP_PASSCODE            optional — if no allow-list, people must send /join <passcode> once
//   GEMINI_MODEL            optional — default gemini-3.6-flash
//
// After setting the token and deploying, open https://<site>/api/telegram/setup once to connect the bot.
import { getStore } from '@netlify/blobs';
import { createBot, webhookSecret, COMMANDS } from '../lib/bot.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default async (request) => {
  const url = new URL(request.url);
  const token = Netlify.env.get('TELEGRAM_BOT_TOKEN');
  if (!token) return json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not set on the server.' }, 503);
  const secret = await webhookSecret(token);
  const env = {
    token,
    geminiKey: Netlify.env.get('GOOGLE_AI_STUDIO_KEY'),
    model: Netlify.env.get('GEMINI_MODEL') || 'gemini-3.6-flash',
    allowed: (Netlify.env.get('TELEGRAM_ALLOWED_USERS') || '').split(',').map((s) => s.trim()).filter(Boolean),
    passcode: Netlify.env.get('APP_PASSCODE') || '',
  };

  if (url.pathname.endsWith('/setup')) {
    // Points Telegram at this site. Safe to open more than once; it never reveals the token.
    const bot = createBot({ ...env, store: null });
    const me = await bot.tg('getMe', {});
    const hook = await bot.tg('setWebhook', {
      url: `${url.origin}/api/telegram`,
      secret_token: secret,
      allowed_updates: ['message'],
      max_connections: 10,
    });
    await bot.tg('setMyCommands', { commands: COMMANDS });
    await bot.tg('setMyDescription', { description: 'Zazzoyance — send photos of your clothes and I\'ll tell you what to wear for the weather and the day.' });
    const info = await bot.tg('getWebhookInfo', {});
    return json({
      ok: !!hook,
      bot: me ? `@${me.username}` : null,
      webhook: info?.url || null,
      pending_updates: info?.pending_update_count ?? null,
      last_error: info?.last_error_message || null,
      ai_key_set: !!env.geminiKey,
      access: env.allowed.length ? `allow-list (${env.allowed.length} user${env.allowed.length > 1 ? 's' : ''})` : env.passcode ? 'passcode (/join)' : 'OPEN — anyone who finds the bot can use it',
    });
  }

  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  if (request.headers.get('x-telegram-bot-api-secret-token') !== secret) return json({ ok: false }, 401);

  const update = await request.json().catch(() => null);
  if (!update) return json({ ok: false }, 400);
  const blobs = getStore('telegram-users');
  const store = {
    get: (k) => blobs.get(k, { type: 'json', consistency: 'strong' }),
    set: (k, v) => blobs.setJSON(k, v),
  };
  try {
    await createBot({ ...env, store }).handleUpdate(update);
  } catch (err) {
    console.error('telegram update failed', err);
  }
  // Always 200, so Telegram doesn't keep re-sending an update we've already dealt with.
  return new Response('ok');
};

export const config = { path: ['/api/telegram', '/api/telegram/setup'] };
