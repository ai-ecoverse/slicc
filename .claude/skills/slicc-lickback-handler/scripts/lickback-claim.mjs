#!/usr/bin/env node
// Claim a lick-back channel for this session. Reads CUP_BASE + SLICC_SESSION
// from env. BEFORE claiming it reaps any stale drain a prior session left holding
// THIS cup's channel (the orphan that pins the claim) — port-scoped, so a parallel
// cup's live drain is untouched — then claims, retrying on 409 to ride out the
// lease tail the just-reaped drain leaves behind. Exit 0 = we own it; 3 = owned by
// a live OTHER brain past the budget (stand down); 1 = error. Usage:
// lickback-claim.mjs [channel]
// tva
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  claimWithRetry,
  DEFAULT_PORT,
  drainsDir,
  exitForOwnership,
  isDirectRun,
  pickChannel,
  postLickback,
  reapStaleDrains,
  requireEnv,
} from './_lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Default budget (31 × 2s ≈ 60s) outlasts the cup's ~45s reconnect lease, so a fresh
// claim wins once a reaped drain's tail lapses. Overridable for tests / a tuned lease.
const RETRY_MS = Number.parseInt(process.env.LICKBACK_CLAIM_RETRY_MS ?? '', 10) || 2000;
const RETRY_ATTEMPTS = Number.parseInt(process.env.LICKBACK_CLAIM_RETRY_ATTEMPTS ?? '', 10) || 31;

function portOf(base) {
  try {
    return Number(new URL(base).port) || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** Alive AND its command line is a lickback-drain — guards against pid reuse so the
 *  reaper never SIGTERMs an unrelated process that recycled a dead drain's pid. */
function isReapableDrain(pid) {
  if (!isAlive(pid)) return false;
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    }).includes('lickback-drain');
  } catch {
    return false;
  }
}
/** Reap a prior session's orphaned drain for THIS cup before claiming. */
function reapStaleDrainsForCup(port) {
  const dir = drainsDir();
  const { killed } = reapStaleDrains({
    port,
    listEntries: () => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    isReapable: isReapableDrain,
    kill: (pid) => {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    },
    remove: (name) => {
      try {
        rmSync(join(dir, name));
      } catch {
        /* best-effort */
      }
    },
  });
  if (killed.length) {
    process.stderr.write(
      `reaped ${killed.length} stale drain(s) for this cup: ${killed.join(', ')}\n`
    );
  }
}

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
  reapStaleDrainsForCup(portOf(base));
  try {
    const attemptClaim = async () => {
      const res = await postLickback(base, '/api/lickback/claim', session, { channel });
      let owner;
      if (res.status === 409) {
        try {
          owner = (await res.json())?.owner;
        } catch {
          /* keep undefined */
        }
      }
      return { status: res.status, owner };
    };
    const { status, owner } = await claimWithRetry({
      attemptClaim,
      sleep,
      attempts: RETRY_ATTEMPTS,
      intervalMs: RETRY_MS,
    });
    const code = exitForOwnership(status);
    if (code === 3) {
      process.stderr.write(
        `Channel "${channel}" is already handled by ${owner ?? 'another session'} — standing down.\n`
      );
    } else if (code === 1) {
      process.stderr.write(`Claim failed (HTTP ${status}).\n`);
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
