#!/bin/bash
set -euo pipefail

if [ -z "${SLICC_TEST_E2B_API_KEY:-}" ]; then
  echo "SLICC_TEST_E2B_API_KEY env var required" >&2
  exit 1
fi

export E2B_API_KEY="$SLICC_TEST_E2B_API_KEY"

# Spin one sandbox, poll for /tmp/slicc-join.json, kill.
node --input-type=module -e '
import { Sandbox } from "e2b";

const sbx = await Sandbox.create("slicc", { autoPause: false });
console.log("created", sbx.sandboxId);

const start = Date.now();
let joinJson = null;
while (Date.now() - start < 60_000) {
  try {
    const text = await sbx.files.read("/tmp/slicc-join.json");
    joinJson = JSON.parse(text);
    if (joinJson.joinUrl) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

await sbx.kill();
if (!joinJson?.joinUrl) {
  console.error("FAIL: /tmp/slicc-join.json never produced joinUrl");
  process.exit(1);
}
console.log("OK", joinJson.joinUrl);
'
