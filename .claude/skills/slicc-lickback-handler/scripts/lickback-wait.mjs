#!/usr/bin/env node
// Long-poll the cup's chat channel: hold the SSE open and BLOCK until the next
// browser->brain frame arrives, then print it (one JSON line) and exit. This is the
// token-cheap replacement for the old drain + ndjson buffer + lickback-next polling
// loop — the handler calls this ONCE per message and the agent burns no tokens while
// it blocks. Holding the SSE pins the lease for the call's duration.
//
// The block is capped at ~580s (LICKBACK_WAIT_MS) to stay under Claude Code's 600s
// Bash ceiling; on the cap it exits cleanly so the handler just re-issues.
//
// Reads CUP_BASE + SLICC_SESSION (the session must already own the channel — claim
// first). Exit codes drive the handler loop:
//   0 + a frame on stdout   → a message arrived; answer it, then re-run.
//   0 + EMPTY stdout        → idle timeout (no message in the window); just re-run.
//   1                       → cup unreachable / SSE dropped → the cup is gone; STOP.
//   3                       → 409, the channel was claimed by another brain; STOP.
// Usage: lickback-wait.mjs [channel]
// tva
import { isDirectRun, parseSseData, pickChannel, requireEnv } from './_lib.mjs';

const WAIT_MS = Number.parseInt(process.env.LICKBACK_WAIT_MS ?? '', 10) || 580_000;

async function main() {
  const base = requireEnv('CUP_BASE');
  const session = requireEnv('SLICC_SESSION');
  const channel = pickChannel(process.argv.slice(2));

  const ctrl = new AbortController();
  // Idle cap: abort the (blocked) read so the process exits cleanly for a re-issue.
  const deadline = setTimeout(() => ctrl.abort(), WAIT_MS);
  const idle = () => {
    clearTimeout(deadline);
    process.exit(0); // idle timeout — no frame, empty stdout
  };
  const gone = (msg) => {
    clearTimeout(deadline);
    if (msg) process.stderr.write(`${msg}\n`);
    process.exit(1);
  };

  let res;
  try {
    res = await fetch(`${base}/api/lickback?channel=${encodeURIComponent(channel)}`, {
      headers: { Accept: 'text/event-stream', 'X-Slicc-Session': session },
      signal: ctrl.signal,
    });
  } catch (err) {
    if (ctrl.signal.aborted) idle();
    gone(`cup unreachable: ${err.message}`);
    return;
  }
  if (res.status === 409) {
    clearTimeout(deadline);
    process.stderr.write(`channel "${channel}" lost — another brain owns it.\n`);
    process.exit(3);
  }
  if (!res.ok || !res.body) gone(`cup returned HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) gone('SSE ended — cup gone'); // stream closed = cup went away
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const data = parseSseData(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (data) {
          clearTimeout(deadline);
          process.stdout.write(`${data}\n`);
          process.exit(0); // got the first frame — return it
        }
      }
    }
  } catch (err) {
    if (ctrl.signal.aborted) idle();
    gone(`stream error: ${err.message}`);
  }
}

if (isDirectRun(import.meta.url)) main();
