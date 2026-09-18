#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dir = process.env.FAKE_SLICC_DIR;
if (!dir) {
  console.error('FAKE_SLICC_DIR is required');
  process.exit(2);
}
const vfs = join(dir, 'vfs');
mkdirSync(vfs, { recursive: true });
const [, , url, verb, ...rest] = process.argv;
appendFileSync(join(dir, 'calls.log'), `${JSON.stringify({ url, verb, rest })}\n`);

if (url === '--version') {
  console.log('slicc v0.0.0-fake');
  process.exit(0);
}

function readText() {
  const a = rest[0] ?? '';
  if (rest.length === 1 && a.startsWith('@'))
    return readFileSync(a.slice(1), 'utf8').replace(/\n+$/, '');
  return rest.join(' ');
}

function readStdin() {
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
}

function unquote(s) {
  return s.replace(/^'(.*)'$/, '$1').replace(/'\\''/g, "'");
}

function vfsPath(p) {
  return join(vfs, p);
}

function dialFailurePending() {
  const counter = join(dir, 'dial-failures');
  let n = 0;
  try {
    n = Number(readFileSync(counter, 'utf8'));
  } catch {
    return false;
  }
  if (n <= 0) return false;
  writeFileSync(counter, String(n - 1));
  return true;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const Q = String.raw`'(?:[^']|'\\'')*'`;
const RE_READ = new RegExp(`^base64 (${Q})$`);
const RE_WRITE = new RegExp(`^mkdir -p (${Q}) && base64 -d > (${Q})$`);
const RE_INJECT = new RegExp(
  `^mkdir -p (${Q}) && base64 -d > (${Q}) && tar -xzf \\2 -C \\1 && rm -f \\2$`
);
const RE_EXPORT = new RegExp(`^session export(?: --id (${Q}))? --output (${Q})$`);

function exec(command) {
  let m;
  if ((m = command.match(RE_READ))) {
    const p = vfsPath(unquote(m[1]));
    try {
      process.stdout.write(`${readFileSync(p).toString('base64')}\n`);
    } catch {
      process.stderr.write(`base64: ${unquote(m[1])}: No such file or directory\n`);
      return 1;
    }
    return 0;
  }
  if ((m = command.match(RE_INJECT))) {
    const target = vfsPath(unquote(m[1]));
    mkdirSync(target, { recursive: true });
    const tgz = vfsPath(unquote(m[2]));
    mkdirSync(dirname(tgz), { recursive: true });
    writeFileSync(tgz, Buffer.from(readStdin().toString('utf8'), 'base64'));
    execFileSync('tar', ['-xzf', tgz, '-C', target]);
    return 0;
  }
  if ((m = command.match(RE_WRITE))) {
    const p = vfsPath(unquote(m[2]));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.from(readStdin().toString('utf8'), 'base64'));
    return 0;
  }
  if ((m = command.match(RE_EXPORT))) {
    const p = vfsPath(unquote(m[2]));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `PK-fake-zip:${m[1] ? unquote(m[1]) : 'active'}`);
    console.log(`exported ${unquote(m[2])}`);
    return 0;
  }
  if ((m = command.match(/^fail (\d+)$/))) {
    process.stderr.write('boom\n');
    return Number(m[1]);
  }
  if (command.startsWith('dial-fail')) {
    if (dialFailurePending()) {
      process.stderr.write('slicc exec: tray connect timed out after 30s\n');
      return 1;
    }
    console.log('ok after retry');
    return 0;
  }
  if ((m = command.match(/^sleep (\d+)$/))) {
    sleepSync(Number(m[1]) * 1000);
    return 0;
  }
  if (command === 'cat-stdin') {
    process.stdout.write(readStdin());
    return 0;
  }
  console.log(`ran: ${command}`);
  return 0;
}

if (verb === 'exec') {
  process.exit(exec(readText()));
}

if (verb === 'prompt') {
  const text = readText();
  if (text.includes('DIALFAIL') && dialFailurePending()) {
    process.stderr.write('slicc prompt: tray connect timed out after 30s\n');
    process.exit(1);
  }
  if (text.includes('SLOW')) {
    process.on('SIGINT', () => process.exit(130));
    setTimeout(() => process.exit(0), 30_000);
  } else {
    process.stdout.write(`reply to: ${text}`);
    process.exit(0);
  }
}

if (verb === 'follow') {
  const mode = process.env.FAKE_SLICC_FOLLOW ?? 'connected';
  if (mode === 'exit') {
    console.error('slicc follow: refused');
    process.exit(3);
  }
  if (mode !== 'silent') console.log('slicc follow: connected');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
}
