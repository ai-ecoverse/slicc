#!/usr/bin/env node
// Print the next un-consumed browser->brain frame for this session+channel, or
// nothing if none arrives within --wait seconds. Reads SLICC_SESSION (to locate
// the buffer the drain writes). Always exits 0; empty stdout means "nothing yet".
// Usage: lickback-next.mjs [--wait N] [channel]
// tva
import { readFileSync, writeFileSync } from 'node:fs';
import { bufferPathsFor, isDirectRun, nextLine, parseNextArgs, requireEnv } from './_lib.mjs';

const POLL_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readCursor(path) {
  try {
    return Number.parseInt(readFileSync(path, 'utf-8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}
function readBuffer(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function tryNext(ndjson, cursorPath) {
  const { line, nextCursor } = nextLine(readBuffer(ndjson), readCursor(cursorPath));
  if (line === null) return null;
  writeFileSync(cursorPath, String(nextCursor));
  return line;
}

async function main() {
  const session = requireEnv('SLICC_SESSION');
  const { wait, channel } = parseNextArgs(process.argv.slice(2));
  const { ndjson, cursor } = bufferPathsFor(session, channel);
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const line = tryNext(ndjson, cursor);
    if (line !== null) {
      process.stdout.write(`${line}\n`);
      process.exit(0);
    }
    if (Date.now() >= deadline) process.exit(0); // timeout -> empty
    await sleep(POLL_MS);
  }
}

if (isDirectRun(import.meta.url)) main();
