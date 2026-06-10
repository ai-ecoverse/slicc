#!/bin/bash
set -euo pipefail

# TEMPORARY (e2b out of credits): mirror build-template.sh — when
# SLICC_SKIP_E2B_TEMPLATE=1, skip booting a verification sandbox (which also
# consumes credits) and exit 0. Remove once e2b credits are restored.
if [ "${SLICC_SKIP_E2B_TEMPLATE:-}" = "1" ]; then
  echo "[verify-template] SLICC_SKIP_E2B_TEMPLATE=1 set — skipping e2b template boot verification (account out of credits)."
  exit 0
fi

if [ -z "${SLICC_TEST_E2B_API_KEY:-}" ]; then
  echo "SLICC_TEST_E2B_API_KEY env var required" >&2
  exit 1
fi

export E2B_API_KEY="$SLICC_TEST_E2B_API_KEY"

# Spin one sandbox, poll for /tmp/slicc-join.json, kill.
#
# `Sandbox.create` against a freshly published template occasionally exceeds the
# e2b SDK's default 30s `requestTimeoutMs` while the build is still cold. We
# bump the per-call timeout to 2 minutes and retry the create up to 3 times
# with linear backoff before giving up.
#
# The long create timeout is intentionally NOT carried over to the post-create
# polling / kill calls: `requestTimeoutMs` set on `Sandbox.create` becomes the
# default for every subsequent method on the returned sandbox, so a hung envd
# read would stall up to 120s per attempt and blow past the 60s poll budget.
# We pass a short per-call `requestTimeoutMs` to `files.read` and `kill` so
# the poll loop's wall-clock budget is what actually bounds the script.
node --input-type=module -e '
import { Sandbox } from "e2b";

const MAX_ATTEMPTS = 3;
const CREATE_TIMEOUT_MS = 120_000;
const POST_CREATE_TIMEOUT_MS = 10_000;
const BACKOFF_MS = 5_000;

let sbx;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    sbx = await Sandbox.create("slicc", {
      lifecycle: { onTimeout: "kill" },
      requestTimeoutMs: CREATE_TIMEOUT_MS,
    });
    console.log("created", sbx.sandboxId, "(attempt " + attempt + ")");
    break;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error("Sandbox.create attempt " + attempt + " failed: " + msg);
    if (attempt === MAX_ATTEMPTS) {
      console.error("FAIL: Sandbox.create failed after " + MAX_ATTEMPTS + " attempts");
      throw err;
    }
    await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
  }
}

const start = Date.now();
let joinJson = null;
while (Date.now() - start < 60_000) {
  try {
    const text = await sbx.files.read("/tmp/slicc-join.json", {
      requestTimeoutMs: POST_CREATE_TIMEOUT_MS,
    });
    joinJson = JSON.parse(text);
    if (joinJson.joinUrl) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

await sbx.kill({ requestTimeoutMs: POST_CREATE_TIMEOUT_MS });
if (!joinJson?.joinUrl) {
  console.error("FAIL: /tmp/slicc-join.json never produced joinUrl");
  process.exit(1);
}
console.log("OK", joinJson.joinUrl);
'
