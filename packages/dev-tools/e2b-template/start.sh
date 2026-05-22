#!/bin/sh
set -e

# Runtime env. (E2B v2 `setEnvs` is build-time only, so the template's runtime
# env has to be set here. node-server also has these as defaults when --hosted
# is passed, so these `export`s are belt-and-suspenders.)
export SLICC_HOSTED=1
export SLICC_SECRETS_FILE=/slicc/secrets.env
export CHROME_USER_DATA_DIR=/data/profile

# Redirect node-server stderr to a known path so the CLI can surface it on
# create-failure timeouts.
exec /opt/slicc/node-server/index.js --hosted --port 5710 --no-open 2>/tmp/slicc-stderr.log
