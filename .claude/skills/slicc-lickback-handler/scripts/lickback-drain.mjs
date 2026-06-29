#!/usr/bin/env node
// Hold the channel's SSE drain open and append every browser->brain frame to a
// per-session ndjson buffer that `lickback-next` consumes. Reads CUP_BASE +
// SLICC_SESSION. Holding the stream pins the lease, so no heartbeat is needed
// while this runs. Reconnects on a dropped stream; exits 3 if the channel is
// lost (409) and 1 if the cup stays unreachable. Runs until killed.
// Usage: lickback-drain.mjs [channel]
// tva
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bufferPathsFor,
  DEFAULT_PORT,
  drainPidfileName,
  drainsDir,
  isDirectRun,
  lickbackDir,
  nextFailCount,
  parseSseData,
  pickChannel,
  requireEnv,
} from './_lib.mjs';

const RECONNECT_MS = Number.parseInt(process.env.LICKBACK_DRAIN_RECONNECT_MS ?? '', 10) || 1000;
const MAX_FAILS = Number.parseInt(process.env.LICKBACK_DRAIN_MAX_FAILS ?? '', 10) || 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One connect-and-stream attempt. Returns:
//   'lost'      — 409, the channel was claimed by another session (exit 3).
//   'refused'   — never connected (fetch threw, or a non-ok / body-less response);
//                 counts toward the reconnect budget.
//   'connected' — reached the streaming read loop. Resets the budget (F6) whether
//                 the stream then ends cleanly OR drops mid-read: the lick-back SSE
//                 endpoint never ends cleanly, so a long-lived healthy stream that
//                 later drops must NOT be charged as a failure.
async function streamOnce(base, session, channel, ndjson) {
  let res;
  try {
    res = await fetch(`${base}/api/lickback?channel=${encodeURIComponent(channel)}`, {
      headers: { Accept: 'text/event-stream', 'X-Slicc-Session': session },
    });
  } catch {
    return 'refused';
  }
  if (res.status === 409) return 'lost';
  if (!res.ok || !res.body) return 'refused';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return 'connected';
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const data = parseSseData(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (data) appendFileSync(ndjson, `${data}\n`);
      }
    }
  } catch {
    return 'connected'; // streamed then dropped — a healthy connection, not a failure
  }
}

async function main() {
  const base = requireEnv('CUP_BASE');
  const session = requireEnv('SLICC_SESSION');
  const channel = pickChannel(process.argv.slice(2));
  mkdirSync(lickbackDir(), { recursive: true });
  // F7: do NOT truncate the buffer or reset the cursor on start. A same-session
  // drain restart must preserve frames a prior drain delivered LIVE but
  // lickback-next hasn't consumed yet — they live only here (the server queue
  // already dequeued them), so wiping silently drops the human's message and
  // hangs the panel spinner. The ndjson is created on first append; a missing
  // cursor reads as 0 in lickback-next. (A fresh brain has a fresh SLICC_SESSION,
  // hence a fresh buffer path, so this only resumes a genuine same-session restart.)
  const { ndjson } = bufferPathsFor(session, channel);
  // Advertise this drain (named `<cupPort>-<pid>`) so a future brain's bootstrap reaper
  // can find and kill it if THIS session dies without releasing the channel — the orphan
  // drain is what pins the claim open. Cleared on a clean exit; a SIGKILL leaves a stale
  // file that the next reaper removes anyway.
  mkdirSync(drainsDir(), { recursive: true });
  const port = Number(new URL(base).port) || DEFAULT_PORT;
  const pidfile = join(drainsDir(), drainPidfileName(port, process.pid));
  writeFileSync(pidfile, String(process.pid));
  const removePidfile = () => {
    try {
      rmSync(pidfile);
    } catch {
      /* best-effort */
    }
  };
  process.on('exit', removePidfile);
  process.on('SIGTERM', () => process.exit(143));
  process.on('SIGINT', () => process.exit(130));
  let fails = 0;
  for (;;) {
    const outcome = await streamOnce(base, session, channel, ndjson);
    if (outcome === 'lost') {
      process.stderr.write(`Channel "${channel}" lost — exiting drain.\n`);
      process.exit(3);
    }
    fails = nextFailCount(outcome, fails);
    if (fails > MAX_FAILS) {
      process.stderr.write('Cup unreachable — exiting drain.\n');
      process.exit(1);
    }
    await sleep(RECONNECT_MS);
  }
}

if (isDirectRun(import.meta.url)) main();
