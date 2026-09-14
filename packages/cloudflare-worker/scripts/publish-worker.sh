#!/bin/bash

















set -euo pipefail

WRANGLER_CONFIG="packages/cloudflare-worker/wrangler.jsonc"
PREVIEW_WRANGLER_CONFIG="packages/cloudflare-worker/wrangler-preview.jsonc"
MAX_ATTEMPTS=6
SLEEP_BETWEEN=15

archive_assets() {



  echo "[publish-worker] Archiving assets to R2 (slicc-asset-archive)..."
  node packages/cloudflare-worker/scripts/upload-assets-to-r2.mjs slicc-asset-archive --dir dist/ui/assets
}

deploy_with_retry() {
  local label="$1"
  local config="$2"
  local log_path="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/wrangler-${label}-deploy.log"
  local out_path="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/wrangler-${label}-deploy.out"

  : > "$log_path"




  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    echo "[publish-worker] Deploying $label worker (attempt $attempt/$MAX_ATTEMPTS)..."


    if WRANGLER_LOG=debug WRANGLER_LOG_PATH="$log_path" npx wrangler deploy --config "$config" 2>&1 | tee "$out_path"; then
      echo "[publish-worker] $label worker deployed on attempt $attempt."
      return 0
    fi





    if [ "$(node packages/dev-tools/tools/release-native.mjs --classify-deploy-log "$out_path" || echo fatal)" = "routes-only" ]; then
      echo "[publish-worker] WARNING: $label worker script + assets deployed and are LIVE, but route reconciliation failed (deploy token lacks Zone -> Workers Routes -> Edit for the zone). Routes are stable/already-assigned, so the new version is serving. Treating as deployed." >&2
      echo "[publish-worker] WARNING: if this release CHANGED routes in $config, they did NOT apply until the token permission is restored — see packages/cloudflare-worker/CLAUDE.md 'Ops Runbook'." >&2
      return 0
    fi
    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "[publish-worker] $label worker deploy failed after $MAX_ATTEMPTS attempts." >&2
      echo "[publish-worker] Wrangler debug log ($log_path):" >&2
      cat "$log_path" >&2
      return 1
    fi
    echo "[publish-worker] $label worker deploy failed on attempt $attempt; waiting ${SLEEP_BETWEEN}s before retrying..." >&2
    sleep "$SLEEP_BETWEEN"
  done
}

WORKER_GATE="$(node packages/dev-tools/tools/release-native.mjs --gate=worker --last="${SLICC_LAST_RELEASE_TAG:-}")"
if [ "$WORKER_GATE" = "skip" ]; then
  archive_assets
  echo "[publish-worker] Skipping worker deploy (no worker/UI-relevant changes)."
  exit 0
fi
if [ "$WORKER_GATE" != "deploy" ]; then
  echo "[publish-worker] Unexpected worker gate result: $WORKER_GATE" >&2
  exit 1
fi

echo "[publish-worker] Building and pushing e2b template..."
bash packages/dev-tools/e2b-template/scripts/build-template.sh







archive_assets
node packages/cloudflare-worker/scripts/verify-preview-lifecycle.mjs sliccy-now-basic-storage

echo "[publish-worker] Uploading worker secrets..."
echo "$CLOUDFLARE_TURN_API_TOKEN" | npx wrangler secret put CLOUDFLARE_TURN_API_TOKEN --config "$WRANGLER_CONFIG"
echo "$GITHUB_CLIENT_SECRET"      | npx wrangler secret put GITHUB_CLIENT_SECRET      --config "$WRANGLER_CONFIG"
echo "$E2B_API_KEY"               | npx wrangler secret put E2B_API_KEY               --config "$WRANGLER_CONFIG"


if [ -n "${APNS_PRIVATE_KEY:-}" ]; then
  echo "$APNS_TEAM_ID"     | npx wrangler secret put APNS_TEAM_ID     --config "$WRANGLER_CONFIG"
  echo "$APNS_KEY_ID"      | npx wrangler secret put APNS_KEY_ID      --config "$WRANGLER_CONFIG"
  printf '%s' "$APNS_PRIVATE_KEY" | npx wrangler secret put APNS_PRIVATE_KEY --config "$WRANGLER_CONFIG"
  echo "$APNS_TOPIC"       | npx wrangler secret put APNS_TOPIC       --config "$WRANGLER_CONFIG"
else
  echo "[publish-worker] APNS_PRIVATE_KEY not set; skipping APNs secrets (follower push stays disabled)."
fi

echo "[publish-worker] Deploying worker..."
deploy_with_retry "hub" "$WRANGLER_CONFIG"









echo "[publish-worker] Deploying preview worker (must ship with the hub)..."
deploy_with_retry "preview" "$PREVIEW_WRANGLER_CONFIG"

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
