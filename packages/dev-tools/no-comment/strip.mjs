#!/usr/bin/env node
import { resolve } from 'node:path';
import { argv, cwd, exit, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { applyStrip } from './lib.mjs';

export function parseArgs(args) {
  let root = cwd();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root') {
      root = resolve(args[++i] ?? cwd());
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true, root };
  }
  return { help: false, root };
}

function main(args = argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.help) {
    stdout.write('Usage: node packages/dev-tools/no-comment/strip.mjs [--root <dir>]\n');
    return 0;
  }
  const stats = applyStrip(opts.root);
  stdout.write(
    `no-comment: stripped ${stats.stripped}, deleted ${stats.deleted}, ` +
      `unchanged ${stats.unchanged}, skipped ${stats.skipped}\n`
  );
  return 0;
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  exit(main());
}

export { main };
