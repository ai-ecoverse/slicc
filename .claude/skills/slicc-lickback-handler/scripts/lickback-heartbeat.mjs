#!/usr/bin/env node
// Renew the channel lease WITHOUT holding the SSE drain (only needed if you
// dropped the stream between long replies). Reads CUP_BASE + SLICC_SESSION.
// Exit 0 renewed; 3 lost (stand down); 1 error. Usage: lickback-heartbeat.mjs [channel]
// tva
import { exitForOwnership, isDirectRun, pickChannel, postLickback, requireEnv } from './_lib.mjs';

async function main() {
  let base;
  let session;
  try {
    base = requireEnv('CUP_BASE');
    session = requireEnv('SLICC_SESSION');
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  const channel = pickChannel(process.argv.slice(2));
  try {
    const res = await postLickback(base, '/api/lickback/heartbeat', session, { channel });
    const code = exitForOwnership(res.status);
    if (code === 3) process.stderr.write(`Lost channel "${channel}" — stand down.\n`);
    else if (code === 1) process.stderr.write(`Heartbeat failed (HTTP ${res.status}).\n`);
    process.exit(code);
  } catch (err) {
    process.stderr.write(`Heartbeat error: ${err.message}\n`);
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) main();
