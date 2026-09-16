/**
 * Memory dreaming — the nightly consolidation pass over a cone's durable
 * memory. Where the curation pass folds ONE new session archive into the
 * file, the dreamer consolidates the file itself: merges duplicates, drops
 * superseded facts, retires stale sections, and lands under budget. It is
 * `runAgenticMemoryPass` under the SAME instruction document
 * (`/etc/MEMORY.md`, #3157) with a different `{{TASK}}` paragraph, agent name
 * and wall-clock bound (`dreamTimeoutSeconds`) — same staged base/draft
 * snapshot, same three-way merge onto the live file.
 *
 * Triggered by the gelatiere's nightly (`memory dream --all` is on its
 * allow-list) or by hand via `memory dream`; both go through the
 * `__slicc_memory` seam.
 */

import { PRIMARY_CONE_FOLDER } from '../work-unit/record.js';
import {
  type AgenticMemoryPassResult,
  type CuratorConeRef,
  curatorAgentName,
  dreamerAgentName,
  type MemoryPassInstructions,
  type RunAgenticMemoryPassOptions,
  runAgenticMemoryPass,
} from './agentic-memory.js';

// Defined beside `curatorAgentName` so each pass can name the other as its
// rival without a module cycle; re-exported here for callers and tests.
export { dreamerAgentName };

export const DREAMER_INSTRUCTIONS: MemoryPassInstructions = {
  kind: 'dream',
  nameFor: dreamerAgentName,
  // A curator over the same file (a "New chat" while the nightly dreams)
  // must not run at the same time — see `MemoryPassInstructions.rivalsFor`.
  rivalsFor: (folder) => [curatorAgentName(folder)],
};

/**
 * State key of a dream pass — the "archive basename" the shared machinery
 * keys its curation folder and receipts by (`/sessions/.curation/<key>/`).
 * There is no real archive behind it; keying by date + cone means one state
 * folder per cone per day, so a re-run the same night reuses (and re-seeds)
 * its own folder and never touches another cone's.
 */
export function dreamStateKey(today: string, folder: string): string {
  return `dream-${today}-${folder}.md`;
}

export interface RunMemoryDreamPassOptions {
  spawn: RunAgenticMemoryPassOptions['spawn'];
  vfs: RunAgenticMemoryPassOptions['vfs'];
  /** Session count the budget derives from (usually the index length). */
  sessionCount: number;
  /** Cone whose memory file the pass refactors; omitted means the primary. */
  cone?: CuratorConeRef;
  /** UTC date override for deterministic tests; defaults to today's date. */
  today?: string;
  signal?: AbortSignal;
}

export function runMemoryDreamPass(
  opts: RunMemoryDreamPassOptions
): Promise<AgenticMemoryPassResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const folder = opts.cone?.folder ?? PRIMARY_CONE_FOLDER;
  return runAgenticMemoryPass({
    spawn: opts.spawn,
    vfs: opts.vfs,
    sessionArchivePath: `/sessions/${dreamStateKey(today, folder)}`,
    sessionCount: opts.sessionCount,
    today,
    instructions: DREAMER_INSTRUCTIONS,
    ...(opts.cone ? { cone: opts.cone } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}
