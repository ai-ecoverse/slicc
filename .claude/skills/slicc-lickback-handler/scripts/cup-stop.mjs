#!/usr/bin/env node
// Stop the cup recorded in ~/.slicc/cup.json: SIGTERM the node-server pid, wait
// out a short grace window, SIGKILL if it's still alive, then clear the discovery
// file. Use this to clean up a cup that `cup-up.mjs` LAUNCHED for you (an
// auto-launched cup outlives the session by design — it does not auto-stop). Safe
// to run when nothing is up: a missing / stale cup.json is reported and cleared.
// Reads SLICC_DIR (defaults to ~/.slicc). Always exits 0.
// tva
import { execFileSync } from 'node:child_process';
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
/** Identity gate against pid reuse (mirrors reapStaleDrains' isReapableDrain): the
 *  recorded pid must still be a cup process (`--cup` in its command line) before we
 *  signal it. If the cup exited and the OS recycled its pid onto an unrelated
 *  same-user process, this spares it. Returns false on any ps error (treat unknown
 *  as not-ours — refuse to signal). */
function isCupProcess(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    }).includes('--cup');
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
  // pid-reuse guard: if the pid is alive but is NOT a cup, the cup already exited
  // and the OS recycled its pid. Never signal that stranger — just clear the stale
  // record.
  if (isAlive(rec.pid) && !isCupProcess(rec.pid)) {
    clearDiscovery();
    process.stdout.write(
      `Cup pid ${rec.pid} is no longer the cup (pid reused by another process) — left it alone and cleared the stale cup.json (port ${rec.port}).\n`
    );
    return;
  }
  const { signaled, escalated, confirmed } = await stopByPid({
    pid: rec.pid,
    isAlive,
    kill: killPid,
    sleep,
  });
  // Only clear the discovery file once the process is actually gone — clearing it
  // while a SIGKILL-surviving cup is still up would let the next cup-up launch a
  // SECOND instance.
  if (!confirmed) {
    process.stdout.write(
      `Cup pid ${rec.pid} survived SIGKILL and is still running (port ${rec.port}) — left cup.json in place; investigate manually.\n`
    );
    return;
  }
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
