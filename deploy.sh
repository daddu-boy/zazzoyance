#!/usr/bin/env bash
# Deploy Zazzoyance to Netlify (static files + the /api/ai edge function).
#   ./deploy.sh
# Uses the Netlify CLI login already on this machine (`npx netlify-cli login` once if needed).
CFG="$HOME/Library/Preferences/netlify/config.json"
if [ -z "${NETLIFY_AUTH_TOKEN:-}" ] && [ -f "$CFG" ]; then
  NETLIFY_AUTH_TOKEN="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(next((u["auth"]["token"] for u in d.get("users",{}).values() if u.get("auth",{}).get("token")), ""))' "$CFG")"
  export NETLIFY_AUTH_TOKEN
fi
set -euo pipefail
cd "$(dirname "$0")"
SITE="${NETLIFY_SITE:-fc674ed6-a068-4377-959c-cd4c8b661208}"  # zazzoyance.netlify.app
npx --yes netlify-cli@latest deploy --prod --dir . --site "$SITE" --message "deploy $(git rev-parse --short HEAD 2>/dev/null || date +%s)"
