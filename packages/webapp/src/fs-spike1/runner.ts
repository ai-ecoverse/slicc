/**
 * Spike 1 — runner.
 *
 * Sets up a ZenFS `fs` rooted at an OPFS subdirectory and runs the ops +
 * git smoke suites. Designed to work identically from a page-side context
 * (`navigator.storage.getDirectory()`) and from a DedicatedWorker (same
 * API). Each instance gets its own OPFS subdir so the page-side and
 * worker-side ZenFS handle caches can't collide.
 *
 * THIS IS THROWAWAY CODE.
 */

import { configure, fs as zenfs } from '@zenfs/core';
import { WebAccess } from '@zenfs/dom';
import { runGitSmoke } from './git-smoke.js';
import type { FsPromisesLike, OpResult } from './ops.js';
import { runOpsSuite } from './ops.js';

export interface SuiteResult {
  context: 'page' | 'worker';
  backend: string;
  setupMs: number;
  ops: OpResult[];
  git: OpResult[];
  fatal?: string;
}

/** Resolve an OPFS subdirectory handle, creating it if missing. */
async function getOpfsSubdir(name: string): Promise<FileSystemDirectoryHandle> {
  // Works in both window and DedicatedWorker scopes.
  const root = await (navigator.storage as StorageManager).getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

/**
 * Run the full Spike 1 suite (ops + git) in the current context.
 *
 * Caller picks the OPFS subdir name so page and worker contexts don't
 * collide (ZenFS keeps a per-instance metadata cache and they shouldn't
 * share OPFS state mid-run).
 */
export async function runSpike(opts: {
  context: 'page' | 'worker';
  opfsSubdir: string;
  cloneUrl?: string;
  corsProxy?: string;
}): Promise<SuiteResult> {
  const t0 = performance.now();
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await getOpfsSubdir(opts.opfsSubdir);
  } catch (err) {
    return {
      context: opts.context,
      backend: 'zenfs+WebAccess(OPFS)',
      setupMs: 0,
      ops: [],
      git: [],
      fatal: `OPFS unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    await configure({
      mounts: { '/': { backend: WebAccess, handle } },
    });
  } catch (err) {
    return {
      context: opts.context,
      backend: 'zenfs+WebAccess(OPFS)',
      setupMs: Math.round(performance.now() - t0),
      ops: [],
      git: [],
      fatal: `zenfs configure failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const setupMs = Math.round(performance.now() - t0);
  const fsClient = zenfs.promises as unknown as FsPromisesLike;

  const ops = await runOpsSuite(fsClient, '/spike');

  // Fresh dirs for git so the ops suite's `/spike/a/b/c` state doesn't leak.
  const gitDir = '/git-repo';
  const cloneDir = '/git-clone';
  try {
    if (fsClient.rm) await fsClient.rm(gitDir, { recursive: true, force: true });
  } catch {}
  try {
    if (fsClient.rm) await fsClient.rm(cloneDir, { recursive: true, force: true });
  } catch {}
  await fsClient.mkdir(gitDir, { recursive: true });

  const git = await runGitSmoke(
    { promises: fsClient as never },
    {
      dir: gitDir,
      cloneUrl: opts.cloneUrl,
      corsProxy: opts.corsProxy,
      cloneDir: opts.cloneUrl ? cloneDir : undefined,
    }
  );

  return { context: opts.context, backend: 'zenfs+WebAccess(OPFS)', setupMs, ops, git };
}
