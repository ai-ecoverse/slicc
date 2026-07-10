/** `git symbolic-ref` — read, update, and delete symbolic refs. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

const USAGE = `usage: git symbolic-ref <name>
   or: git symbolic-ref <name> <ref>
   or: git symbolic-ref (-d | --delete) <name>`;

type RefInspection =
  | { kind: 'symbolic'; target: string }
  | { kind: 'direct' }
  | { kind: 'missing' };

function usage(): GitCommandResult {
  return { stdout: '', stderr: `${USAGE}\n`, exitCode: 129 };
}

function isValidFullRef(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.length === 5 || ref.includes('..') || ref.includes('@{')) {
    return false;
  }
  if (
    ref
      .split('/')
      .some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  ) {
    return false;
  }
  return ![...ref].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 32 || code === 127 || '~^:?*[\\'.includes(char);
  });
}

async function inspectRef(
  ctx: GitCommandContext,
  cwd: string,
  ref: string
): Promise<RefInspection> {
  try {
    const value = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref, depth: 2 });
    return value.startsWith('refs/') ? { kind: 'symbolic', target: value } : { kind: 'direct' };
  } catch {
    return { kind: 'missing' };
  }
}

async function readSymbolicTarget(
  ctx: GitCommandContext,
  cwd: string,
  name: string,
  recurse: boolean
): Promise<string | GitCommandResult> {
  const first = await inspectRef(ctx, cwd, name);
  if (first.kind !== 'symbolic') {
    return {
      stdout: '',
      stderr: `fatal: ref ${name} is not a symbolic ref\n`,
      exitCode: first.kind === 'direct' ? 1 : 128,
    };
  }
  if (!recurse) return first.target;

  const visited = new Set([name]);
  let target = first.target;
  while (true) {
    if (visited.has(target)) {
      return {
        stdout: '',
        stderr: `fatal: ref ${name} has a circular symbolic target\n`,
        exitCode: 128,
      };
    }
    visited.add(target);
    const next = await inspectRef(ctx, cwd, target);
    if (next.kind !== 'symbolic') return target;
    target = next.target;
  }
}

function shortenRef(ref: string): string {
  for (const prefix of ['refs/heads/', 'refs/tags/', 'refs/remotes/']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref.startsWith('refs/') ? ref.slice('refs/'.length) : ref;
}

function validateFlags(
  flags: Record<string, unknown>,
  deleting: boolean
): GitCommandResult | undefined {
  const knownFlags = new Set(['m', 'delete', 'd', 'quiet', 'q', 'short', 'recurse']);
  const unknownFlag = Object.keys(flags).find((flag) => !knownFlags.has(flag));
  if (unknownFlag) {
    return {
      stdout: '',
      stderr: `error: unknown option '${unknownFlag}'\n${USAGE}\n`,
      exitCode: 129,
    };
  }
  if (flags.m !== undefined) {
    return {
      stdout: '',
      stderr: "fatal: option '-m' is not supported because reflogs are not persisted\n",
      exitCode: 128,
    };
  }
  if (
    flags.delete === false ||
    (deleting && (flags.short !== undefined || flags.recurse !== undefined))
  ) {
    return usage();
  }
  return undefined;
}

async function deleteSymbolicRef(
  ctx: GitCommandContext,
  cwd: string,
  name: string,
  quiet: boolean
): Promise<GitCommandResult> {
  if (name === 'HEAD') {
    return { stdout: '', stderr: "fatal: deleting 'HEAD' is not allowed\n", exitCode: 128 };
  }
  const inspected = await inspectRef(ctx, cwd, name);
  if (inspected.kind !== 'symbolic') {
    const stderr = quiet ? '' : `fatal: Cannot delete ${name}, not a symbolic ref\n`;
    return { stdout: '', stderr, exitCode: inspected.kind === 'direct' ? 1 : 128 };
  }
  await git.deleteRef({ fs: ctx.lfs, dir: cwd, ref: name });
  return { stdout: '', stderr: '', exitCode: 0 };
}

async function writeSymbolicRef(
  ctx: GitCommandContext,
  cwd: string,
  name: string,
  target: string
): Promise<GitCommandResult> {
  if (!isValidFullRef(target)) {
    const stderr = target.startsWith('refs/')
      ? `fatal: Refusing to set '${name}' to invalid ref '${target}'\n`
      : `fatal: Refusing to point ${name} outside of refs/\n`;
    return { stdout: '', stderr, exitCode: 128 };
  }
  await git.writeRef({
    fs: ctx.lfs,
    dir: cwd,
    ref: name,
    value: target,
    force: true,
    symbolic: true,
  });
  return { stdout: '', stderr: '', exitCode: 0 };
}

async function printSymbolicRef(
  ctx: GitCommandContext,
  cwd: string,
  name: string,
  flags: Record<string, unknown>
): Promise<GitCommandResult> {
  const target = await readSymbolicTarget(ctx, cwd, name, flags.recurse !== false);
  if (typeof target !== 'string') {
    return flags.quiet && target.exitCode === 1 ? { ...target, stderr: '' } : target;
  }
  return { stdout: `${flags.short ? shortenRef(target) : target}\n`, stderr: '', exitCode: 0 };
}

export async function symbolicRef(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags, positionals } = parseArgs(args, GIT_FLAG_SPECS['symbolic-ref']);
  const deleting = flags.delete === true;
  const flagError = validateFlags(flags, deleting);
  if (flagError) return flagError;

  const readOptionsUsed =
    flags.quiet !== undefined || flags.short !== undefined || flags.recurse !== undefined;
  if (deleting) {
    if (positionals.length !== 1) return usage();
    return deleteSymbolicRef(ctx, cwd, positionals[0], Boolean(flags.quiet));
  }

  if (positionals.length === 2) {
    if (readOptionsUsed) return usage();
    return writeSymbolicRef(ctx, cwd, positionals[0], positionals[1]);
  }

  if (positionals.length !== 1) return usage();
  return printSymbolicRef(ctx, cwd, positionals[0], flags);
}
