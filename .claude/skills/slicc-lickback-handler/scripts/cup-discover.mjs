#!/usr/bin/env node
// Resolve the running cup's base URL: read ~/.slicc/cup.json for the port
// (default 5710), confirm liveness via GET /api/status (cup===true), and print
// the base URL. Exit 0 + URL on success; 1 + a human message when no cup is up.
// tva
import { baseUrlForPort, isDirectRun, probeCup, readCupRecord, resolvePort } from './_lib.mjs';

async function main() {
  const base = baseUrlForPort(resolvePort(readCupRecord()));
  if (!(await probeCup(base))) {
    process.stderr.write(
      'No SLICC cup running. Start one with `npm run cup` (or `npm run cup-dev`).\n'
    );
    process.exit(1);
  }
  process.stdout.write(`${base}\n`);
}

if (isDirectRun(import.meta.url)) main();
