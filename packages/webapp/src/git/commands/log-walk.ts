/**
 * Newest-first commit traversal across every local branch tip (issue #2712).
 *
 * `git log --all` used to call `git.log({ ref: branch, depth: 50 })` once per
 * branch, concatenate the results, sort them by date and only then apply `-n`.
 * On the slicc repo (29 local branches) that is 29 independent walks, each
 * with its own implicit isomorphic-git `cache`, so all 30 pack indexes were
 * parsed — and the 92 MB packfile re-verified — once per branch:
 * `log --oneline --all -n 20` took 157 s and 72,767 hostfs requests.
 *
 * This is one walk instead: seed a date-ordered priority queue with every
 * branch tip, pop the newest commit, emit it, push its parents. Each commit
 * object is read at most once, the walk stops the moment `limit` commits have
 * been emitted (so `-n 20` never reads a 21st generation), and the caller's
 * `cache` — `ctx.cache`, the instance-wide object/pack cache (#2710) — is
 * threaded through every read, so those pack indexes are parsed once per
 * SHELL rather than once per branch.
 */

import * as git from 'isomorphic-git';
import type { GitCommandContext } from './types.js';

/** One entry of a `git.log` result: `{ oid, commit, payload }`. */
export type LogEntry = Awaited<ReturnType<typeof git.log>>[number];

interface QueuedCommit {
  entry: LogEntry;
  /** Index of the branch this commit was first reached from. */
  tipRank: number;
  /** Push order, for a fully deterministic final tie-break. */
  seq: number;
}

/**
 * True when `a` must come out of the queue before `b`.
 *
 * Newest committer date first — the same key isomorphic-git's own single-ref
 * walk orders by (`compareAge`), so `--all` on a one-branch repo produces the
 * same order as plain `git log` on it. (The old implementation sorted by
 * AUTHOR date, which disagrees for anything rebased or cherry-picked.)
 *
 * Git timestamps have one-second resolution, so ties are routine — a scripted
 * sequence of commits usually shares one. Ancestry still orders itself
 * (a parent is only pushed once its child has been emitted); what is left is
 * commits on different branches, which fall back to branch enumeration order
 * and then push order. That reproduces the ordering the per-branch
 * implementation got from `listBranches()` order plus a stable sort.
 */
function precedes(a: QueuedCommit, b: QueuedCommit): boolean {
  const aTime = a.entry.commit.committer.timestamp;
  const bTime = b.entry.commit.committer.timestamp;
  if (aTime !== bTime) return aTime > bTime;
  if (a.tipRank !== b.tipRank) return a.tipRank < b.tipRank;
  return a.seq < b.seq;
}

/** Binary heap keeping the {@link precedes}-first commit at the root. */
class CommitQueue {
  private readonly heap: QueuedCommit[] = [];
  private pushed = 0;

  push(entry: LogEntry, tipRank: number): void {
    this.heap.push({ entry, tipRank, seq: this.pushed++ });
    let index = this.heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!precedes(this.heap[index], this.heap[parent])) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  pop(): QueuedCommit | undefined {
    const top = this.heap[0];
    if (top === undefined) return undefined;
    const last = this.heap.pop();
    if (last !== undefined && this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown();
    }
    return top;
  }

  private siftDown(): void {
    for (let index = 0; ; ) {
      const left = index * 2 + 1;
      let best = index;
      if (left < this.heap.length && precedes(this.heap[left], this.heap[best])) best = left;
      if (left + 1 < this.heap.length && precedes(this.heap[left + 1], this.heap[best])) {
        best = left + 1;
      }
      if (best === index) return;
      this.swap(index, best);
      index = best;
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a];
    this.heap[a] = this.heap[b];
    this.heap[b] = tmp;
  }
}

/** Resolve a ref to an oid, or undefined when it cannot be read. */
async function resolveTip(
  ctx: GitCommandContext,
  cwd: string,
  ref: string
): Promise<string | undefined> {
  try {
    return await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref });
  } catch {
    return undefined;
  }
}

/**
 * Read one commit object, or undefined when it is unreadable — a shallow
 * boundary, or a ref pointing at a non-commit. The per-branch implementation
 * dropped a whole branch on any error; dropping the single unreadable commit
 * keeps the rest of the walk.
 */
async function readCommitEntry(
  ctx: GitCommandContext,
  cwd: string,
  oid: string,
  cache: object
): Promise<LogEntry | undefined> {
  try {
    return await git.readCommit({ fs: ctx.lfs, dir: cwd, oid, cache });
  } catch {
    return undefined;
  }
}

/** Push every distinct local branch tip onto the queue, in enumeration order. */
async function seedBranchTips(
  ctx: GitCommandContext,
  cwd: string,
  queue: CommitQueue,
  seen: Set<string>,
  cache: object
): Promise<void> {
  const branches = await git.listBranches({ fs: ctx.lfs, dir: cwd });
  for (const [rank, branch] of branches.entries()) {
    const oid = await resolveTip(ctx, cwd, branch);
    if (oid === undefined || seen.has(oid)) continue;
    seen.add(oid);
    const entry = await readCommitEntry(ctx, cwd, oid, cache);
    if (entry) queue.push(entry, rank);
  }
}

/**
 * Yield every commit reachable from any local branch, newest first and
 * deduplicated by oid.
 *
 * LAZY on purpose: a consumer that needs "the newest N commits that touch a
 * pathspec" cannot know in advance how deep it has to go, and capping the
 * traversal for it would silently drop matches that a busy branch pushed past
 * the cap. Because parents are expanded only AFTER their commit has been
 * yielded, a consumer that stops pulling (`break`, or a `-n` that is
 * satisfied) never pays for the next generation of commit reads.
 */
export async function* walkAllBranches(
  ctx: GitCommandContext,
  cwd: string,
  opts: { cache: object }
): AsyncGenerator<LogEntry> {
  const seen = new Set<string>();
  const queue = new CommitQueue();
  await seedBranchTips(ctx, cwd, queue, seen, opts.cache);

  for (;;) {
    const item = queue.pop();
    if (item === undefined) return;
    yield item.entry;
    for (const parent of item.entry.commit.parent) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      const entry = await readCommitEntry(ctx, cwd, parent, opts.cache);
      if (entry) queue.push(entry, item.tipRank);
    }
  }
}

/**
 * Collect at most `limit` commits reachable from any local branch, newest
 * first and deduplicated by oid.
 */
export async function logAllBranches(
  ctx: GitCommandContext,
  cwd: string,
  opts: { limit: number; cache: object }
): Promise<LogEntry[]> {
  const collected: LogEntry[] = [];
  if (opts.limit <= 0) return collected;
  for await (const entry of walkAllBranches(ctx, cwd, { cache: opts.cache })) {
    collected.push(entry);
    // `break` closes the generator at its `yield`, so the last commit's
    // parents are never read.
    if (collected.length >= opts.limit) break;
  }
  return collected;
}
