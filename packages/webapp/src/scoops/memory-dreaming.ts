/**
 * Memory dreaming — the nightly refactoring pass over a cone's durable
 * memory. Where the memory curator folds ONE new session archive into the
 * file, the dreamer consolidates the file itself: merges duplicates, drops
 * superseded facts, retires stale sections, and lands under budget. It is
 * `runAgenticMemoryPass` with a different instruction document
 * (`/shared/DREAMING.md`) and agent name — same staged base/draft snapshot,
 * same three-way merge onto the live file, same wall-clock bound.
 *
 * Triggered by the gelatiere's nightly (`memory dream --all` is on its
 * allow-list) or by hand via `memory dream`; both go through the
 * `__slicc_memory` seam.
 */

import DEFAULT_DREAMING_MD from '../../../vfs-root/shared/DREAMING.md?raw';
import { PRIMARY_CONE_FOLDER } from '../work-unit/record.js';
import {
  type AgenticMemoryPassResult,
  type CuratorConeRef,
  type MemoryPassInstructions,
  type RunAgenticMemoryPassOptions,
  runAgenticMemoryPass,
} from './agentic-memory.js';

export { DEFAULT_DREAMING_MD };

export const DREAMING_INSTRUCTIONS_PATH = '/shared/DREAMING.md';

/**
 * Agent name of the dreamer for `folder` — per cone for the same reason as
 * `curatorAgentName`: two dreams over the SAME memory file must collide on
 * the fixed name; different cones' dreams must not block each other.
 */
export function dreamerAgentName(folder: string): string {
  return folder === PRIMARY_CONE_FOLDER ? 'memory-dreamer' : `memory-dreamer-${folder}`;
}

export const DREAMER_INSTRUCTIONS: MemoryPassInstructions = {
  path: DREAMING_INSTRUCTIONS_PATH,
  fallback: DEFAULT_DREAMING_MD,
  nameFor: dreamerAgentName,
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
