/**
 * `git clean` — remove untracked files (and, with `-d`, untracked directories)
 * from the working tree.
 *
 * Backed by `git.statusMatrix`, which returns `[0, 2, 0]` for untracked entries.
 * `-x`/`-X` re-run the matrix with `ignored: true` to bring .gitignore matches
 * into scope. Real git refuses to run without `-f`, `-n`, or `-i`; we mirror
 * that safety default so `git clean` alone doesn't silently delete anything.
 */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { CLEAN_SPEC, NO_INDEX_REFRESH } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

type StatusRow = [string, number, number, number];

export async function clean(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const parsed = parseArgs(args, CLEAN_SPEC);
  const dryRun = Boolean(parsed.flags['dry-run']);
  const force = Boolean(parsed.flags.force);
  const includeDirs = Boolean(parsed.flags.d);
  const includeIgnored = Boolean(parsed.flags.x);
  const onlyIgnored = Boolean(parsed.flags.X);
  const quiet = Boolean(parsed.flags.quiet);
  const pathspecs = parsed.positionals;

  // Real git: refuse to remove anything without -f, -n, or -i. `clean.requireForce`
  // defaults to true in modern git; we don't honor a config override here.
  if (!dryRun && !force) {
    return {
      stdout: '',
      stderr:
        'fatal: clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean\n',
      exitCode: 128,
    };
  }

  const normalMatrix = (await git.statusMatrix({
    fs: ctx.lfs,
    dir: cwd,
    ...NO_INDEX_REFRESH,
  })) as StatusRow[];
  const trackedDirs = collectTrackedDirs(normalMatrix);
  const normalUntracked = normalMatrix
    .filter(([, h, w, s]) => h === 0 && w === 2 && s === 0)
    .map(([f]) => f);

  // Only re-scan with ignored files when needed — the ignored walk is extra work.
  let candidates: string[];
  if (onlyIgnored || includeIgnored) {
    const withIgnored = (await git.statusMatrix({
      fs: ctx.lfs,
      dir: cwd,
      ignored: true,
      ...NO_INDEX_REFRESH,
    })) as StatusRow[];
    const allUntracked = withIgnored
      .filter(([, h, w, s]) => h === 0 && w === 2 && s === 0)
      .map(([f]) => f);
    if (onlyIgnored) {
      const normalSet = new Set(normalUntracked);
      candidates = allUntracked.filter((f) => !normalSet.has(f));
    } else {
      candidates = allUntracked;
    }
  } else {
    candidates = normalUntracked;
  }

  if (pathspecs.length > 0) {
    candidates = candidates.filter((f) => pathspecs.some((p) => matchesPathspec(f, p)));
  }

  // Split each candidate into either (a) an individual file at a tracked
  // location, or (b) its top-level untracked ancestor directory. Files under
  // untracked dirs are silently skipped unless -d was passed.
  const fileEntries = new Set<string>();
  const dirEntries = new Set<string>();
  for (const f of candidates) {
    const topUntrackedDir = topUntrackedAncestor(f, trackedDirs);
    if (topUntrackedDir === null) {
      fileEntries.add(f);
    } else if (includeDirs) {
      dirEntries.add(topUntrackedDir);
    }
    // else: skip files inside untracked dirs when -d isn't set (matches real git).
  }

  const entries = [
    ...[...fileEntries].sort().map((f) => ({ display: f, target: f, isDir: false })),
    ...[...dirEntries].sort().map((d) => ({ display: `${d}/`, target: d, isDir: true })),
  ];

  let stdout = '';
  if (!quiet) {
    const prefix = dryRun ? 'Would remove' : 'Removing';
    for (const e of entries) {
      stdout += `${prefix} ${e.display}\n`;
    }
  }

  if (!dryRun) {
    for (const e of entries) {
      const abs = `${cwd}/${e.target}`;
      try {
        await ctx.fs.rm(abs, { recursive: e.isDir });
      } catch {
        // Match real git: continue on individual failures rather than aborting.
      }
    }
  }

  return { stdout, stderr: '', exitCode: 0 };
}

/**
 * Directories (relative to cwd, no trailing slash) that contain at least one
 * tracked file (in HEAD or in the index). The empty string represents cwd
 * itself and is always tracked so it never becomes an untracked ancestor.
 */
function collectTrackedDirs(matrix: StatusRow[]): Set<string> {
  const dirs = new Set<string>(['']);
  for (const [file, head, , stage] of matrix) {
    if (head === 0 && stage === 0) continue;
    let idx = file.lastIndexOf('/');
    while (idx > 0) {
      dirs.add(file.slice(0, idx));
      idx = file.lastIndexOf('/', idx - 1);
    }
  }
  return dirs;
}

/**
 * Walk from the file's parent up toward cwd; the first ancestor that is a
 * tracked directory bounds the search. Return the child of that ancestor
 * (i.e. the top-level untracked directory that contains `file`), or `null`
 * when the file itself lives directly in a tracked directory.
 */
function topUntrackedAncestor(file: string, trackedDirs: Set<string>): string | null {
  const parts = file.split('/');
  if (parts.length === 1) return null;
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (!trackedDirs.has(prefix)) return prefix;
  }
  return null;
}

function matchesPathspec(file: string, spec: string): boolean {
  const normalized = spec.endsWith('/') ? spec.slice(0, -1) : spec;
  return file === normalized || file.startsWith(`${normalized}/`);
}
