/**
 * `git merge-file` — three-way file-content merge (diff3).
 *
 * Distinct from the `merge` module (which joins histories). This incorporates
 * the changes from `<base>`→`<other>` into `<current>`, using `<base>` as the
 * common ancestor, and writes the result back to `<current>` by default.
 * Parsing + file I/O live here; the pure merge is `../merge-file-core.ts`.
 */

import { parseArgs } from '../../shell/arg-parser.js';
import { threeWayMerge } from '../merge-file-core.js';
import { GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

const USAGE = 'usage: git merge-file [<options>] <current-file> <base-file> <other-file>';

/** Coerce an mri flag value (string | string[] | undefined) to a string[]. */
function asStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

export async function mergeFile(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const parsed = parseArgs(args, GIT_FLAG_SPECS['merge-file']);
  const positionals = parsed.positionals;

  if (positionals.length !== 3) {
    return { stdout: '', stderr: `${USAGE}\n`, exitCode: 255 };
  }

  const labels = asStringArray(parsed.flags.L);
  if (labels.length > 3) {
    return {
      stdout: '',
      stderr: 'fatal: too many labels on the command line\n',
      exitCode: 255,
    };
  }

  const favorFlags = [
    parsed.flags.ours ? 'ours' : undefined,
    parsed.flags.theirs ? 'theirs' : undefined,
    parsed.flags.union ? 'union' : undefined,
  ].filter((f): f is 'ours' | 'theirs' | 'union' => f !== undefined);
  if (favorFlags.length > 1) {
    return {
      stdout: '',
      stderr: 'fatal: --ours, --theirs, and --union are mutually exclusive\n',
      exitCode: 255,
    };
  }

  const [currentPath, basePath, otherPath] = positionals;
  const resolve = (p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`);

  let current: string;
  let base: string;
  let other: string;
  try {
    current = await ctx.fs.readTextFile(resolve(currentPath));
    base = await ctx.fs.readTextFile(resolve(basePath));
    other = await ctx.fs.readTextFile(resolve(otherPath));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: `error: ${message}\n`, exitCode: 255 };
  }

  const result = threeWayMerge(current, base, other, {
    diff3: Boolean(parsed.flags.diff3),
    favor: favorFlags[0],
    labels: {
      current: labels[0] ?? currentPath,
      base: labels[1] ?? basePath,
      other: labels[2] ?? otherPath,
    },
  });

  // A favor flag (--ours/--theirs/--union) resolves every conflict, so real
  // `git merge-file` reports zero remaining conflicts: exit 0 and no warning.
  const remainingConflicts = favorFlags.length > 0 ? 0 : result.conflicts;
  const quiet = Boolean(parsed.flags.quiet);
  const stderr =
    !quiet && remainingConflicts > 0 ? `warning: merge conflict in ${currentPath}\n` : '';
  const exitCode = Math.min(remainingConflicts, 127);

  if (parsed.flags.stdout) {
    return { stdout: result.content, stderr, exitCode };
  }

  await ctx.fs.writeFile(resolve(currentPath), result.content);
  return { stdout: '', stderr, exitCode };
}
