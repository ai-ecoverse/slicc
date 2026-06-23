#!/bin/bash
set -euo pipefail

if [ -z "${SLICC_TEST_E2B_API_KEY:-}" ]; then
  echo "SLICC_TEST_E2B_API_KEY env var required" >&2
  exit 1
fi

export E2B_API_KEY="$SLICC_TEST_E2B_API_KEY"

# Which template alias to boot. Mirror build-template.sh's SLICC_E2B_TEMPLATE_NAME
# so verifying an isolated test build (e.g. 'slicc-test') boots that template
# instead of the live 'slicc' one. Defaults to 'slicc'.
export SLICC_E2B_TEMPLATE_NAME="${SLICC_E2B_TEMPLATE_NAME:-slicc}"

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
// Boot the same alias build-template.sh published (default "slicc"), so an
// isolated test build (SLICC_E2B_TEMPLATE_NAME=slicc-test) is what gets verified.
const TEMPLATE_NAME = process.env.SLICC_E2B_TEMPLATE_NAME || "slicc";

let sbx;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    sbx = await Sandbox.create(TEMPLATE_NAME, {
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
