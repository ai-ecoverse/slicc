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

const ABBREVIATED_OID = /^[0-9a-f]{4,40}$/i;

async function resolveBase(ctx: GitCommandContext, cwd: string, ref: string): Promise<string> {
  if (ref === 'FETCH_HEAD') return await resolveFetchHead(ctx, cwd);
  try {
    return await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref });
  } catch (error) {
    if (!ABBREVIATED_OID.test(ref)) throw error;
  }
  return await git.expandOid({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, oid: ref });
}

async function resolveFetchHead(ctx: GitCommandContext, cwd: string): Promise<string> {
  const root = await git.findRoot({ fs: ctx.lfs, filepath: cwd });
  let text: string;
  try {
    const raw = await ctx.lfs.readFile(`${root}/.git/FETCH_HEAD`, { encoding: 'utf8' });
    text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    throw new Error('Could not find FETCH_HEAD.');
  }
  const line = text.split('\n').find((entry) => entry.trim().length > 0);
  const oid = line?.split(/[\t ]/)[0];
  if (!oid || !ABBREVIATED_OID.test(oid) || oid.length !== 40) {
    throw new Error('Could not find FETCH_HEAD.');
  }
  return oid.toLowerCase();
}

async function readParent(
  ctx: GitCommandContext,
  cwd: string,
  oid: string,
  parentNumber: number
): Promise<string> {
  if (parentNumber < 1) return oid;
  const { commit } = await git.readCommit({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, oid });
  const parent = commit.parent[parentNumber - 1];
  if (!parent) throw new Error('missing parent');
  return parent;
}

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

export function pathspecCouldMatch(filepath: string, pathspecs: readonly string[]): boolean {
  if (pathspecs.length === 0) return true;
  return pathspecs.some((raw) => {
    const spec = normalizePathspec(raw);
    if (spec === '' || filepath === spec) return true;

    return filepath.startsWith(`${spec}/`) || spec.startsWith(`${filepath}/`);
  });
}
