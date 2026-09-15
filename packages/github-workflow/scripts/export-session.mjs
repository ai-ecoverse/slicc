#!/usr/bin/env node
/**
 * Export the leader's session as a transcript bundle (`session export`: a
 * redacted, SHA-256-verified ZIP — see docs/transcript-export.md) and copy
 * it to the runner.
 *
 * Inputs: SLICC_JOIN_URL, INPUT_LOCAL (runner path for the ZIP),
 * INPUT_SESSION_ID (frozen session id; default the active session),
 * INPUT_VFS_PATH (temporary VFS path), INPUT_TIMEOUT.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execOnLeader, fail, input, joinUrl, setOutput } from './gh-io.mjs';
import { buildExportSessionCommand, buildReadCommand, parseDuration } from './lib.mjs';

function main() {
  const url = joinUrl();
  const local = input('local', { required: true });
  const vfsPath = input('vfs-path', { fallback: '/tmp/slicc-session-export.zip' });
  const timeoutMs = parseDuration(input('timeout', { fallback: '10m' }));

  const exportOut = execOnLeader(url, buildExportSessionCommand(vfsPath, input('session-id')), {
    timeoutMs,
  });
  const text = exportOut.toString('utf8').trim();
  if (text) console.log(text);

  const encoded = execOnLeader(url, buildReadCommand(vfsPath), { timeoutMs });
  const bytes = Buffer.from(encoded.toString('utf8').replace(/\s+/g, ''), 'base64');
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, bytes);
  console.log(`[export-session] ${vfsPath} → ${local} (${bytes.length} bytes)`);
  setOutput('bytes', bytes.length);
  setOutput('local', local);
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
