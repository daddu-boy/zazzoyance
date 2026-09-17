# Drape — a personal stylist in your phone

Photograph your clothes. Drape learns your wardrobe, checks the weather where you are, and tells you what to wear.

**Live:** https://drape-wardrobe.netlify.app — open it in Chrome on Android, then **⋮ → Add to Home screen / Install app**.

## What it does

- **Closet** — add clothes two ways:
  - *Just the clothes*: one photo per piece (a flat-lay of several works too).
  - *Photos of me wearing them*: Drape picks out every piece you're wearing, crops each one into your closet, and keeps the full photo under **Looks**.
- **Today** — live weather (Open-Meteo) for your location or any city, today or tomorrow. Pick the plan (work, date, wedding…) and tap **Style me** for three outfits built only from clothes you own. Tap **I'll wear this** to log it so Drape doesn't repeat it tomorrow.
- **Stylist** — a chat stylist that knows your closet and the forecast. Ask what to pack for a trip, what goes with a piece, or send a photo of something you're thinking of buying.
- **Works without AI** — with no key, you tag clothes yourself and a built-in rules engine (warmth vs temperature, dressiness vs occasion, rain, colour clashes, recently worn) picks outfits.

## Turning on the AI

Drape uses the OpenAI API. **A ChatGPT Plus subscription does not include API access** — the API is billed separately at https://platform.openai.com (add a few dollars of credit; the default model, `gpt-5-mini`, costs a fraction of a cent per photo).

Two ways to connect:

1. **For everyone who uses your site (recommended).** In Netlify → *Site configuration → Environment variables*, add:
   | Variable | Value |
   |---|---|
   | `OPENAI_API_KEY` | your key (`sk-…`) — **required** |
   | `APP_PASSCODE` | any word — **strongly recommended**, otherwise anyone with the link can spend your credit |
   | `OPENAI_MODEL` | optional, defaults to `gpt-5-mini` |

   Then redeploy (`./deploy.sh`). The key stays on the server (`netlify/edge-functions/ai.js`). Users enter the passcode once in the **You** tab.
2. **Just for one phone.** Paste an API key in the **You** tab. It is stored only in that browser and the phone talks to OpenAI directly.

## Where data lives

Everything — photos, closet, looks, chat — is stored **on the device** (IndexedDB). There is no database or account yet. Use **You → Back up** to download a JSON backup (API keys are never included) and **Restore** on another phone. Photos leave the phone only when AI is on, to be read by OpenAI.

## Project layout

```
index.html, styles.css        the app shell (no build step)
js/app.js                     UI and flows
js/ai.js                      OpenAI calls: photo tagging, outfit picks, chat
js/stylist.js                 offline stylist (rules engine)
js/weather.js                 Open-Meteo weather + city search
js/db.js                      IndexedDB storage
sw.js, manifest.webmanifest   installable PWA + offline shell
netlify/edge-functions/ai.js  server-side OpenAI proxy (/api/ai)
dev-server.mjs                local server (mock AI with MOCK_AI=1)
deploy.sh                     deploy to Netlify
```

## Run locally

```bash
MOCK_AI=1 node dev-server.mjs          # fake AI replies, no credit used
OPENAI_API_KEY=sk-... node dev-server.mjs   # real AI
```

Open http://localhost:8130.

## What an MVP leaves for later

- Accounts + cloud database (Supabase or Firebase) so a closet follows you across devices
- Background removal for cleaner closet photos
- A native Android wrapper (Capacitor / TWA) for a Play Store listing
- Usage limits per user if the shared key is opened to the public
