/** Shared Git revision resolution, including first-parent suffixes. */

import * as git from '../cached-isomorphic-git.js';
import type { GitCommandContext } from './types.js';

type RevisionStep = { kind: 'first-parent' | 'parent'; count: number };

export async function resolveRevision(
  ctx: GitCommandContext,
  cwd: string,
  revision: string
): Promise<string> {
  const parsed = parseRevision(revision);
  let oid = await resolveBase(ctx, cwd, parsed.base);
  for (const step of parsed.steps) {
    if (step.kind === 'first-parent') {
      for (let i = 0; i < step.count; i++) oid = await readParent(ctx, cwd, oid, 1);
    } else {
      oid = await readParent(ctx, cwd, oid, step.count);
    }
  }
  return oid;
}

function parseRevision(revision: string): { base: string; steps: RevisionStep[] } {
  if (revision.includes('@{')) throw new Error('reflog selectors are unsupported');
  const match = /^(.+?)(?:(~[0-9]*|\^[0-9]*))*$/.exec(revision);
  if (!match) throw new Error('invalid revision');
  const base = match[1];
  const suffix = revision.slice(base.length);
  const tokens = suffix.match(/~[0-9]*|\^[0-9]*/g) ?? [];
  if (tokens.join('') !== suffix) throw new Error('invalid revision');
  const steps = tokens.map((token): RevisionStep => {
    const count = token.length === 1 ? 1 : Number(token.slice(1));
    return { kind: token[0] === '~' ? 'first-parent' : 'parent', count };
  });
  return { base, steps };
}

/**
 * Resolve `revision` like {@link resolveRevision}, but report an unresolvable
 * token as `undefined` so callers can emit their own `fatal:` wording.
 */
export async function tryResolveRevision(
  ctx: GitCommandContext,
  cwd: string,
  revision: string
): Promise<string | undefined> {
  try {
    return await resolveRevision(ctx, cwd, revision);
  } catch {
    return undefined;
  }
}

/** An abbreviated or full object id — git accepts 4 to 40 hex characters. */
const ABBREVIATED_OID = /^[0-9a-f]{4,40}$/i;

/**
 * Refs win over hex prefixes, which is git's own precedence, and `expandOid` —
 * which reads every `.git/objects/pack/*.idx` looking for a prefix match — is
 * only attempted for tokens that could be an abbreviated oid. Resolving `HEAD`
 * over a mounted host repo used to read all 30 pack indexes (3.8 MB, 34
 * requests); it now reads `HEAD` and `packed-refs` (#2713).
 */
async function resolveBase(ctx: GitCommandContext, cwd: string, ref: string): Promise<string> {
  try {
    return await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref });
  } catch (error) {
    if (!ABBREVIATED_OID.test(ref)) throw error;
  }
  return await git.expandOid({ fs: ctx.lfs, dir: cwd, oid: ref });
}

async function readParent(
  ctx: GitCommandContext,
  cwd: string,
  oid: string,
  parentNumber: number
): Promise<string> {
  if (parentNumber < 1) return oid;
  const { commit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid });
  const parent = commit.parent[parentNumber - 1];
  if (!parent) throw new Error('missing parent');
  return parent;
}

/** `./foo/` and `foo` are the same pathspec. */
function normalizePathspec(raw: string): string {
  return raw.replace(/^\.\//, '').replace(/\/+$/, '');
}

export function matchesPathspec(filepath: string, pathspecs: readonly string[]): boolean {
  if (pathspecs.length === 0) return true;
  return pathspecs.some((raw) => {
    const spec = normalizePathspec(raw);
    return spec === '' || filepath === spec || filepath.startsWith(`${spec}/`);
  });
}

/**
 * True when `filepath` matches a pathspec **or is a directory that could still
 * contain one** — i.e. whether a tree walk has any reason to descend into it.
 *
 * `matchesPathspec('src', ['src/a.txt'])` is false (a walk must not *report*
 * `src`), but the walk still has to enter `src` to reach `src/a.txt`. Callers
 * that prune subtrees need this weaker test, applied to the path string alone
 * so no `lstat`/`readdir` is spent on a subtree that is about to be dropped.
 */
export function pathspecCouldMatch(filepath: string, pathspecs: readonly string[]): boolean {
  if (pathspecs.length === 0) return true;
  return pathspecs.some((raw) => {
    const spec = normalizePathspec(raw);
    if (spec === '' || filepath === spec) return true;
    // Below the spec (`src/a.txt` under `src`), or an ancestor of it (`src`
    // on the way to `src/a.txt`).
    return filepath.startsWith(`${spec}/`) || spec.startsWith(`${filepath}/`);
  });
}
