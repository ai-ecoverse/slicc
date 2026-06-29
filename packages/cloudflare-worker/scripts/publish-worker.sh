#!/bin/bash
# Production worker release pipeline. Invoked by semantic-release via
# `npm run publish:worker` on each tagged release.
#
# Order is intentional:
# 1. Build + verify e2b template FIRST. If the template can't even boot, we
#    don't want a worker that depends on it going live.
# 2. Upload secrets BEFORE deploy (Wrangler ignores absent secrets at deploy
#    time but the new worker code references them at first request).
# 3. Deploy the worker.
# 4. Smoke-test the deployed worker with retry-with-backoff for edge propagation.
#
# Required env vars (set by semantic-release / release.yml):
#   CLOUDFLARE_TURN_API_TOKEN, GITHUB_CLIENT_SECRET, E2B_API_KEY,
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (the latter two consumed by wrangler).
set -euo pipefail

WRANGLER_CONFIG="packages/cloudflare-worker/wrangler.jsonc"
MAX_ATTEMPTS=6
SLEEP_BETWEEN=15

echo "[publish-worker] Building and pushing e2b template..."
bash packages/dev-tools/e2b-template/scripts/build-template.sh

# TODO: Re-enable once template boots are self-contained (no sliccy.ai dependency).
# echo "[publish-worker] Verifying e2b template boots..."
# SLICC_TEST_E2B_API_KEY="$E2B_API_KEY" bash packages/dev-tools/e2b-template/scripts/verify-template.sh

echo "[publish-worker] Uploading worker secrets..."
echo "$CLOUDFLARE_TURN_API_TOKEN" | npx wrangler secret put CLOUDFLARE_TURN_API_TOKEN --config "$WRANGLER_CONFIG"
echo "$GITHUB_CLIENT_SECRET"      | npx wrangler secret put GITHUB_CLIENT_SECRET      --config "$WRANGLER_CONFIG"
echo "$E2B_API_KEY"               | npx wrangler secret put E2B_API_KEY               --config "$WRANGLER_CONFIG"

echo "[publish-worker] Deploying worker..."
npx wrangler deploy --config "$WRANGLER_CONFIG"

echo "[publish-worker] Running deployed smoke tests (up to $MAX_ATTEMPTS attempts)..."
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  if npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/deployed.test.ts; then
    echo "[publish-worker] Smoke test passed on attempt $attempt."
    exit 0
  fi
  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    echo "[publish-worker] Smoke test failed after $MAX_ATTEMPTS attempts." >&2
    exit 1
  fi
  echo "[publish-worker] Smoke test failed on attempt $attempt; waiting ${SLEEP_BETWEEN}s for edge propagation..."
  sleep "$SLEEP_BETWEEN"
done
