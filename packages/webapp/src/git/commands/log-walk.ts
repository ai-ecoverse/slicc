import * as git from 'isomorphic-git';
import type { GitCommandContext } from './types.js';

export type LogEntry = Awaited<ReturnType<typeof git.log>>[number];

interface QueuedCommit {
  entry: LogEntry;

  tipRank: number;

  seq: number;
}

function precedes(a: QueuedCommit, b: QueuedCommit): boolean {
  const aTime = a.entry.commit.committer.timestamp;
  const bTime = b.entry.commit.committer.timestamp;
  if (aTime !== bTime) return aTime > bTime;
  if (a.tipRank !== b.tipRank) return a.tipRank < b.tipRank;
  return a.seq < b.seq;
}

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

export async function logAllBranches(
  ctx: GitCommandContext,
  cwd: string,
  opts: { limit: number; cache: object }
): Promise<LogEntry[]> {
  const collected: LogEntry[] = [];
  if (opts.limit <= 0) return collected;
  for await (const entry of walkAllBranches(ctx, cwd, { cache: opts.cache })) {
    collected.push(entry);

    if (collected.length >= opts.limit) break;
  }
  return collected;
}
