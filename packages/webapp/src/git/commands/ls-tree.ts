/**
 * `git ls-tree [-r] [-d] [--name-only] <tree-ish> [<path>...]`
 *
 * Read-only listing of a commit or tree. Output matches real git:
 *   <mode> SP <type> SP <oid> TAB <path>\n
 * `-r` recurses into subtrees (and omits the tree entries themselves), `-d`
 * lists only tree entries, `--name-only` emits just the path. Path arguments
 * filter entries whose full path equals or is under the pathspec; parents of a
 * pathspec are descended silently so nested targets are reachable.
 */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { tryResolveRevision } from './revision.js';
import { GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

interface TreeEntry {
  mode: string;
  path: string;
  oid: string;
  type: string;
}

export async function lsTree(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags, positionals } = parseArgs(args, GIT_FLAG_SPECS['ls-tree']);
  const recursive = flags.r === true;
  const dirsOnly = flags.d === true;
  const nameOnly = flags['name-only'] === true;
  const treeIsh = positionals[0];
  const paths = normalizePaths(positionals.slice(1));

  if (!treeIsh) {
    return {
      stdout: '',
      stderr: 'usage: git ls-tree [<options>] <tree-ish> [<path>...]\n',
      exitCode: 129,
    };
  }

  // Resolve tree-ish (branch/tag → oid, then short oid). readTree peels
  // commits to their tree internally, so a commit oid works as-is.
  const oid = await tryResolveRevision(ctx, cwd, treeIsh);
  if (oid === undefined) {
    return {
      stdout: '',
      stderr: `fatal: Not a valid object name ${treeIsh}\n`,
      exitCode: 128,
    };
  }

  let rootTree: TreeEntry[];
  try {
    const result = await git.readTree({ fs: ctx.lfs, dir: cwd, oid });
    rootTree = result.tree as TreeEntry[];
  } catch {
    return {
      stdout: '',
      stderr: `fatal: Not a valid object name ${treeIsh}\n`,
      exitCode: 128,
    };
  }

  const emitted: string[] = [];
  await walkTree(ctx, cwd, rootTree, '', paths, recursive, dirsOnly, nameOnly, emitted);

  return { stdout: emitted.join(''), stderr: '', exitCode: 0 };
}

/** Strip `./` and trailing slashes; empty entries become `''` (match-all). */
function normalizePaths(raw: string[]): string[] {
  const out: string[] = [];
  for (const p of raw) {
    let s = p;
    if (s.startsWith('./')) s = s.slice(2);
    while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    out.push(s);
  }
  return out;
}

/** Recursively walk a tree, emitting entries per ls-tree's filter rules. */
async function walkTree(
  ctx: GitCommandContext,
  cwd: string,
  tree: TreeEntry[],
  prefix: string,
  paths: string[],
  recursive: boolean,
  dirsOnly: boolean,
  nameOnly: boolean,
  emitted: string[]
): Promise<void> {
  for (const entry of tree) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path;
    const match = classifyPath(path, paths);
    if (match === 'no') continue;

    if (entry.type === 'tree') {
      const shouldEmit = match === 'exact' && (dirsOnly || !recursive);
      const shouldDescend = match === 'parent' || recursive;
      if (shouldEmit) emitted.push(formatEntry(entry, path, nameOnly));
      if (shouldDescend) {
        const { tree: subtree } = await git.readTree({
          fs: ctx.lfs,
          dir: cwd,
          oid: entry.oid,
        });
        await walkTree(
          ctx,
          cwd,
          subtree as TreeEntry[],
          path,
          paths,
          recursive,
          dirsOnly,
          nameOnly,
          emitted
        );
      }
    } else if (match !== 'parent' && !dirsOnly) {
      // blob (or submodule commit) — always emitted at its own level
      emitted.push(formatEntry(entry, path, nameOnly));
    }
  }
}

/** `exact` = path matches or is under a spec; `parent` = path is a parent of a spec. */
function classifyPath(path: string, paths: string[]): 'exact' | 'parent' | 'no' {
  if (paths.length === 0) return 'exact';
  let sawParent = false;
  for (const p of paths) {
    if (p === '' || path === p || path.startsWith(`${p}/`)) return 'exact';
    if (p.startsWith(`${path}/`)) sawParent = true;
  }
  return sawParent ? 'parent' : 'no';
}

function formatEntry(entry: TreeEntry, path: string, nameOnly: boolean): string {
  if (nameOnly) return `${path}\n`;
  const mode = entry.mode.padStart(6, '0');
  return `${mode} ${entry.type} ${entry.oid}\t${path}\n`;
}
