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

# Spin a sandbox, poll for /tmp/slicc-join.json, kill. The whole boot+poll
# cycle is retried up to MAX_ATTEMPTS times with linear backoff: a freshly
# published template occasionally either (a) exceeds the e2b SDK's default 30s
# create `requestTimeoutMs` while the build is still cold, or (b) creates fine
# but its in-sandbox startup hasn't written the join file before the poll budget
# elapses. Both failure modes get a fresh sandbox rather than failing the run.
#
# The long create timeout is intentionally NOT carried over to the post-create
# polling / kill calls: `requestTimeoutMs` set on `Sandbox.create` becomes the
# default for every subsequent method on the returned sandbox, so a hung envd
# read would stall up to 120s per attempt and blow past the join-poll budget.
# We pass a short per-call `requestTimeoutMs` to `files.read` and `kill` so the
# poll loop's wall-clock budget (SLICC_E2B_JOIN_TIMEOUT_MS, default 120s) is
# what actually bounds each attempt.
node --input-type=module -e '
import { Sandbox } from "e2b";

const MAX_ATTEMPTS = 3;
const CREATE_TIMEOUT_MS = 120_000;
const POST_CREATE_TIMEOUT_MS = 10_000;
const BACKOFF_MS = 5_000;
// How long to poll for the in-sandbox startup to write /tmp/slicc-join.json
// after create returns. A cold first boot can lag well past the old hard-coded
// 60s budget, which was the dominant smoke-test flake; override via env if a
// future template needs longer.
const JOIN_TIMEOUT_MS = Number(process.env.SLICC_E2B_JOIN_TIMEOUT_MS) || 120_000;
// Boot the same alias build-template.sh published (default "slicc"), so an
// isolated test build (SLICC_E2B_TEMPLATE_NAME=slicc-test) is what gets verified.
const TEMPLATE_NAME = process.env.SLICC_E2B_TEMPLATE_NAME || "slicc";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let joinJson = null;
for (let attempt = 1; attempt <= MAX_ATTEMPTS && !joinJson?.joinUrl; attempt++) {
  let sbx;
  try {
    sbx = await Sandbox.create(TEMPLATE_NAME, {
      lifecycle: { onTimeout: "kill" },
      requestTimeoutMs: CREATE_TIMEOUT_MS,
    });
    console.log("created", sbx.sandboxId, "(attempt " + attempt + ")");
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error("Sandbox.create attempt " + attempt + " failed: " + msg);
    if (attempt === MAX_ATTEMPTS) {
      console.error("FAIL: Sandbox.create failed after " + MAX_ATTEMPTS + " attempts");
      throw err;
    }
    await sleep(BACKOFF_MS * attempt);
    continue;
  }

  const start = Date.now();
  while (Date.now() - start < JOIN_TIMEOUT_MS) {
    try {
      const text = await sbx.files.read("/tmp/slicc-join.json", {
        requestTimeoutMs: POST_CREATE_TIMEOUT_MS,
      });
      const parsed = JSON.parse(text);
      if (parsed.joinUrl) {
        joinJson = parsed;
        break;
      }
    } catch {}
    await sleep(500);
  }

  // Best-effort cleanup: a kill that rejects (E2B/API timeout or other error)
  // must not abort the retry loop before attempts 2-3 get a fresh sandbox.
  try {
    await sbx.kill({ requestTimeoutMs: POST_CREATE_TIMEOUT_MS });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error("sandbox kill on attempt " + attempt + " failed (ignored): " + msg);
  }
  if (!joinJson?.joinUrl) {
    console.error("join URL not ready within " + JOIN_TIMEOUT_MS + "ms on attempt " + attempt);
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS * attempt);
  }
}

if (!joinJson?.joinUrl) {
  console.error("FAIL: /tmp/slicc-join.json never produced joinUrl after " + MAX_ATTEMPTS + " attempts");
  process.exit(1);
}
console.log("OK", joinJson.joinUrl);
'
