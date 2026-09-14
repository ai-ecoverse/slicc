#!/usr/bin/env node
import { resolve } from 'node:path';
import { argv, cwd, exit, stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { checkTree } from './lib.mjs';

export function parseArgs(args) {
  let root = cwd();
  let requireMarker = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root') {
      root = resolve(args[++i] ?? cwd());
      continue;
    }
    if (arg === '--force') {
      requireMarker = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true, root, requireMarker };
  }
  return { help: false, root, requireMarker };
}

export function formatReport(result) {
  if (result.inactive) {
    return 'ok: no-comment lint inactive (no .no-comment marker)\n';
  }
  const lines = [];
  for (const rel of result.forbidden) {
    lines.push(`${rel}: documentation file is not allowed on the no-comment tree`);
  }
  for (const hit of result.hits) {
    lines.push(`${hit.file}:${hit.line}: comment not allowed: ${hit.text}`);
  }
  if (lines.length === 0) {
    return 'ok: no comments or documentation files on the no-comment tree\n';
  }
  return `${lines.join('\n')}\n`;
}

function main(args = argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.help) {
    stdout.write('Usage: node packages/dev-tools/no-comment/check.mjs [--root <dir>] [--force]\n');
    return 0;
  }
  const result = checkTree(opts.root, { requireMarker: opts.requireMarker });
  const report = formatReport(result);
  if (result.inactive) {
    stdout.write(report);
    return 0;
  }
  const failed = result.hits.length + result.forbidden.length;
  if (failed === 0) {
    stdout.write(report);
    return 0;
  }
  stderr.write(report);
  return 1;
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  exit(main());
}

export { main };
