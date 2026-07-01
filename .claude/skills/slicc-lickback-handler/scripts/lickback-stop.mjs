#!/usr/bin/env node
// Stand the chat handler DOWN without stopping the cup (the takeover-hack
// replacement). POSTs /api/lickback/stop, which releases the channel owner and
// ends the handler's open SSE so its blocked `lickback-wait` returns exit 4 and the
// handler stops — while SLICC keeps running. Reads CUP_BASE; uses SLICC_SESSION if
// set, else mints one (the route is loopback-trusted, NOT owner-gated, so any
// session works — the steerer never owns the channel). Always exits 0.
// Usage: lickback-stop.mjs [channel]
// tva
import { randomUUID } from 'node:crypto';
import { isDirectRun, pickChannel, postLickback, requireEnv } from './_lib.mjs';

async function main() {
  let base;
  try {
    base = requireEnv('CUP_BASE');
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(0); // nothing to stop without a cup base
  }
  const session = process.env.SLICC_SESSION || randomUUID();
  const channel = pickChannel(process.argv.slice(2));
  try {
    const res = await postLickback(base, '/api/lickback/stop', session, { channel });
    let stopped = false;
    try {
      stopped = (await res.json())?.stopped === true;
    } catch {
      /* treat a missing/garbled body as not-stopped */
    }
    process.stdout.write(
      stopped
        ? 'Stopped the chat handler — SLICC is still running.\n'
        : 'No active chat handler to stop — SLICC is still running.\n'
    );
  } catch {
    process.stdout.write('No cup reachable — nothing to stop.\n');
  }
  process.exit(0);
}

if (isDirectRun(import.meta.url)) main();
