#!/usr/bin/env node
// Hold the channel's SSE drain open and append every browser->brain frame to a
// per-session ndjson buffer that `lickback-next` consumes. Reads CUP_BASE +
// SLICC_SESSION. Holding the stream pins the lease, so no heartbeat is needed
// while this runs. Reconnects on a dropped stream; exits 3 if the channel is
// lost (409) and 1 if the cup stays unreachable. Runs until killed.
// Usage: lickback-drain.mjs [channel]
// tva
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  bufferPathsFor,
  isDirectRun,
  lickbackDir,
  parseSseData,
  pickChannel,
  requireEnv,
} from './_lib.mjs';

const RECONNECT_MS = Number.parseInt(process.env.LICKBACK_DRAIN_RECONNECT_MS ?? '', 10) || 1000;
const MAX_FAILS = Number.parseInt(process.env.LICKBACK_DRAIN_MAX_FAILS ?? '', 10) || 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamOnce(base, session, channel, ndjson) {
  const res = await fetch(`${base}/api/lickback?channel=${encodeURIComponent(channel)}`, {
    headers: { Accept: 'text/event-stream', 'X-Slicc-Session': session },
  });
  if (res.status === 409) return 'lost';
  if (!res.ok || !res.body) return 'error';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return 'disconnected';
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const data = parseSseData(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (data) appendFileSync(ndjson, `${data}\n`);
    }
  }
}

async function main() {
  const base = requireEnv('CUP_BASE');
  const session = requireEnv('SLICC_SESSION');
  const channel = pickChannel(process.argv.slice(2));
  mkdirSync(lickbackDir(), { recursive: true });
  const { ndjson, cursor } = bufferPathsFor(session, channel);
  writeFileSync(ndjson, ''); // fresh buffer for this run
  writeFileSync(cursor, '0'); // reset the consumer cursor
  let fails = 0;
  for (;;) {
    let outcome;
    try {
      outcome = await streamOnce(base, session, channel, ndjson);
    } catch {
      outcome = 'error';
    }
    if (outcome === 'lost') {
      process.stderr.write(`Channel "${channel}" lost — exiting drain.\n`);
      process.exit(3);
    }
    if (outcome === 'disconnected') fails = 0;
    else fails++;
    if (fails > MAX_FAILS) {
      process.stderr.write('Cup unreachable — exiting drain.\n');
      process.exit(1);
    }
    await sleep(RECONNECT_MS);
  }
}

if (isDirectRun(import.meta.url)) main();
