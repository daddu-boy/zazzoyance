#!/usr/bin/env bash
# Deploy Drape to Netlify (static files + the /api/ai edge function).
#   ./deploy.sh
# Uses the Netlify CLI login already on this machine (`npx netlify-cli login` once if needed).
set -euo pipefail
cd "$(dirname "$0")"
SITE="${NETLIFY_SITE:-drape-wardrobe}"
npx --yes netlify-cli@latest deploy --prod --dir . --site "$SITE" --message "deploy $(git rev-parse --short HEAD 2>/dev/null || date +%s)"
