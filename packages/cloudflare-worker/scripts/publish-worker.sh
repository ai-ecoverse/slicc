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
#   SLICC_LAST_RELEASE_TAG (empty means first release and always deploys).
set -euo pipefail

WRANGLER_CONFIG="packages/cloudflare-worker/wrangler.jsonc"
PREVIEW_WRANGLER_CONFIG="packages/cloudflare-worker/wrangler-preview.jsonc"
MAX_ATTEMPTS=6
SLEEP_BETWEEN=15

archive_assets() {
  # #1330 retention: re-put this build's entire content-hashed asset set on every
  # release, including worker-deploy skips. The 14-day age-based GC relies on the
  # refreshed last-modified timestamps to retain still-current chunks.
  echo "[publish-worker] Archiving assets to R2 (slicc-asset-archive)..."
  node packages/cloudflare-worker/scripts/upload-assets-to-r2.mjs slicc-asset-archive --dir dist/ui/assets
}

deploy_with_retry() {
  local label="$1"
  local config="$2"
  local log_path="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/wrangler-${label}-deploy.log"
  local out_path="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/wrangler-${label}-deploy.out"

  : > "$log_path"
  # Retries cover transient deploy failures. A routes-ONLY failure (script +
  # assets deployed, only route reconciliation failed) is detected below and
  # short-circuits the loop instead of retrying — the new version is already
  # live and re-deploying would just fail on the same route step.
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    echo "[publish-worker] Deploying $label worker (attempt $attempt/$MAX_ATTEMPTS)..."
    # Capture combined stdout+stderr so a failed attempt can be classified.
    # pipefail (set -o) makes the pipeline exit with wrangler's status, not tee's.
    if WRANGLER_LOG=debug WRANGLER_LOG_PATH="$log_path" npx wrangler deploy --config "$config" 2>&1 | tee "$out_path"; then
      echo "[publish-worker] $label worker deployed on attempt $attempt."
      return 0
    fi
    # A routes-ONLY failure means Wrangler uploaded AND activated the new version
    # (script + assets are live) but could not reconcile the worker's routes —
    # e.g. the deploy token lacks Zone -> Workers Routes -> Edit. Routes are
    # set-once and stable, so the new version is already serving and the release
    # must not be blocked by it. Any other failure is fatal and keeps retrying.
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

# TODO: Re-enable once template boots are self-contained (no sliccy.ai dependency).
# echo "[publish-worker] Verifying e2b template boots..."
# SLICC_TEST_E2B_API_KEY="$E2B_API_KEY" bash packages/dev-tools/e2b-template/scripts/verify-template.sh

echo "[publish-worker] Uploading worker secrets..."
echo "$CLOUDFLARE_TURN_API_TOKEN" | npx wrangler secret put CLOUDFLARE_TURN_API_TOKEN --config "$WRANGLER_CONFIG"
echo "$GITHUB_CLIENT_SECRET"      | npx wrangler secret put GITHUB_CLIENT_SECRET      --config "$WRANGLER_CONFIG"
echo "$E2B_API_KEY"               | npx wrangler secret put E2B_API_KEY               --config "$WRANGLER_CONFIG"

# Hard-fail before deploy if archiving fails; a build must never go live
# unarchived. The deploy path keeps its established template/secrets/archive order.
archive_assets

echo "[publish-worker] Deploying worker..."
deploy_with_retry "hub" "$WRANGLER_CONFIG"

# The preview worker (*.sliccy.now) shares the hub's URL-token format
# (`buildPreviewUrl` <-> `previewTokenFromHost`) and its Durable Object (bound
# via `script_name`). It MUST ship on every release or the two drift: a
# hub-only deploy that changes the preview URL format (e.g. #1355's user-hash
# label) leaves the stale preview worker unable to parse the new URLs, so every
# preview 404s "Preview not found". It has no secrets of its own (only the
# shared DO binding), so no secret upload is needed. Deployed AFTER the hub so
# the `script_name` DO reference resolves.
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
