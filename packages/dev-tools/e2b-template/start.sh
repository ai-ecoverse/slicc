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

# Bootstrap secrets.env from sandbox env vars when present. Both the laptop CLI
# (Plan B) and the Cloudflare worker (Plan D) inject ADOBE_IMS_TOKEN via
# Sandbox.create({ envs: ... }) so the page-side hosted-bootstrap fetch finds
# the token even on the very first poll.
#
# Backwards compat: if /slicc/secrets.env already exists (CLI uploaded the full
# filtered file via handle.writeFile right after Sandbox.create), don't
# overwrite — the full payload includes non-Adobe secrets the agent needs.
mkdir -p /slicc
if [ -n "$ADOBE_IMS_TOKEN" ] && [ ! -f /slicc/secrets.env ]; then
  cat > /slicc/secrets.env <<EOF
ADOBE_IMS_TOKEN=$ADOBE_IMS_TOKEN
ADOBE_IMS_TOKEN_DOMAINS=${ADOBE_IMS_TOKEN_DOMAINS:-adobe-llm-proxy.paolo-moz.workers.dev}
EOF
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
