#!/usr/bin/env node
// Lead a tray in ONE call (#18): fire `host lead` on the cup, then poll `host`
// until the tray's join URL is live, and print it. Collapses the fire-turn +
// poll-turn the brain otherwise spends into a single script call.
//
// Worker URL: leads against the PRODUCTION hub (bare `host lead`) by default, in
// BOTH dev and prod. The tray hub is a shared production service and the join URL
// must be shareable — a localhost join URL is useless on a phone — so cup mode does
// NOT change where we lead (it only changes where the UI build loads, which cup-up
// handles). Pass a worker URL as the first arg ONLY for staging / a self-hosted /
// local tray hub.
//
// Reads CUP_BASE + SLICC_SESSION. Prints the join URL on stdout (exit 0); exits 1
// if the URL never appears.
// tva
import { cupExec, isDirectRun, leadAndPoll, positionals, requireEnv } from './_lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // Default: bare `host lead` → production hub (shareable join URL). An explicit
  // positional overrides for staging / self-hosted / local-hub testing.
  const workerArg = positionals(process.argv.slice(2))[0] || '';
  process.stderr.write(
    `cup-lead: host lead${workerArg ? ` ${workerArg}` : ' (production hub)'} — waiting for join URL…\n`
  );
  try {
    const url = await leadAndPoll({
      exec: (command) => cupExec(base, session, command),
      sleep,
      workerArg,
    });
    if (!url) {
      process.stderr.write(
        'cup-lead: no join URL appeared — is the cup leading? Try `host` manually.\n'
      );
      process.exit(1);
    }
    process.stdout.write(`${url}\n`);
  } catch (err) {
    process.stderr.write(`cup-lead error: ${err.message}\n`);
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) main();
