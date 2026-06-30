#!/usr/bin/env node
// Stop the cup recorded in ~/.slicc/cup.json: SIGTERM the node-server pid, wait
// out a short grace window, SIGKILL if it's still alive, then clear the discovery
// file. Use this to clean up a cup that `cup-up.mjs` LAUNCHED for you (an
// auto-launched cup outlives the session by design — it does not auto-stop). Safe
// to run when nothing is up: a missing / stale cup.json is reported and cleared.
// Reads SLICC_DIR (defaults to ~/.slicc). Always exits 0.
// tva
import { rmSync } from 'node:fs';
import { cupDiscoveryPath, isDirectRun, readCupRecord, stopByPid } from './_lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone / not ours */
  }
}
function clearDiscovery() {
  try {
    rmSync(cupDiscoveryPath());
  } catch {
    /* best-effort */
  }
}

async function main() {
  const rec = readCupRecord();
  if (!rec) {
    process.stdout.write('No cup running (no ~/.slicc/cup.json).\n');
    return;
  }
  const { signaled, escalated } = await stopByPid({ pid: rec.pid, isAlive, kill: killPid, sleep });
  clearDiscovery();
  if (!signaled) {
    process.stdout.write(
      `Cup pid ${rec.pid} was not running — cleared the stale cup.json (port ${rec.port}).\n`
    );
  } else {
    process.stdout.write(
      `Stopped the cup on port ${rec.port} (pid ${rec.pid})${escalated ? ' [SIGKILL]' : ''}.\n`
    );
  }
}

if (isDirectRun(import.meta.url)) main();
