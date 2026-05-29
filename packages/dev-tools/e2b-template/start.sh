#!/bin/bash
set -e

# Runtime env. SLICC_SECRETS_FILE is load-bearing — without it, node-server
# would default to ~/.slicc/secrets.env (the laptop CLI path) inside the
# sandbox, where nothing exists. CHROME_USER_DATA_DIR matches the --hosted
# default and is belt-and-suspenders.
#
# SLICC_CDP_LAUNCH_TIMEOUT_MS: chromium cold-starts on every new sandbox
# (template snapshot has no running processes — see template.ts setStartCmd
# waitForFile). 15s default is too tight for a cold microVM; 60s gives
# generous headroom without making real failures wait too long.
export SLICC_SECRETS_FILE=/slicc/secrets.env
export CHROME_USER_DATA_DIR=/data/profile
export SLICC_CDP_LAUNCH_TIMEOUT_MS=60000

# --- Cone config preboot (race-free: write files before node-server boots) ---
mkdir -p /slicc
if [ -n "$SLICC_SECRETS_ENV_B64" ]; then
  printf '%s' "$SLICC_SECRETS_ENV_B64" | base64 -d > /slicc/secrets.env
  unset SLICC_SECRETS_ENV_B64
elif [ -n "$ADOBE_IMS_TOKEN" ] && [ ! -f /slicc/secrets.env ]; then
  # Back-compat: older worker images only pass ADOBE_IMS_TOKEN.
  {
    printf 'ADOBE_IMS_TOKEN=%s\n' "$ADOBE_IMS_TOKEN"
    printf 'ADOBE_IMS_TOKEN_DOMAINS=%s\n' "$ADOBE_IMS_TOKEN_DOMAINS"
  } > /slicc/secrets.env
fi
# The bearer now lives in /slicc/secrets.env; don't leave it in node-server's
# process env (printenv / /proc/self/environ) for the cone's lifetime.
unset ADOBE_IMS_TOKEN ADOBE_IMS_TOKEN_DOMAINS

if [ -n "$SLICC_CONE_CONFIG_B64" ]; then
  printf '%s' "$SLICC_CONE_CONFIG_B64" | base64 -d > /slicc/cone-config.json
  unset SLICC_CONE_CONFIG_B64
fi

# Clear stale /tmp/slicc-join.json that the template snapshot baked in.
# E2B's template build waits for this file to appear before snapshotting, so
# every cloned sandbox starts with a build-time stale copy. node-server will
# write a fresh one once it registers a tray; pollCloudStatus reads the
# freshly-stamped updatedAt and rejects the stale snapshot anyway, but
# clearing the file gives us deterministic empty-→-fresh transition.
rm -f /tmp/slicc-join.json

# Tee stderr to /tmp/slicc-stderr.log AND keep it on container stderr so it
# surfaces in e2b build logs (otherwise build-time failures are blind).
# tee in a process-substitution preserves the exec's exit code.
exec node /opt/slicc/node-server/index.js --hosted --port 5710 --no-open \
  2> >(tee /tmp/slicc-stderr.log >&2)
