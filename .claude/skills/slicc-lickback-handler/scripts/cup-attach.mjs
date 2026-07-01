#!/usr/bin/env node
// Attach to an ALREADY-RUNNING cup — never launch one. The chat handler uses this
// (not cup-up) so it is structurally incapable of resurrecting a cup the operator
// stopped: cup lifecycle belongs to the dispatching/steering session. Reads
// ~/.slicc/cup.json for the port and polls GET /api/targets — the BRIDGE-ready probe,
// NOT the premature /api/status (which is up before the browser/CDP connects) — until
// the cup is actually drivable, then prints its base URL. Exit 0 + URL when drivable;
// 1 + guidance if no drivable cup appears within the budget. SLICC_DIR overrides
// ~/.slicc. Budget (default 90 × 1s, matching cup-up's boot allowance) is overridable
// via SLICC_ATTACH_ATTEMPTS / SLICC_ATTACH_INTERVAL_MS.
// tva
import {
  baseUrlForPort,
  isDirectRun,
  probeCupBridgeReady,
  readCupRecord,
  resolvePort,
  waitUntil,
} from './_lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ATTEMPTS = Number.parseInt(process.env.SLICC_ATTACH_ATTEMPTS ?? '', 10) || 90;
const INTERVAL_MS = Number.parseInt(process.env.SLICC_ATTACH_INTERVAL_MS ?? '', 10) || 1000;

async function main() {
  // Re-read the record each probe so a cup that (re)binds a different port than the
  // current guess is followed — mirrors ensureCupReady, but with no launch path.
  const resolveBase = () => baseUrlForPort(resolvePort(readCupRecord()));
  const ready = await waitUntil(() => probeCupBridgeReady(resolveBase()), {
    sleep,
    attempts: ATTEMPTS,
    intervalMs: INTERVAL_MS,
  });
  if (!ready) {
    process.stderr.write(
      'No drivable SLICC cup to attach to. The steering session brings the cup up ' +
        '(`npm run cup` / `cup-dev`); this handler only attaches — it never launches.\n'
    );
    process.exit(1);
  }
  process.stdout.write(`${resolveBase()}\n`);
}

if (isDirectRun(import.meta.url)) main();
