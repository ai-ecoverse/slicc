#!/bin/bash
set -e

# Runtime env. (E2B v2 `setEnvs` is build-time only, so the template's runtime
# env has to be set here. node-server also has these as defaults when --hosted
# is passed, so these `export`s are belt-and-suspenders.)
export SLICC_HOSTED=1
export SLICC_SECRETS_FILE=/slicc/secrets.env
export CHROME_USER_DATA_DIR=/data/profile

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

# Tee stderr to /tmp/slicc-stderr.log AND keep it on container stderr so it
# surfaces in e2b build logs (otherwise build-time failures are blind).
# tee in a process-substitution preserves the exec's exit code.
exec node /opt/slicc/node-server/index.js --hosted --port 5710 --no-open \
  2> >(tee /tmp/slicc-stderr.log >&2)
