import type { MergeDriverCallback } from 'isomorphic-git';
import { threeWayMerge } from '../merge-file-core.js';

export interface MakeMergeDriverOptions {
  favor?: 'ours' | 'theirs' | 'union';

  diff3?: boolean;

  labels?: { current?: string; base?: string; other?: string };
}

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

    const cleanMerge = favor !== undefined || result.conflicts === 0;
    return { cleanMerge, mergedText: result.content };
  };
}
