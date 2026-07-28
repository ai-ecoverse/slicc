/** Shared Git revision resolution, including first-parent suffixes. */

import * as git from 'isomorphic-git';
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
  const match = /^(.+?)(?:(~[0-9]*|\^[0-9]*|@\{[0-9]+\}))*$/.exec(revision);
  if (!match) throw new Error('invalid revision');
  const base = match[1];
  const suffix = revision.slice(base.length);
  const tokens = suffix.match(/~[0-9]*|\^[0-9]*|@\{[0-9]+\}/g) ?? [];
  if (tokens.join('') !== suffix) throw new Error('invalid revision');
  const steps = tokens.map((token): RevisionStep => {
    if (token.startsWith('@{')) {
      return { kind: 'first-parent', count: Number(token.slice(2, -1)) };
    }
    const count = token.length === 1 ? 1 : Number(token.slice(1));
    return { kind: token[0] === '~' ? 'first-parent' : 'parent', count };
  });
  return { base, steps };
}

async function resolveBase(ctx: GitCommandContext, cwd: string, ref: string): Promise<string> {
  try {
    return await git.expandOid({ fs: ctx.lfs, dir: cwd, oid: ref });
  } catch {
    return await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref });
  }
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

export function matchesPathspec(filepath: string, pathspecs: readonly string[]): boolean {
  if (pathspecs.length === 0) return true;
  return pathspecs.some((raw) => {
    const spec = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    return spec === '' || filepath === spec || filepath.startsWith(`${spec}/`);
  });
}
