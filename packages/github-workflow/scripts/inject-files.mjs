#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ensureDir,
  execOnLeader,
  fail,
  homeDir,
  input,
  isMain,
  joinUrl,
  setOutput,
} from './gh-io.mjs';
import { buildInjectCommand, DEFAULT_INJECT_MAX_BYTES, parseDuration } from './lib.mjs';

export function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}

export function packDirectory(source, scratchDir) {
  const archive = join(ensureDir(scratchDir), `inject-${Date.now()}-${process.pid}.tgz`);
  const tar = spawnSync('tar', ['-czf', archive, '-C', source, '.'], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error(`tar failed with status ${tar.status}`);
  const bytes = readFileSync(archive);
  rmSync(archive, { force: true });
  return bytes;
}

export function main() {
  const url = joinUrl();
  const source = resolve(input('source', { required: true }));
  const target = input('target', { fallback: '/' });
  const maxBytes = Number(input('max-bytes', { fallback: String(DEFAULT_INJECT_MAX_BYTES) }));
  const timeoutMs = parseDuration(input('timeout', { fallback: '10m' }));
  if (!statSync(source).isDirectory()) throw new Error(`source is not a directory: ${source}`);

  const bytes = packDirectory(source, join(homeDir(), 'inject'));
  if (bytes.length > maxBytes) {
    throw new Error(`injection payload is ${bytes.length} bytes, above the ${maxBytes}-byte cap`);
  }
  const files = countFiles(source);
  console.log(`[inject] ${files} files (${bytes.length} bytes compressed) → ${target}`);

  execOnLeader(url, buildInjectCommand(target), { stdin: bytes.toString('base64'), timeoutMs });
  setOutput('files', files);
  setOutput('bytes', bytes.length);
  return { files, bytes: bytes.length };
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
