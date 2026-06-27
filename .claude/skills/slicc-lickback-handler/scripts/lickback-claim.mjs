#!/usr/bin/env node
// Claim a lick-back channel for this session. Reads CUP_BASE + SLICC_SESSION
// from env. Exit 0 = we own it; 3 = owned by another (stand down, never retry);
// 1 = error. Usage: lickback-claim.mjs [channel]
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
    const res = await postLickback(base, '/api/lickback/claim', session, { channel });
    const code = exitForOwnership(res.status);
    if (code === 3) {
      let owner = 'another session';
      try {
        owner = (await res.json())?.owner ?? owner;
      } catch {
        /* keep default */
      }
      process.stderr.write(`Channel "${channel}" is already handled by ${owner} — standing down.\n`);
    } else if (code === 1) {
      process.stderr.write(`Claim failed (HTTP ${res.status}).\n`);
    } else {
      process.stdout.write(`owning "${channel}"\n`);
    }
    process.exit(code);
  } catch (err) {
    process.stderr.write(`Claim error: ${err.message}\n`);
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) main();
