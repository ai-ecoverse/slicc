#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { argv, env, exit, platform, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';

const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export function isExecutableFile(absPath) {
  try {
    if (!statSync(absPath).isFile()) return false;
    accessSync(absPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readEnv(source, name) {
  const entry = Object.entries(source).find(([key]) => key.toUpperCase() === name);
  return entry?.[1];
}

export function executableSuffixes(context = {}) {
  const { platform: hostPlatform = platform, env: hostEnv = env } = context;
  if (hostPlatform !== 'win32') return [''];
  const raw = readEnv(hostEnv, 'PATHEXT') || WINDOWS_DEFAULT_PATHEXT;
  const declared = raw
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));

  const suffixes = (declared.length > 0 ? declared : WINDOWS_DEFAULT_PATHEXT.split(';')).flatMap(
    (ext) => (ext === ext.toLowerCase() ? [ext] : [ext.toLowerCase(), ext])
  );
  return ['', ...new Set(suffixes)];
}

export function isExplicitPath(binary, hostPlatform) {
  return binary.includes('/') || (hostPlatform === 'win32' && binary.includes('\\'));
}

export function findOnPath(binary, context = {}) {
  if (!binary) return null;
  const { platform: hostPlatform = platform, env: hostEnv = env } = context;
  const pathEnv = context.path ?? readEnv(hostEnv, 'PATH') ?? '';
  const suffixes = extname(binary)
    ? ['']
    : executableSuffixes({ platform: hostPlatform, env: hostEnv });

  if (isExplicitPath(binary, hostPlatform)) {
    for (const suffix of suffixes) {
      if (isExecutableFile(binary + suffix)) return binary + suffix;
    }
    return null;
  }

  const pathDelimiter = hostPlatform === 'win32' ? ';' : ':';
  for (const dir of pathEnv.split(pathDelimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, binary + suffix);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export function skipMessage(binary) {
  return (
    `run-if-installed: "${binary}" is not installed — skipping.\n` +
    `  Staged files were left unformatted; CI still lints them.\n` +
    `  See docs/development.md ("Pre-commit Hooks") for the install command.\n`
  );
}

export function spawnPlan(resolved, args, hostPlatform = platform) {
  if (hostPlatform !== 'win32' || !/\.(?:bat|cmd)$/i.test(resolved)) {
    return { command: resolved, args, shell: false };
  }
  const quote = (value) => (/[\s&|<>^"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return { command: quote(resolved), args: args.map(quote), shell: true };
}

export function run(args) {
  const [binary, ...rest] = args;
  if (!binary) {
    stderr.write('usage: run-if-installed.mjs <binary> [args...]\n');
    return 2;
  }
  const resolved = findOnPath(binary);
  if (!resolved) {
    stderr.write(skipMessage(binary));
    return 0;
  }
  const plan = spawnPlan(resolved, rest);
  const result = spawnSync(plan.command, plan.args, { stdio: 'inherit', shell: plan.shell });
  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) exit(run(argv.slice(2)));
