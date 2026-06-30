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
//   4                       → operator stood the handler down (an `event: lickback-control`
//                             frame) → the cup is STILL UP; STOP without relaunch / re-claim.
// Usage: lickback-wait.mjs [channel]
// tva
import {
  isDirectRun,
  isStopControl,
  parseSseData,
  pickChannel,
  requireEnv,
  takeSseBlocks,
} from './_lib.mjs';

const WAIT_MS = Number.parseInt(process.env.LICKBACK_WAIT_MS ?? '', 10) || 580_000;

/**
 * Read SSE blocks from `reader` until one yields an outcome, returning it for the
 * caller to map to an exit. Each read's `value` is scanned BEFORE acting on `done`
 * so a stand-down control frame coalesced with the stream end still wins over the
 * generic "cup gone". Outcomes: `frame` (a message), `stop` (operator stand-down),
 * `idle` (the read was aborted by the idle cap), `gone` (the cup/stream died).
 */
async function consumeStream(reader, decoder, signal) {
  let buf = '';
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err?.name === 'AbortError') return { kind: 'idle' };
      return { kind: 'gone', msg: `stream error: ${err.message}` };
    }
    if (chunk.value) {
      buf += decoder.decode(chunk.value, { stream: true });
      const { blocks, rest } = takeSseBlocks(buf);
      buf = rest;
      for (const block of blocks) {
        if (isStopControl(block)) return { kind: 'stop' };
        const data = parseSseData(block); // null for `: ping` keepalive comments
        if (data) return { kind: 'frame', data };
      }
    }
    if (chunk.done) {
      // A clean stream end means the cup went away — unless the idle cap caused it.
      return signal.aborted ? { kind: 'idle' } : { kind: 'gone', msg: 'SSE ended — cup gone' };
    }
  }
}

async function main() {
  const base = requireEnv('CUP_BASE');
  const session = requireEnv('SLICC_SESSION');
  const channel = pickChannel(process.argv.slice(2));

  const ctrl = new AbortController();
  // Idle cap: abort the (blocked) read so the process exits cleanly for a re-issue.
  // `.unref()` so a stray timer can never keep the process alive past an exit.
  const deadline = setTimeout(() => ctrl.abort(), WAIT_MS);
  deadline.unref?.();
  const idle = () => {
    clearTimeout(deadline);
    process.exit(0); // idle cap reached — no frame, empty stdout
  };
  const gone = (msg, code = 1) => {
    clearTimeout(deadline);
    if (msg) process.stderr.write(`${msg}\n`);
    process.exit(code);
  };
  // The idle cap aborts the fetch/read, which throws an `AbortError`. Detect THAT
  // specifically — not just `ctrl.signal.aborted` — so a real cup-death error that
  // happens to coincide with the cap routes to `gone` (stop), not `idle` (re-issue).
  const isAbort = (err) => err?.name === 'AbortError';

  let res;
  try {
    res = await fetch(`${base}/api/lickback?channel=${encodeURIComponent(channel)}`, {
      headers: { Accept: 'text/event-stream', 'X-Slicc-Session': session },
      signal: ctrl.signal,
    });
  } catch (err) {
    if (isAbort(err)) idle();
    else gone(`cup unreachable: ${err.message}`);
    return;
  }
  if (res.status === 409) gone(`channel "${channel}" lost — another brain owns it.`, 3);
  if (!res.ok || !res.body) gone(`cup returned HTTP ${res.status}`);

  const outcome = await consumeStream(res.body.getReader(), new TextDecoder(), ctrl.signal);
  if (outcome.kind === 'frame') {
    clearTimeout(deadline);
    process.stdout.write(`${outcome.data}\n`);
    process.exit(0); // got the first frame — return it
  }
  if (outcome.kind === 'stop') {
    clearTimeout(deadline);
    process.exit(4); // operator stand-down — cup is up; STOP, no relaunch/re-claim
  }
  if (outcome.kind === 'idle') idle(); // idle cap — no frame, empty stdout
  gone(outcome.msg); // cup/stream died
}

if (isDirectRun(import.meta.url)) main();
