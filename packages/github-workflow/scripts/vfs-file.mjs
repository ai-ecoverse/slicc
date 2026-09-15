#!/usr/bin/env node
/**
 * Copy one file between the runner and the leader's VFS, byte-exact, over
 * `slicc … exec`. Both directions go through base64: the exec channel
 * carries stdin as bytes but streams stdout as text, so a raw `cat` of a
 * binary would not survive the trip. The leader's shell (just-bash) ships
 * `base64`, `mkdir -p`, and `tar`.
 *
 * Inputs: SLICC_JOIN_URL, INPUT_MODE (`read` | `write`), INPUT_PATH (VFS),
 * INPUT_LOCAL (runner path), INPUT_CONTENT (write mode: inline text instead
 * of a local file), INPUT_TIMEOUT.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execOnLeader, fail, input, isMain, joinUrl, setOutput } from './gh-io.mjs';
import { buildReadCommand, buildWriteCommand, parseDuration } from './lib.mjs';

export function readVfsFile(url, path, local, timeoutMs) {
  const stdout = execOnLeader(url, buildReadCommand(path), { timeoutMs });
  const bytes = Buffer.from(stdout.toString('utf8').replace(/\s+/g, ''), 'base64');
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, bytes);
  return bytes.length;
}

export function writeVfsFile(url, path, bytes, timeoutMs) {
  execOnLeader(url, buildWriteCommand(path), { stdin: bytes.toString('base64'), timeoutMs });
  return bytes.length;
}

export function main() {
  const url = joinUrl();
  const mode = input('mode', { required: true });
  const path = input('path', { required: true });
  const timeoutMs = parseDuration(input('timeout', { fallback: '10m' }));

  if (mode === 'read') {
    const local = input('local', { required: true });
    const bytes = readVfsFile(url, path, local, timeoutMs);
    console.log(`[vfs read] ${path} → ${local} (${bytes} bytes)`);
    setOutput('bytes', bytes);
    setOutput('local', local);
    return bytes;
  }
  if (mode === 'write') {
    const content = input('content', { raw: true });
    const local = input('local');
    if (!content && !local) throw new Error('write mode needs `local` or `content`');
    const bytes = local ? readFileSync(local) : Buffer.from(content, 'utf8');
    writeVfsFile(url, path, bytes, timeoutMs);
    console.log(`[vfs write] ${local || '(inline content)'} → ${path} (${bytes.length} bytes)`);
    setOutput('bytes', bytes.length);
    return bytes.length;
  }
  throw new Error(`mode must be read|write, got "${mode}"`);
}

// The direct-run trampoline: unreachable in-process (tests import `main`), so
// it is excluded from coverage rather than faked through a subprocess.
/* v8 ignore start */
if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
/* v8 ignore stop */
