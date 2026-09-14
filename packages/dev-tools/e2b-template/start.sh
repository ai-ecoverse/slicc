#!/bin/bash
set -e










export SLICC_SECRETS_FILE=/slicc/secrets.env
export CHROME_USER_DATA_DIR=/data/profile
export SLICC_CDP_LAUNCH_TIMEOUT_MS=60000


mkdir -p /slicc
if [ -n "$SLICC_SECRETS_ENV_B64" ]; then
  if ! printf '%s' "$SLICC_SECRETS_ENV_B64" | base64 -d > /slicc/secrets.env; then
    echo "FATAL: failed to base64-decode SLICC_SECRETS_ENV_B64" >&2
    exit 1
  fi
  unset SLICC_SECRETS_ENV_B64
elif [ -n "$ADOBE_IMS_TOKEN" ] && [ ! -f /slicc/secrets.env ]; then

  if ! {
    printf 'ADOBE_IMS_TOKEN=%s\n' "$ADOBE_IMS_TOKEN"
    printf 'ADOBE_IMS_TOKEN_DOMAINS=%s\n' "$ADOBE_IMS_TOKEN_DOMAINS"
  } > /slicc/secrets.env; then
    echo "FATAL: failed to write /slicc/secrets.env (back-compat path)" >&2
    exit 1
  fi
fi


unset ADOBE_IMS_TOKEN ADOBE_IMS_TOKEN_DOMAINS

if [ -n "$SLICC_CONE_CONFIG_B64" ]; then
  if ! printf '%s' "$SLICC_CONE_CONFIG_B64" | base64 -d > /slicc/cone-config.json; then
    echo "FATAL: failed to base64-decode SLICC_CONE_CONFIG_B64" >&2
    exit 1
  fi
  unset SLICC_CONE_CONFIG_B64
fi







rm -f /tmp/slicc-join.json




exec node /opt/slicc/node-server/index.js --hosted --port 5710 --no-open \
  2> >(tee /tmp/slicc-stderr.log >&2)
