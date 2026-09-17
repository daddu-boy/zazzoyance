# Zazzoyance — a personal stylist in your phone

Photograph your clothes. Zazzoyance learns your wardrobe, checks the weather where you are, and tells you what to wear.

**Live:** https://zazzoyance.netlify.app — open it in Chrome on Android, then **⋮ → Add to Home screen / Install app**.

## What it does

- **Closet** — add clothes two ways:
  - *Just the clothes*: one photo per piece (a flat-lay of several works too).
  - *Photos of me wearing them*: Zazzoyance picks out every piece you're wearing, crops each one into your closet, and keeps the full photo under **Looks**.
- **Today** — live weather (Open-Meteo) for your location or any city, today or tomorrow. Pick the plan (work, date, wedding…) and tap **Style me** for three outfits built only from clothes you own. Tap **I'll wear this** to log it so Zazzoyance doesn't repeat it tomorrow.
- **Stylist** — a chat stylist that knows your closet and the forecast. Ask what to pack for a trip, what goes with a piece, or send a photo of something you're thinking of buying.
- **Works without AI** — with no key, you tag clothes yourself and a built-in rules engine (warmth vs temperature, dressiness vs occasion, rain, colour clashes, recently worn) picks outfits.

## The AI (Google Gemini)

Zazzoyance uses **Google Gemini** with your own **Google AI Studio** key. It never uses OpenAI or Netlify's AI Gateway, so no Netlify credits are spent on AI.

1. Create a key at https://aistudio.google.com/apikey.
2. In Netlify, go to **Project configuration → Environment variables** and add:

   | Variable | What it does |
   |---|---|
   | `GOOGLE_AI_STUDIO_KEY` | **Required.** Your AI Studio key (`AIza…`). Mark it as a secret. |
   | `APP_PASSCODE` | **Recommended.** Users enter it once in the **You** tab. Without it, anyone with the link can use your key. |
   | `GEMINI_MODEL` | Optional. Defaults to `gemini-2.5-flash`. |

3. Redeploy (`./deploy.sh`). New environment variables only take effect after a deploy.

The key stays on the server (`netlify/edge-functions/ai.js`), which only accepts calls from this site.

A person can also paste their own AI Studio key in the **You** tab. It stays in that browser, and the phone talks to Gemini directly.

**Free tier:** AI Studio keys on the free tier have daily request limits, and Google may use free-tier prompts to improve its products. Turn on billing in AI Studio to raise the limits and get paid-tier data terms.

## Where data lives

Everything — photos, closet, looks, chat — is stored **on the device** (IndexedDB). There is no database or account yet. Use **You → Back up** to download a JSON backup (API keys are never included) and **Restore** on another phone. Photos leave the phone only when AI is on, to be read by Google Gemini.

## Project layout

```
index.html, styles.css        the app shell (no build step)
js/app.js                     UI and flows
js/ai.js                      Gemini calls: photo tagging, outfit picks, chat
js/stylist.js                 offline stylist (rules engine)
js/weather.js                 Open-Meteo weather + city search
js/db.js                      IndexedDB storage
sw.js, manifest.webmanifest   installable PWA + offline shell
netlify/edge-functions/ai.js  server-side Gemini proxy (/api/ai)
dev-server.mjs                local server (mock AI with MOCK_AI=1)
deploy.sh                     deploy to Netlify
```

## Run locally

```bash
MOCK_AI=1 node dev-server.mjs          # fake AI replies, no credit used
GOOGLE_AI_STUDIO_KEY=AIza... node dev-server.mjs   # real AI
```

Open http://localhost:8130.

## What an MVP leaves for later

- Accounts + cloud database (Supabase or Firebase) so a closet follows you across devices
- Background removal for cleaner closet photos
- A native Android wrapper (Capacitor / TWA) for a Play Store listing
- Usage limits per user if the shared key is opened to the public
