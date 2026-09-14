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
    cache: ctx.cache,
    dir: cwd,
    ...NO_INDEX_REFRESH,
  })) as StatusRow[];
  const trackedDirs = collectTrackedDirs(normalMatrix);
  const normalUntracked = normalMatrix
    .filter(([, h, w, s]) => h === 0 && w === 2 && s === 0)
    .map(([f]) => f);

  let candidates: string[];
  if (onlyIgnored || includeIgnored) {
    const withIgnored = (await git.statusMatrix({
      fs: ctx.lfs,
      cache: ctx.cache,
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

  const fileEntries = new Set<string>();
  const dirEntries = new Set<string>();
  for (const f of candidates) {
    const topUntrackedDir = topUntrackedAncestor(f, trackedDirs);
    if (topUntrackedDir === null) {
      fileEntries.add(f);
    } else if (includeDirs) {
      dirEntries.add(topUntrackedDir);
    }
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
      } catch {}
    }
  }

  return { stdout, stderr: '', exitCode: 0 };
}

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
