/** `git ls-files` — list tracked / modified / deleted / other files. */

import * as git from '../cached-isomorphic-git.js';
import { NO_INDEX_REFRESH } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function lsFiles(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const modified = args.includes('--modified') || args.includes('-m');
  const others = args.includes('--others') || args.includes('-o');
  const deleted = args.includes('--deleted') || args.includes('-d');

  const pathspecs = args
    .filter((a) => !a.startsWith('-'))
    .map((p) => p.replace(/\/+$/, ''))
    .filter((p) => p.length > 0);

  const matrix = await git.statusMatrix({ fs: ctx.lfs, dir: cwd, ...NO_INDEX_REFRESH });
  const files: string[] = [];

  const mode = others ? 'others' : modified ? 'modified' : deleted ? 'deleted' : 'cached';
  for (const [file, head, workdir, stage] of matrix) {
    if (!lsFilesMatch(mode, head, workdir, stage)) continue;
    if (pathspecs.length > 0 && !matchesPathspec(file, pathspecs)) continue;
    files.push(file);
  }

  files.sort();
  const output = files.map((f) => `${f}\n`).join('');
  return { stdout: output, stderr: '', exitCode: 0 };
}

/** Prefix-match a file against any of the given pathspecs (trailing slashes already stripped). */
function matchesPathspec(file: string, pathspecs: string[]): boolean {
  for (const spec of pathspecs) {
    if (file === spec || file.startsWith(spec + '/')) return true;
  }
  return false;
}

/** Determine if a file matches the given ls-files mode. */
function lsFilesMatch(
  mode: 'others' | 'modified' | 'deleted' | 'cached',
  head: number,
  workdir: number,
  stage: number
): boolean {
  switch (mode) {
    case 'others':
      return head === 0 && stage === 0 && workdir === 2;
    case 'modified':
      return workdir !== 0 && workdir !== stage && head !== 0;
    case 'deleted':
      return workdir === 0 && (head !== 0 || stage !== 0);
    case 'cached':
      if (stage !== 0 || head !== 0) {
        if (workdir === 0 && stage === 0 && head !== 0) return false;
        if (stage !== 0) return true;
        if (head !== 0 && workdir !== 0) return true;
      }
      return false;
  }
}
