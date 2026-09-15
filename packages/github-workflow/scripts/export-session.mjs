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
import { execOnLeader, fail, input, isMain, joinUrl, setOutput } from './gh-io.mjs';
import { buildExportSessionCommand, parseDuration } from './lib.mjs';
import { readVfsFile } from './vfs-file.mjs';

export function main() {
  const url = joinUrl();
  const local = input('local', { required: true });
  const vfsPath = input('vfs-path', { fallback: '/tmp/slicc-session-export.zip' });
  const timeoutMs = parseDuration(input('timeout', { fallback: '10m' }));

  const exportOut = execOnLeader(url, buildExportSessionCommand(vfsPath, input('session-id')), {
    timeoutMs,
  });
  const text = exportOut.toString('utf8').trim();
  if (text) console.log(text);

  const bytes = readVfsFile(url, vfsPath, local, timeoutMs);
  console.log(`[export-session] ${vfsPath} → ${local} (${bytes} bytes)`);
  setOutput('bytes', bytes);
  setOutput('local', local);
  return bytes;
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
