#!/usr/bin/env node
// Stream a reply back to the cup's chat panel:
//   echo "answer" | lickback-reply.mjs <msgId> [channel]
// Reads CUP_BASE + SLICC_SESSION. Sends one delta (the whole answer) then a
// done:true frame, so the panel's working spinner is ALWAYS released. Exit 0 ok; 1 error.
// tva
import {
  buildReplyFrames,
  DEFAULT_CHANNEL,
  isDirectRun,
  positionals,
  postLickback,
  requireEnv,
} from './_lib.mjs';

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
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
  const pos = positionals(process.argv.slice(2));
  const replyTo = pos[0];
  if (!replyTo) {
    process.stderr.write('Usage: lickback-reply.mjs <msgId> [channel] (reply text on stdin)\n');
    process.exit(1);
  }
  const channel = pos[1] || DEFAULT_CHANNEL;
  const text = (await readStdin()).replace(/\n$/, '');
  try {
    for (const frame of buildReplyFrames(replyTo, channel, text)) {
      const res = await postLickback(base, '/api/lickback/reply', session, frame);
      if (!res.ok) {
        process.stderr.write(`Reply failed (HTTP ${res.status}).\n`);
        process.exit(1);
      }
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Reply error: ${err.message}\n`);
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) main();
