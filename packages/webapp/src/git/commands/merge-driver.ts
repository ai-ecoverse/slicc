/**
 * Shared isomorphic-git merge driver, backed by the pure `threeWayMerge`.
 *
 * isomorphic-git calls a `MergeDriverCallback` for every file both sides
 * touched. The contract passes `contents[0]=base, [1]=ours, [2]=theirs` and
 * `branches[1]=ours, [2]=theirs`. We forward those to `threeWayMerge` and report
 * `cleanMerge=false` (conflict markers written, file staged as conflicted) unless
 * a `favor` option resolved every hunk. Consumed by `merge` (and future
 * `cherry-pick`/`rebase`) so history-joining commands share one conflict engine.
 */

import type { MergeDriverCallback } from 'isomorphic-git';
import { threeWayMerge } from '../merge-file-core.js';

export interface MakeMergeDriverOptions {
  /** Resolve every conflict toward one side (or union) instead of emitting markers. */
  favor?: 'ours' | 'theirs' | 'union';
  /** Include the `|||||||` base section in conflict markers. */
  diff3?: boolean;
  /** Override the marker labels; defaults come from the per-file branch names. */
  labels?: { current?: string; base?: string; other?: string };
}

/**
 * Build a `MergeDriverCallback`. A `favor` option makes every merge clean (no
 * markers, no conflicted index entry); otherwise a divergent overlap yields
 * `cleanMerge:false` with conflict markers in the merged text.
 */
export function makeMergeDriver(opts: MakeMergeDriverOptions = {}): MergeDriverCallback {
  const { favor, diff3, labels } = opts;
  return ({ contents, branches }) => {
    const [base, ours, theirs] = contents;
    const result = threeWayMerge(ours ?? '', base ?? '', theirs ?? '', {
      favor,
      diff3,
      labels: {
        current: labels?.current ?? branches[1] ?? 'ours',
        base: labels?.base ?? branches[0] ?? 'base',
        other: labels?.other ?? branches[2] ?? 'theirs',
      },
    });
    // A favor flag resolves every hunk, so the file is clean even though
    // `threeWayMerge` still counts the divergent regions it collapsed.
    const cleanMerge = favor !== undefined || result.conflicts === 0;
    return { cleanMerge, mergedText: result.content };
  };
}
