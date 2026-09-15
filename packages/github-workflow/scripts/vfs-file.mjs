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
import { execOnLeader, fail, input, joinUrl, setOutput } from './gh-io.mjs';
import { buildReadCommand, buildWriteCommand, parseDuration } from './lib.mjs';

function main() {
  const url = joinUrl();
  const mode = input('mode', { required: true });
  const path = input('path', { required: true });
  const timeoutMs = parseDuration(input('timeout', { fallback: '10m' }));

  if (mode === 'read') {
    const local = input('local', { required: true });
    const stdout = execOnLeader(url, buildReadCommand(path), { timeoutMs });
    const bytes = Buffer.from(stdout.toString('utf8').replace(/\s+/g, ''), 'base64');
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, bytes);
    console.log(`[vfs read] ${path} → ${local} (${bytes.length} bytes)`);
    setOutput('bytes', bytes.length);
    setOutput('local', local);
    return;
  }
  if (mode === 'write') {
    const content = input('content', { raw: true });
    const local = input('local');
    if (!content && !local) throw new Error('write mode needs `local` or `content`');
    const bytes = local ? readFileSync(local) : Buffer.from(content, 'utf8');
    execOnLeader(url, buildWriteCommand(path), { stdin: bytes.toString('base64'), timeoutMs });
    console.log(`[vfs write] ${local || '(inline content)'} → ${path} (${bytes.length} bytes)`);
    setOutput('bytes', bytes.length);
    return;
  }
  throw new Error(`mode must be read|write, got "${mode}"`);
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
