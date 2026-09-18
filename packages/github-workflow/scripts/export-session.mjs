#!/usr/bin/env node

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

/* v8 ignore start */
if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
/* v8 ignore stop */
